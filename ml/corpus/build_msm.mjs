#!/usr/bin/env node
/**
 * Step 3: MEI -> MSM (720 ppq), era-tagged, normalised, one file per piece.
 *
 *   nice -n 15 node build_msm.mjs [--data ../data/corpus_pilot] [--only id ...]
 *
 * The conversion itself is espressivo's `convertMeiToMsmMpm` — the same library that renders
 * the corpus, so the score model and the performance model come from one implementation. Its
 * MPM output (tempo/dynamics read off the MEI's *notation*) is **discarded**: the corpus's
 * interpretations are sampled in canonical form by `era_sampler.mjs`, and a converter MPM
 * would be a second, non-canonical performance hypothesis in the same document.
 *
 * `expandOrnaments: false` — MEI trill/mordent/turn signs are left unexpanded. Note-generating
 * ornaments are a v1.1 band (SYSTEM.md §4); expanding them now would put notes in the score
 * that no map in the v1.0 canonical form owns.
 *
 * The output of this step is `msm/<id>.msm` plus `msm/index.json`, which carries the era tag,
 * the part register statistics, the dropped-grace-note count and the time signature — i.e.
 * everything the generator needs without re-parsing the MSM.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESPRESSIVO } from '../node/paths.mjs';
import {
  PPQ,
  buildScoreMsm,
  dropZeroDuration,
  orderPartsByRegister,
  parseMsm,
  partStats,
  redateFromTimemap,
} from './score_msm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** espressivo logs conversion progress to the console; capture it rather than let it flood. */
function captureConsole(fn) {
  const log = console.log;
  const err = console.error;
  const messages = [];
  console.log = (...a) => messages.push(a.join(' '));
  console.error = (...a) => messages.push(a.join(' '));
  try {
    return { value: fn(), messages };
  } finally {
    console.log = log;
    console.error = err;
  }
}

function parseArgs(argv) {
  const o = { data: resolve(HERE, '../data/corpus_pilot'), only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') o.data = resolve(argv[++i]);
    else if (argv[i] === '--only') {
      o.only = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o.only.push(argv[++i]);
    } else throw new Error(`unknown argument ${argv[i]}`);
  }
  return o;
}

export async function main(argv) {
  const opt = parseArgs(argv);
  const fetched = JSON.parse(readFileSync(join(opt.data, 'fetched.json'), 'utf8'));
  const meiDir = join(opt.data, 'mei');
  const msmDir = join(opt.data, 'msm');
  mkdirSync(msmDir, { recursive: true });
  const { convertMeiToMsmMpm } = await import(ESPRESSIVO);
  // The class surface, for the one operation the facade does not expose: repeat resolution.
  const { Msm } = await import(ESPRESSIVO.replace('/api/index.js', '/index.js'));

  const index = [];
  for (const rec of fetched.files) {
    if (opt.only && !opt.only.includes(rec.id)) continue;
    const meiPath = join(meiDir, `${rec.id}.mei`);
    if (!existsSync(meiPath)) throw new Error(`${rec.id}: no MEI — run kern_to_mei.py first`);
    const mei = readFileSync(meiPath, 'utf8');

    const t0 = Date.now();
    const { value: movements, messages } = captureConsole(() =>
      convertMeiToMsmMpm(mei, { ppq: PPQ, cleanup: true, expandOrnaments: false }),
    );
    const convertMs = Date.now() - t0;
    if (!movements.length) throw new Error(`${rec.id}: converter returned no movement`);
    if (movements.length > 1)
      process.stderr.write(`NOTE ${rec.id}: ${movements.length} movements (mdivs); taking index 0\n`);

    // Repeat structure: measured, not resolved. `Msm.resolveSequencingMaps()` is available and
    // was tried; it is NOT used, because the two implementations disagree about what the
    // repeats are. On the pilot, meico expands the Scarlatti sonatas (660 -> 1256 notes) where
    // Verovio's own MIDI does not (its ExpansionMap cannot resolve the `@plist` labels the
    // Humdrum importer wrote), and Verovio expands Chopin op. 28/4 (421 -> 600) where meico
    // writes no `<goto>` at all. Resolving on one side therefore *destroys* the cross-check
    // rather than enabling it. The corpus is the score played once through, and `hasGoto`
    // records which pieces carry a repeat structure that a v1.1 pass would have to resolve on
    // both sides at once. It tests for `<goto>` and not for a non-empty `<sequencingMap>`,
    // because the converter writes a `fine` marker into that map on EVERY piece — the first
    // version of this flag read true 30/30 and said nothing.
    const hasGoto = /<goto\b/.test(movements[0].msm);
    void Msm; // imported to document what was deliberately not called; see above.
    const raw = parseMsm(movements[0].msm);
    const zero = dropZeroDuration(raw.parts);
    const ts = zero.parts.find((p) => p.timeSignature)?.timeSignature ?? null;
    const measureTicks = ts ? (4 * PPQ * ts.numerator) / ts.denominator : 4 * PPQ;
    // Timing authority: Verovio's timemap, joined on xml:id. See `redateFromTimemap`.
    const timemap = JSON.parse(readFileSync(join(opt.data, 'timemap', `${rec.id}.json`), 'utf8'));
    const redated = redateFromTimemap(zero.parts, timemap);
    if (redated.missing.length)
      process.stderr.write(`NOTE ${rec.id}: ${redated.missing.length} note(s) absent from the timemap, dropped\n`);
    const ordered = orderPartsByRegister(redated.parts);
    const stats = partStats(ordered);
    const notes = ordered.reduce((s, p) => s + p.notes.length, 0);
    if (!notes) throw new Error(`${rec.id}: no notes survived normalisation`);
    const lastEnd = Math.max(...ordered.flatMap((p) => p.notes.map((n) => n.date + n.dur)));

    const msm = buildScoreMsm(movements[0].title || rec.work, rec.id, ordered, ts);
    writeFileSync(join(msmDir, `${rec.id}.msm`), msm);

    index.push({
      id: rec.id,
      era: rec.era,
      composer: rec.composer,
      work: rec.work,
      source: rec.source,
      tier: rec.tier,
      title: movements[0].title,
      movements: movements.length,
      ppq: PPQ,
      notes,
      parts: stats,
      registerReordered: ordered.map((p) => p.number).join(',') !== raw.parts.map((p) => p.number).join(','),
      droppedZeroDuration: zero.dropped,
      droppedByPart: zero.droppedByPart,
      hasGoto,
      redatedNotes: redated.moved,
      redatedMaxShiftTicks: redated.maxShiftTicks,
      redatedDurationChanged: redated.durationChanged,
      redatedMissing: redated.missing.length,
      timeSignature: ts,
      measureTicks,
      lastNoteEndTicks: lastEnd,
      lengthBeats: lastEnd / PPQ,
      convertMs,
      converterMessages: messages.filter((m) => !/^(Converting MEI|Resolving|Replacing|MEI to MSM| done)/.test(m.trim())).slice(0, 10),
    });
    process.stdout.write(
      `${rec.id.padEnd(34)} ${rec.era.padEnd(9)} parts ${stats.length} notes ${String(notes).padStart(5)} ` +
        `beats ${(lastEnd / PPQ).toFixed(0).padStart(4)} ts ${ts ? `${ts.numerator}/${ts.denominator}` : '?'} ` +
        `grace-dropped ${zero.dropped} re-dated ${redated.moved} (max ${redated.maxShiftTicks} tk) ${convertMs} ms\n`,
    );
  }

  // `--only` must not truncate the index to the subset it rebuilt: the entries it did not
  // touch still describe files that are on disk, and a downstream tool reading a silently
  // shortened index would process a corpus of three pieces believing it had thirty.
  let merged = index;
  if (opt.only && existsSync(join(msmDir, 'index.json'))) {
    const prev = JSON.parse(readFileSync(join(msmDir, 'index.json'), 'utf8')).pieces ?? [];
    const rebuilt = new Set(index.map((p) => p.id));
    const order = fetched.files.map((f) => f.id);
    merged = [...prev.filter((p) => !rebuilt.has(p.id)), ...index].sort(
      (a, b) => order.indexOf(a.id) - order.indexOf(b.id),
    );
  }
  writeFileSync(join(msmDir, 'index.json'), JSON.stringify({ ppq: PPQ, pieces: merged }, null, 2) + '\n');
  const byEra = {};
  for (const p of index) byEra[p.era] = (byEra[p.era] ?? 0) + 1;
  process.stdout.write(
    `\n${index.length} MSM written -> ${msmDir}  (` +
      Object.entries(byEra).map(([e, n]) => `${e} ${n}`).join(', ') +
      `); total notes ${index.reduce((s, p) => s + p.notes, 0)}, ` +
      `grace notes dropped ${index.reduce((s, p) => s + p.droppedZeroDuration, 0)}\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
