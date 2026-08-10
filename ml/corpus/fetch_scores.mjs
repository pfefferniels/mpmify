#!/usr/bin/env node
/**
 * Step 1 of the era-tagged real-repertoire pipeline: fetch the pilot scores.
 *
 *   node fetch_scores.mjs [--out ../data/corpus_pilot] [--manifest ./manifest.json]
 *
 * Every source in `manifest.json` is pinned to a **commit SHA**, and the download URL is
 * `raw.githubusercontent.com/<repo>/<sha>/<path>` — never a branch name. A branch moves; a
 * corpus that cannot be re-fetched byte-for-byte is not a corpus, it is a snapshot of one
 * afternoon. The script writes `fetched.json` next to the files with a sha256 per file, so a
 * later run can prove it got the same bytes (`--verify`).
 *
 * Nothing here writes outside `--out`, which defaults under `ml/data/` — gitignored. That is
 * not a convenience: the pilot deliberately contains encodings whose licence RESERVES
 * derivative rights (see `README.md` §1, tier C), and the repository is public.
 *
 * ## Attribution is read from the file, not from the source record
 *
 * The manifest's per-source `attribution` / `encoding_license` describe a *repository*. The
 * copyright of an encoding is asserted in the encoding, in Humdrum reference records — and on
 * this pilot the two disagree: `humdrum-tools/bach-wtc` carries CCARH's
 * `!!!YEC: Copyright (c) 1994, 2000 Center for Computer Assisted Research in the Humanities`
 * on the three preludes and `!!!YEC: Copyright 1994, David Huron` with a differently worded
 * `!!!YEM` on the two fugues. A release filter that quoted the source-level string would
 * attribute two encodings to the wrong party. So every file's own `!!!YEC` / `!!!YEM` / `!!!ENC`
 * / `!!!EED` / `!!!EEV` / `!!!YER` is copied into `fetched.json` verbatim, `attribution_source`
 * says which record the attribution came from, and a source whose files disagree is printed
 * rather than averaged. Where a file carries no `!!!YEC` at all (the NIFC Chopin editions, the
 * Scriabin corpus) the manifest's repository-level statement is the only evidence there is —
 * which is itself the fact worth recording.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function parseArgs(argv) {
  const o = { out: resolve(HERE, '../data/corpus_pilot'), manifest: join(HERE, 'manifest.json'), verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = resolve(argv[++i]);
    else if (a === '--manifest') o.manifest = resolve(argv[++i]);
    else if (a === '--verify') o.verify = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/**
 * One HTTP GET, as text. Node's global `fetch` is used rather than `curl` so the script has no
 * shell dependency; a non-200 is a hard error because a 404 body written to disk as a ".krn"
 * is the kind of thing that converts to an empty score and is only noticed three steps later.
 */
async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'interpres-corpus/1 (research)' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

/**
 * The rights- and attribution-bearing Humdrum reference records, in the order Humdrum defines
 * them. Everything else in the file's header (`!!!OTL`, `!!!COM`, …) describes the *work*,
 * which is public domain here and needs no record; these six describe the *encoding*, which
 * is what the licence governs.
 */
const RIGHTS_RECORDS = {
  YEC: 'copyright of the electronic edition',
  YEM: 'copyright message / licence terms',
  YER: 'date the electronic edition was released',
  ENC: 'encoder',
  EED: 'electronic editor',
  EEV: 'electronic edition version',
};

/**
 * `{YEC, YEM, …}` for one kern file — verbatim, first occurrence wins.
 *
 * First occurrence rather than last: several Sapp encodings repeat `!!!YEC` in a trailing
 * block, and a duplicate is a restatement, not an amendment. A record present twice with two
 * *different* values would be a genuine ambiguity — it does not occur on this pilot, and
 * `distinct` in the summary below is what would show it.
 */
export function rightsRecords(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^!!!([A-Z]{3}[0-9]*):\s?(.*)$/.exec(line.trimEnd());
    if (!m) continue;
    const key = m[1].replace(/[0-9]+$/, ''); // EED2, EED3 … are further editors of the same kind
    if (!(key in RIGHTS_RECORDS)) continue;
    const value = m[2].trim();
    if (!value.length) continue;
    if (out[key] === undefined) out[key] = value;
    else if (key === 'EED' && out[key] !== value) out[key] += `; ${value}`;
  }
  return out;
}

export async function main(argv) {
  const opt = parseArgs(argv);
  const manifest = JSON.parse(readFileSync(opt.manifest, 'utf8'));
  const kernDir = join(opt.out, 'kern');
  mkdirSync(kernDir, { recursive: true });

  const records = [];
  let fetched = 0;
  let cached = 0;
  for (const p of manifest.pieces) {
    const src = manifest.sources[p.source];
    if (!src) throw new Error(`piece ${p.id}: unknown source ${p.source}`);
    if (!/^[0-9a-f]{40}$/.test(src.commit))
      throw new Error(`source ${p.source}: commit must be a full 40-hex SHA, got ${src.commit}`);
    const path = [src.dir, p.file].filter((s) => s && s.length).join('/');
    const url = `https://raw.githubusercontent.com/${src.repo}/${src.commit}/${path}`;
    const local = join(kernDir, `${p.id}.krn`);

    let text;
    if (existsSync(local) && !opt.verify) {
      text = readFileSync(local, 'utf8');
      cached++;
    } else {
      text = await get(url);
      if (!/^\*\*kern/m.test(text)) throw new Error(`${p.id}: downloaded text has no **kern spine (${url})`);
      if (opt.verify && existsSync(local) && readFileSync(local, 'utf8') !== text)
        throw new Error(`${p.id}: re-fetch differs from the file on disk — the pin is not holding`);
      writeFileSync(local, text);
      fetched++;
    }
    const rights = rightsRecords(text);
    records.push({
      id: p.id,
      era: p.era,
      composer: p.composer,
      work: p.work,
      source: p.source,
      url,
      local: `kern/${p.id}.krn`,
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
      encoding_license: src.encoding_license,
      tier: src.tier,
      redistributable: src.redistributable,
      // Repository-level statement, kept and labelled as such …
      source_attribution: src.attribution,
      // … and the file's own assertion, which is the one to quote. See the header.
      file_rights_records: rights,
      encoding_copyright: rights.YEC ?? null,
      encoding_terms: rights.YEM ?? null,
      encoder: rights.ENC ?? null,
      attribution_source: rights.YEC ? 'file (!!!YEC)' : 'manifest (file carries no !!!YEC)',
      attribution: rights.YEC ?? src.attribution,
    });
  }

  // Per source: do its files agree about who holds the copyright? `bach-wtc` does not, which
  // is the whole reason the per-file record exists. Printed, not resolved — resolving would
  // mean choosing one of two conflicting assertions, which is not this script's call.
  const bySource = {};
  for (const r of records) {
    const s = (bySource[r.source] ??= { files: 0, distinct_YEC: new Set(), distinct_YEM: new Set(), without_YEC: 0 });
    s.files++;
    if (r.encoding_copyright) s.distinct_YEC.add(r.encoding_copyright);
    else s.without_YEC++;
    if (r.encoding_terms) s.distinct_YEM.add(r.encoding_terms);
  }
  const attributionBySource = Object.fromEntries(
    Object.entries(bySource).map(([k, v]) => [
      k,
      {
        files: v.files,
        files_without_YEC: v.without_YEC,
        distinct_YEC: [...v.distinct_YEC],
        distinct_YEM: [...v.distinct_YEM],
        mixed: v.distinct_YEC.size > 1,
      },
    ]),
  );

  const byEra = {};
  for (const r of records) byEra[r.era] = (byEra[r.era] ?? 0) + 1;
  writeFileSync(
    join(opt.out, 'fetched.json'),
    JSON.stringify(
      {
        manifest: manifest.name,
        when: new Date().toISOString(),
        byEra,
        rights_record_keys: RIGHTS_RECORDS,
        attribution_by_source: attributionBySource,
        files: records,
      },
      null,
      2,
    ) + '\n',
  );
  process.stdout.write(
    `fetched ${fetched}, cached ${cached}, total ${records.length} — ` +
      Object.entries(byEra).map(([e, n]) => `${e} ${n}`).join(', ') +
      `\n-> ${join(opt.out, 'fetched.json')}\n`,
  );
  for (const [name, a] of Object.entries(attributionBySource)) {
    const tag = a.mixed ? 'MIXED ATTRIBUTION' : a.distinct_YEC.length ? 'per-file !!!YEC' : 'no !!!YEC in any file';
    process.stdout.write(`  ${name.padEnd(14)} ${String(a.files).padStart(2)} files  ${tag}\n`);
    for (const y of a.distinct_YEC) process.stdout.write(`      YEC  ${y}\n`);
    if (a.files_without_YEC)
      process.stdout.write(`      ${a.files_without_YEC} file(s) assert nothing; the manifest's repository-level licence is the only evidence\n`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
