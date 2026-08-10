#!/usr/bin/env node
/**
 * Unit checks for the score-side transforms, on constructed inputs.
 *
 *   nice -n 15 node selftest.mjs
 *
 * ### Why constructed inputs, when a 30-movement corpus is right there
 *
 * Because the corpus does not reach these branches. `registerReordered` is **false on 30/30**
 * pilot pieces: Verovio's kern importer already emits the upper staff first, so
 * `orderPartsByRegister` — the function `README.md` credits with making CANONICAL Y1/Y5 hold —
 * has never actually renumbered anything in this pipeline. A safeguard that never fires is a
 * safeguard nobody has tested, and it will fire on the first source whose staff order differs.
 * The same holds for `redateFromTimemap`'s missing-id path, `dropZeroDuration` on a part that
 * is *all* grace notes, and `planWindows` on a movement shorter than one window.
 *
 * So each of those gets an input that forces it, and the expected output is written out
 * literally rather than recomputed by the same code under test. This is not a substitute for
 * the corpus gates — it proves the transforms, `verify_corpus.mjs` proves the artefacts — and
 * it runs in milliseconds, so `verify_corpus.mjs` spawns it as its leg 0.
 */
import {
  buildScoreMsm,
  dropZeroDuration,
  orderPartsByRegister,
  parseMsm,
  partStats,
  redateFromTimemap,
  windowScore,
} from './score_msm.mjs';
import { planWindows } from './generate_corpus.mjs';
import { barGroupTicks, maxArticulationDensity } from './era_sampler.mjs';

let failures = 0;
const results = [];

function check(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  results.push({ name, ok, got: g, want: w });
}

const note = (date, pitch, dur = 360, id = null) => ({ date, dur, pitch, id });

// --- 1. orderPartsByRegister: the branch the corpus never takes --------------------------
// Bottom-up input (part 1 = the bass), which is the Humdrum spine order this exists for.
{
  const bass = { number: 1, name: 'lh', notes: [note(0, 40), note(720, 43), note(1440, 45)] };
  const treble = { number: 2, name: 'rh', notes: [note(0, 72), note(720, 74), note(1440, 76)] };
  const out = orderPartsByRegister([bass, treble]);
  check('orderPartsByRegister renumbers a bottom-up score', out.map((p) => [p.number, p.name]), [
    [1, 'rh'],
    [2, 'lh'],
  ]);
  check('orderPartsByRegister leaves a top-down score alone', orderPartsByRegister(out).map((p) => p.name), [
    'rh',
    'lh',
  ]);
  // A part with no notes has no median and cannot be ranked; it is dropped rather than
  // sorted to an arbitrary end, because an empty part in the emitted MSM is a part number
  // the renderer would allocate a channel for and never use.
  check(
    'orderPartsByRegister drops an empty part',
    orderPartsByRegister([{ number: 1, name: 'empty', notes: [] }, treble]).map((p) => p.name),
    ['rh'],
  );
  // Median, not mean: one very low note must not demote a treble part.
  const outlier = { number: 1, name: 'treble+outlier', notes: [note(0, 21), note(720, 80), note(1440, 81)] };
  check('orderPartsByRegister ranks by median, not mean', orderPartsByRegister([outlier, bass]).map((p) => p.name), [
    'treble+outlier',
    'lh',
  ]);
}

// --- 2. partStats ------------------------------------------------------------------------
{
  const p = { number: 1, name: 'x', notes: [note(0, 60), note(720, 64), note(1440, 67), note(2160, 72)] };
  // Lower median of an even-sized set (index floor((n-1)/2)), stated so the convention is on
  // record: 4 pitches -> the 2nd, not the average of the 2nd and 3rd.
  check('partStats reports the lower median', partStats([p]), [
    { number: 1, n: 4, medianPitch: 64, minPitch: 60, maxPitch: 72 },
  ]);
}

// --- 3. dropZeroDuration -----------------------------------------------------------------
{
  const parts = [
    { number: 1, name: 'a', notes: [note(0, 60), { ...note(0, 61), dur: 0 }, note(720, 62)] },
    { number: 2, name: 'b', notes: [{ ...note(0, 40), dur: 0 }] },
  ];
  const r = dropZeroDuration(parts);
  check('dropZeroDuration removes and counts', [r.dropped, r.droppedByPart], [2, { 1: 1, 2: 1 }]);
  check('dropZeroDuration can empty a part', r.parts.map((p) => p.notes.length), [2, 0]);
}

// --- 4. redateFromTimemap ----------------------------------------------------------------
{
  const parts = [{ number: 1, name: 'a', notes: [note(1440, 60, 720, 'n1'), note(2160, 62, 720, 'n2'), note(2880, 64, 720, 'ghost')] }];
  // qstamp is in quarter notes; 720 ppq. n1 moves back one bar (the incomplete-measure pad),
  // n2 keeps its date but has its duration corrected, `ghost` is absent from the timemap.
  const timemap = [
    { qstamp: 0, on: ['n1'] },
    { qstamp: 1, off: ['n1'], on: ['n2'] },
    { qstamp: 1.5, off: ['n2'] },
  ];
  const r = redateFromTimemap(parts, timemap);
  check('redateFromTimemap re-dates from qstamp', r.parts[0].notes.map((n) => [n.id, n.date, n.dur]), [
    ['n1', 0, 720],
    ['n2', 720, 360],
  ]);
  check('redateFromTimemap reports what it moved', [r.moved, r.maxShiftTicks, r.durationChanged, r.missing], [
    2,
    1440,
    1,
    ['ghost'],
  ]);
  // A note the timemap places but does not end keeps its own duration rather than acquiring
  // an invented one.
  const open = redateFromTimemap([{ number: 1, name: 'a', notes: [note(0, 60, 500, 'k')] }], [{ qstamp: 2, on: ['k'] }]);
  check('redateFromTimemap keeps the duration of an unended note', open.parts[0].notes.map((n) => [n.date, n.dur]), [
    [1440, 500],
  ]);
}

// --- 5. windowScore ----------------------------------------------------------------------
{
  const parts = [{ number: 1, name: 'a', notes: [note(0, 60), note(1440, 62, 2880), note(2880, 64)] }];
  const w = windowScore(parts, 1440, 1440);
  // Onset decides membership and the duration is kept WHOLE — clipping it would manufacture
  // articulation, which is the band the articulation head is supposed to learn.
  check('windowScore selects by onset and keeps durations', w[0].notes.map((n) => [n.date, n.dur]), [[0, 2880]]);
}

// --- 6. planWindows ----------------------------------------------------------------------
{
  const bar34 = 3 * 720; // 3/4
  check('planWindows tiles whole bar groups', planWindows(64 * 720, bar34, 24, 64), [
    { start: 0, length: 63 * 720 },
  ]);
  check('planWindows drops a tail below the minimum', planWindows(70 * 720, bar34, 24, 64).length, 1);
  check('planWindows keeps a tail at or above the minimum', planWindows(90 * 720, bar34, 24, 64), [
    { start: 0, length: 63 * 720 },
    { start: 63 * 720, length: 27 * 720 },
  ]);
  check('planWindows on a movement shorter than one window', planWindows(20 * 720, bar34, 24, 64), []);
  // 3/8: one bar is 1.5 beats, so the bar GROUP is two bars — the smallest multiple of the
  // measure that is also a whole number of beats (G4 and bar alignment at once).
  check('barGroupTicks doubles an odd 3/8 bar', barGroupTicks(1.5 * 720), 3 * 720);
  check('barGroupTicks leaves a whole-beat bar alone', barGroupTicks(bar34), bar34);
}

// --- 7. maxArticulationDensity (the A1 budget) -------------------------------------------
{
  // 4-beat windows: 20 dates over 16 beats = 4 windows = 5 dates/window -> no budget at all.
  check('A1 budget is zero at exactly 5 dates per 4 beats', maxArticulationDensity(20, 16 * 720), 0);
  check('A1 budget is zero below it', maxArticulationDensity(12, 16 * 720), 0);
  // 40 dates over 16 beats = 10/window -> 1 - 5/10 = 0.5.
  check('A1 budget at 10 dates per 4 beats', maxArticulationDensity(40, 16 * 720), 0.5);
  check('A1 budget is monotone in density', maxArticulationDensity(80, 16 * 720), 0.75);
}

// --- 8. buildScoreMsm / parseMsm round trip ----------------------------------------------
{
  const parts = [
    { number: 1, name: 'rh', notes: [note(0, 72, 360, 'a'), note(360, 74, 360, 'b')] },
    { number: 2, name: 'lh', notes: [note(0, 48, 720, 'c')] },
  ];
  const xml = buildScoreMsm('t', 'x', parts, { numerator: 3, denominator: 4 });
  const back = parseMsm(xml);
  check('buildScoreMsm round-trips through parseMsm', back.parts.map((p) => [p.number, p.notes.map((n) => [n.date, n.pitch, n.dur, n.id])]), [
    [1, [[0, 72, 360, 'a'], [360, 74, 360, 'b']]],
    [2, [[0, 48, 720, 'c']]],
  ]);
  check('buildScoreMsm carries the time signature', back.parts[0].timeSignature, { numerator: 3, denominator: 4 });
  // A duplicate source id must not survive into the emitted document: two notes with one id
  // make the renderer's per-note trace ambiguous.
  const dup = parseMsm(
    buildScoreMsm('t', 'x', [{ number: 1, name: 'a', notes: [note(0, 60, 360, 'z'), note(360, 62, 360, 'z')] }], null),
  );
  check('buildScoreMsm de-duplicates ids', dup.parts[0].notes.map((n) => n.id), ['z', 'p1n1']);
}

for (const r of results) process.stdout.write(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n       got  ${r.got}\n       want ${r.want}`}\n`);
process.stdout.write(`\n${results.length - failures}/${results.length} score-side unit checks pass\n`);
process.stdout.write(failures ? 'SELFTEST_FAIL\n' : 'SELFTEST_PASS\n');
process.exitCode = failures ? 1 : 0;
