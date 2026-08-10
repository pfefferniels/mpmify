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
 * the part register statistics, the dropped-grace-note count, the time signature, the
 * divergence measurements (`hasGoto`, `resolvedNotes`, `tremoloElements`) and the build
 * provenance — i.e. everything the generator and every later claim need without re-parsing
 * anything.
 *
 * ## The two ways the MEI and the MSM can hold different notes, measured rather than asserted
 *
 * Both are *score content* differences between meico's importer and Verovio's realisation of
 * the same parse, and each earlier version of this file named the wrong one:
 *
 *  - **repeat structure.** meico writes `<goto>`s into the MSM's `<sequencingMap>` and leaves
 *    them unexpanded; Verovio runs with `expandNever`, so neither side plays the repeat and
 *    the corpus is the score once through. `resolvedNotes` records what meico's own
 *    `resolveSequencingMaps()` *would* produce, so the size of the decision is on disk instead
 *    of in a sentence.
 *  - **notated tremolo.** A `<bTrem>` (measured tremolo: one written chord, played as repeated
 *    attacks) is realised by Verovio's MIDI as the repeated attacks and by meico's importer as
 *    the single written chord. `tremoloElements` counts them. This is the real cause of the
 *    one large MIDI surplus on this pilot and it is *not* a repeat: the affected movement has
 *    no repeat barline and no `<goto>` at all.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESPRESSIVO } from '../node/paths.mjs';
import { buildTag, corpusProvenance, verovioVersion } from './provenance.mjs';
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
    // is called here ONLY to record what it would produce (`resolvedNotes`); its result is
    // thrown away and the corpus is the score played once through. Two reasons, in this order:
    // Verovio runs with `expandNever` (`kern_to_mei.py`), so its MEI, MIDI and timemap all
    // describe the unexpanded score — resolving on the meico side alone would put the two
    // realisations out of correspondence and destroy `score_check.py` rather than strengthen
    // it; and `redateFromTimemap` joins on `xml:id`, which the expansion rewrites. `hasGoto`
    // marks the pieces a v1.1 pass would have to resolve on BOTH sides at once. It tests for
    // `<goto>` and not for a non-empty `<sequencingMap>`, because the converter writes a `fine`
    // marker into that map on EVERY piece — the first version of this flag read true 30/30 and
    // said nothing.
    const hasGoto = /<goto\b/.test(movements[0].msm);
    let resolvedNotes = null;
    if (hasGoto) {
      const probe = new Msm(movements[0].msm);
      probe.resolveSequencingMaps();
      resolvedNotes = (probe.toXML().match(/<note\b/g) ?? []).length;
    }
    // Notated tremolo: `<bTrem>`/`<fTrem>` is one written chord that sounds as repeated
    // attacks. Verovio's MIDI realises the attacks; meico's importer imports the written
    // chord. Counted here so the MIDI surplus `score_check.py` reports has a cause on record
    // rather than an assumption — it was previously attributed to repeats, on a movement that
    // has neither a repeat barline nor a `<goto>`.
    const tremoloElements = (mei.match(/<[bf]Trem\b/g) ?? []).length;
    const raw = parseMsm(movements[0].msm);
    const zero = dropZeroDuration(raw.parts);
    const ts = zero.parts.find((p) => p.timeSignature)?.timeSignature ?? null;
    const measureTicks = ts ? (4 * PPQ * ts.numerator) / ts.denominator : 4 * PPQ;
    // Timing authority: Verovio's timemap, joined on xml:id. See `redateFromTimemap`.
    const timemap = JSON.parse(readFileSync(join(opt.data, 'timemap', `${rec.id}.json`), 'utf8'));
    const timemapOnIds = timemap.flatMap((e) => e.on ?? []);
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
      droppedNotes: zero.droppedNotes,
      hasGoto,
      resolvedNotes,
      tremoloElements,
      meiNoteElements: (mei.match(/<note\b/g) ?? []).length,
      timemapOnIds: new Set(timemapOnIds).size,
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
  // Which build produced these MSMs. espressivo's `dist/` is not in git and moves
  // independently of its commit, so the commit alone would not identify it; see
  // `provenance.mjs`. Recorded here rather than reconstructed later, because the only moment
  // at which the build is knowable is while it is running.
  const provenance = corpusProvenance({ verovio: verovioVersion(opt.data) });
  writeFileSync(
    join(msmDir, 'index.json'),
    JSON.stringify({ ppq: PPQ, build: buildTag(provenance), provenance, pieces: merged }, null, 2) + '\n',
  );
  const byEra = {};
  for (const p of index) byEra[p.era] = (byEra[p.era] ?? 0) + 1;
  const withGoto = index.filter((p) => p.hasGoto);
  const withTrem = index.filter((p) => p.tremoloElements);
  process.stdout.write(
    `\n${index.length} MSM written -> ${msmDir}  (` +
      Object.entries(byEra).map(([e, n]) => `${e} ${n}`).join(', ') +
      `); total notes ${index.reduce((s, p) => s + p.notes, 0)}, ` +
      `grace notes dropped ${index.reduce((s, p) => s + p.droppedZeroDuration, 0)}\n` +
      `repeat structure (<goto>): ${withGoto.length}/${index.length} pieces; resolving them would give ` +
      `${withGoto.reduce((s, p) => s + p.resolvedNotes, 0)} notes instead of ${withGoto.reduce((s, p) => s + p.notes, 0)} — NOT resolved\n` +
      `notated tremolo (<bTrem>/<fTrem>): ${withTrem.length}/${index.length} pieces` +
      (withTrem.length ? ` (${withTrem.map((p) => `${p.id} ${p.tremoloElements}`).join(', ')})` : '') +
      ` — imported as written chords, realised by Verovio as repeated attacks\n` +
      `build: ${buildTag(provenance)}\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
