/**
 * Build provenance for the corpus: *which* code produced these artefacts.
 *
 * ### Why this file exists
 *
 * `fetch_scores.mjs` pins every score to a commit SHA and a per-file sha256, so the *input*
 * side of the corpus is reproducible by construction. The output side was not: the MSMs, the
 * JSONLs and the summary recorded only `"renderer": "espressivo"`. That names a program, not a
 * build — and espressivo is a working tree whose `dist/` is not in git and moved between the
 * corpus being built and the corpus being reviewed (`8003ff9 feat(mei): layersToStaffs`
 * landed 2026-08-10 22:17, an hour after `msm/` was written). Nothing on disk said which side
 * of that commit the corpus was on. A corpus that cannot name its renderer build is not
 * reproducible even when every input is pinned.
 *
 * ### What is recorded, and what each part is worth
 *
 * * `commit` / `dirty` for the two renderer working trees and for this repository. The commit
 *   is the claim; `dirty` is the retraction of that claim when the tree has uncommitted edits,
 *   because "commit X" is false the moment a file is modified on top of X.
 * * `dist_sha256` for espressivo — a hash over the **built** tree (`dist/`), not over the
 *   source. `ml/node/paths.mjs` imports `dist/api/index.js`, and `dist/` is a build artefact
 *   that git does not track: two checkouts at the same commit can carry different `dist/`
 *   trees, and a stale `dist/` is exactly the failure this pin has to catch. The hash covers
 *   every file, in sorted path order, so a rebuild that changes one byte changes it.
 * * `verovio` is not read here — it is `mei/convert.json`'s `verovio_version`, written by the
 *   step that actually used it, and is folded in by the callers that have that file.
 *
 * The compact `buildTag()` string is what goes into every JSONL record, so a single line of
 * the corpus is self-describing without its sidecar; `corpusProvenance()` is the full object,
 * written next to each artefact.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESPRESSIVO, MEICO } from '../node/paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `git` in one working tree, or `null` when the directory is not one. Never throws. */
function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * `{path, commit, dirty, committed}` for a working tree, optionally narrowed to a `pathspec`.
 *
 * `dirty` counts the porcelain lines rather than reporting a boolean, because "3 files
 * modified" and "one untracked note file" are different facts and the number is the cheapest
 * way to keep them apart in a record nobody will re-derive.
 *
 * `pathspec` matters for this repository specifically: several agent teams commit to the same
 * `main`, so `HEAD` and a whole-tree dirty count describe *the repository*, not the subsystem
 * that produced the artefact. Narrowing to `ml/corpus` makes the pin say what it means — this
 * corpus was built by this state of the corpus code — instead of flickering with every commit
 * another team makes.
 */
export function gitInfo(dir, pathspec = null) {
  const commit = git(dir, ['rev-parse', 'HEAD']);
  if (commit === null) return { path: dir, commit: null, dirty: null };
  const scope = pathspec ? ['--', pathspec] : [];
  const subject = git(dir, ['log', '-1', '--format=%H%n%cI', ...scope])?.split('\n') ?? [];
  const porcelain = git(dir, ['status', '--porcelain', ...scope]) ?? '';
  const lines = porcelain.split('\n').filter((l) => l.trim().length);
  const sha = subject[0] || commit;
  return {
    path: dir,
    pathspec,
    commit: sha,
    short: sha.slice(0, 7),
    head: commit,
    committed: subject[1] ?? null,
    dirty: lines.length,
    dirty_tracked: lines.filter((l) => !l.startsWith('??')).length,
    dirty_paths: lines.slice(0, 20),
  };
}

/** Every file under `dir`, relative and sorted — the order the fingerprint hashes in. */
function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (e.isFile()) out.push(relative(base, p));
  }
  return out.sort();
}

/**
 * sha256 over a built tree: `sha256(relpath + "\0" + sha256(bytes) + "\n" … )`.
 *
 * Path *and* content, so a file that moves changes the hash even when its bytes do not — a
 * renamed entry point is a different build. `newest` is reported alongside because an mtime
 * answers "when" where a hash only answers "which", and the two together are what makes a
 * stale `dist/` legible in a report.
 */
export function treeFingerprint(dir) {
  if (!existsSync(dir)) return { path: dir, sha256: null, files: 0 };
  const files = walk(dir);
  const h = createHash('sha256');
  let newest = 0;
  for (const f of files) {
    const p = join(dir, f);
    h.update(f);
    h.update('\0');
    h.update(createHash('sha256').update(readFileSync(p)).digest('hex'));
    h.update('\n');
    newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return { path: dir, sha256: h.digest('hex'), files: files.length, newest: new Date(newest).toISOString() };
}

/** The espressivo `dist/` root that `ml/node/paths.mjs` imports from. */
const ESPRESSIVO_DIST = resolve(dirname(ESPRESSIVO), '..');
const ESPRESSIVO_ROOT = resolve(ESPRESSIVO_DIST, '..');

/**
 * The full provenance record.
 *
 * `extra` is merged in by callers that hold a pin this module cannot read for itself — in
 * practice `{verovio: "6.1.0-682d606"}` from `mei/convert.json`.
 */
export function corpusProvenance(extra = {}) {
  return {
    when: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    espressivo: { ...gitInfo(ESPRESSIVO_ROOT), dist: treeFingerprint(ESPRESSIVO_DIST), entry: ESPRESSIVO },
    java_fork: gitInfo(MEICO),
    corpus_code: gitInfo(resolve(HERE, '../..'), 'ml/corpus'),
    ...extra,
  };
}

/**
 * The one-line form carried by every JSONL record: `espressivo@<sha7>[+dirty]/<dist12>`,
 * `java@<sha7>`, `corpus@<sha7>`, plus whatever `extra` names (`verovio@6.1.0-…`).
 *
 * Compact on purpose — it is repeated once per record — but complete enough that a line torn
 * out of the file still names every build that touched it. `+dirty` counts *tracked*
 * modifications only: an untracked scratch file next to the code did not go into the build,
 * a modified one may have.
 */
export function buildTag(prov) {
  const one = (name, g, suffix = '') =>
    g && g.commit ? `${name}@${g.short}${g.dirty_tracked ? '+dirty' : ''}${suffix}` : `${name}@unknown`;
  const parts = [
    one('espressivo', prov.espressivo, prov.espressivo?.dist?.sha256 ? `/${prov.espressivo.dist.sha256.slice(0, 12)}` : ''),
    one('java', prov.java_fork),
    one('corpus', prov.corpus_code),
  ];
  if (prov.verovio) parts.push(`verovio@${prov.verovio}`);
  return parts.join(' ');
}

/** `mei/convert.json`'s Verovio version, or `null` — the one pin this module cannot read. */
export function verovioVersion(dataDir) {
  const p = join(dataDir, 'mei', 'convert.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')).verovio_version ?? null;
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const p = corpusProvenance();
  process.stdout.write(JSON.stringify(p, null, 2) + '\n' + buildTag(p) + '\n');
}
