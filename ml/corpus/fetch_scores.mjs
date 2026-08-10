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
 * derivative rights (see `SOURCES.md`, tier C), and the repository is public.
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
      attribution: src.attribution,
    });
  }

  const byEra = {};
  for (const r of records) byEra[r.era] = (byEra[r.era] ?? 0) + 1;
  writeFileSync(
    join(opt.out, 'fetched.json'),
    JSON.stringify({ manifest: manifest.name, when: new Date().toISOString(), byEra, files: records }, null, 2) + '\n',
  );
  process.stdout.write(
    `fetched ${fetched}, cached ${cached}, total ${records.length} — ` +
      Object.entries(byEra).map(([e, n]) => `${e} ${n}`).join(', ') +
      `\n-> ${join(opt.out, 'fetched.json')}\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
