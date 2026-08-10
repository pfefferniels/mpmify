#!/usr/bin/env node
/**
 * Step 5: validation for the era-tagged corpus.
 *
 *   nice -n 15 node verify_corpus.mjs <corpus.jsonl> [--imprecision <variant.jsonl>]
 *
 * Legs, in order of what they can prove:
 *
 * 0. **`selftest.mjs`** — the score-side transforms on constructed inputs. It is here because
 *    the corpus does not reach all of them: `orderPartsByRegister` never fires on the pilot
 *    (`registerReordered` is false 30/30), and an untested safeguard is the one that is wrong
 *    when it finally runs.
 *
 * 1. **`ml/node/verify_v4.mjs invariants`, run as a subprocess on the same file.** The
 *    canonical rules do not change because the score is real, so the check should not either:
 *    running the synthetic corpus's own invariant suite on this file is the strongest
 *    statement available — that this corpus is admissible to exactly the pipeline the other
 *    one is. It is spawned rather than reimplemented so the two can never drift.
 *
 *    **What leg 1 does NOT attest**, because `INVARIANTS_PASS` is easy to over-read: that
 *    suite contains no articulation-*density* check at all. It checks A2/A3's deadbands, A6's
 *    part-locality and the row width; A1's "~15 % of distinct onset dates" is not among its
 *    tests, in any form. So A1 is attested by leg 2 below and by nothing else in this pipeline.
 *
 * 2. **Corpus-specific invariants** the synthetic suite has no reason to know about: the era
 *    tag and window provenance are present and consistent; every window is a whole number of
 *    beats; an asynchronyMap appears only on a two-part window (Y1); part 1 is the higher
 *    register (Y5); and the articulation density realised stays under **the corpus's
 *    re-derivation of A1**.
 *
 *    That re-derivation is a *change to a rule this subsystem does not own*, and it is called
 *    one here rather than folded into the check. CANONICAL §4.A1 reads "articulation attaches
 *    to ~15 % of distinct onset dates" and justifies the number by what it leaves: "≥5 clean
 *    dates per 4-beat segment". Real repertoire is 2–6× denser than the synthetic score, so
 *    the corpus keeps the justification and drops the constant —
 *    `maxDensity = 1 − 5/(onset dates per 4-beat window)`, `RANGES.md` §3 — and the realised
 *    baroque density reaches 0.41, i.e. **2.7× the rule as written**. The argument is in
 *    `RANGES.md`; the decision belongs to whoever owns CANONICAL. Both numbers are therefore
 *    printed side by side by leg 3, and this leg fails a window against the re-derived budget
 *    while *reporting* how far it sits from A1's literal 15 %.
 *
 * 2b. **The imprecision variant carries the same interpretation.** All six canonical maps and
 *    the sustain-CC trace must be byte-equal to the base record — the variant differs by one
 *    added band and by nothing else, or it is not a controlled comparison. `sustain_cc` is the
 *    interesting one: it is CANONICAL §9.9(3)'s prediction that the positionMap bypasses the
 *    imprecision map, and an earlier version of this leg compared only `tempo` and `dynamics`,
 *    so the claim it printed was broader than the check behind it.
 *
 * 3. **Realised era ranges**, printed per era. This is the deliverable's "report the ranges"
 *    and it is measured on the emitted file, not read back out of `ERA_RANGES` — a prior that
 *    is never realised (because the score is too short for it, or a rejection loop gave up) is
 *    exactly the kind of claim that survives review by never being checked.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PPQ } from '../node/sampler.mjs';
import { ERA_RANGES, maxArticulationDensity } from './era_sampler.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const q = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] : null);
const fmt = (a, d = 2) =>
  a.length ? `${q(a, 0).toFixed(d)} / ${q(a, 0.5).toFixed(d)} / ${q(a, 1).toFixed(d)}` : '—';

/** CANONICAL §4.A1's literal constant, kept here so the corpus's deviation from it is a number. */
const A1_LITERAL_DENSITY = 0.15;

function corpusInvariants(recs) {
  const bad = [];
  const fail = (r, m) => bad.length < 30 && bad.push(`${r.piece_id ?? r.id}#${r.window ?? '?'}: ${m}`);
  const a1 = { overLiteral: 0, windows: 0, maxRealised: 0, maxRatio: 0, capBinding: 0 };

  for (const r of recs) {
    if (!['baroque', 'classical', 'romantic'].includes(r.era)) fail(r, `era tag "${r.era}"`);
    if (typeof r.piece_id !== 'string' || !r.piece_id.length) fail(r, 'no piece_id');
    if (!Number.isInteger(r.window) || r.window < 0) fail(r, `window index ${r.window}`);
    if (!Array.isArray(r.window_ticks) || r.window_ticks.length !== 2) fail(r, 'no window_ticks');
    else if (r.window_ticks[1] !== r.total_ticks) fail(r, `window_ticks length ${r.window_ticks[1]} != total_ticks ${r.total_ticks}`);
    if (r.total_ticks % PPQ !== 0) fail(r, `total_ticks ${r.total_ticks} is not a whole number of beats (G4)`);

    // Register order: part 1 must be the higher voice, which is what Y5's sign convention and
    // the melody-lead prior both rest on.
    const byPart = new Map();
    for (const n of r.notes) {
      const p = n[6] ?? 1;
      if (!byPart.has(p)) byPart.set(p, []);
      byPart.get(p).push(n[2]);
    }
    const parts = [...byPart.keys()].sort((a, b) => a - b);
    for (let i = 1; i < parts.length; i++) {
      const hi = q(byPart.get(parts[i - 1]), 0.5);
      const lo = q(byPart.get(parts[i]), 0.5);
      if (hi < lo) fail(r, `part ${parts[i - 1]} median pitch ${hi} below part ${parts[i]}'s ${lo} (register order)`);
    }
    if ((r.asynchrony ?? []).length && parts.length !== 2)
      fail(r, `asynchronyMap on a ${parts.length}-part window (Y1 is part-2-only)`);

    // A1's clean-observation budget, checked on the realised map rather than on the prior.
    const datesByPart = new Map();
    for (const n of r.notes) {
      const p = n[6] ?? 1;
      if (!datesByPart.has(p)) datesByPart.set(p, new Set());
      datesByPart.get(p).add(n[0]);
    }
    const articByPart = new Map();
    for (const a of r.articulation ?? []) articByPart.set(a[3], (articByPart.get(a[3]) ?? 0) + 1);
    // A1's budget is about the clean observations the GLOBAL curves are read from, so the cap
    // is derived from the union of onset dates over all parts (see sampleArticulationEraMap).
    const pieceDates = new Set(r.notes.map((n) => n[0])).size;
    const cap = maxArticulationDensity(pieceDates, r.total_ticks);
    const eraTarget = ERA_RANGES[r.era]?.articulation.density ?? A1_LITERAL_DENSITY;
    if (cap < eraTarget) a1.capBinding++;
    for (const [p, n] of articByPart) {
      const dates = datesByPart.get(p)?.size ?? 0;
      const realised = dates ? n / dates : 1;
      // Binomial slack: the density is a Bernoulli parameter, so the realised share overshoots
      // the cap by sampling noise. 3 sigma of a Bernoulli(cap) mean over `dates` draws.
      const slack = 3 * Math.sqrt(Math.max(cap, 1e-9) * (1 - cap) / Math.max(dates, 1));
      if (realised > cap + slack + 1e-9)
        fail(r, `part ${p} articulation density ${realised.toFixed(3)} above the A1 budget ${cap.toFixed(3)} (+3σ ${slack.toFixed(3)})`);
      // The other half of the A1 statement: how far the realised density sits from the rule as
      // CANONICAL literally writes it. Counted, never failed — failing it would be this
      // subsystem enforcing a decision it has only argued for (see the header, RANGES.md §3).
      a1.windows++;
      if (realised > A1_LITERAL_DENSITY + slack + 1e-9) a1.overLiteral++;
      a1.maxRealised = Math.max(a1.maxRealised, realised);
      a1.maxRatio = Math.max(a1.maxRatio, realised / A1_LITERAL_DENSITY);
    }
  }
  return { bad, a1 };
}

function eraStats(recs) {
  const out = {};
  for (const r of recs) {
    const s = (out[r.era] ??= {
      windows: 0,
      movements: new Set(),
      beats: [],
      notes: [],
      bpm: [],
      tempoInstr: [],
      tempoTransFrac: [],
      volume: [],
      dynTransFrac: [],
      articDensity: [],
      relDur: [],
      velCh: [],
      rubatoSpans: 0,
      rubatoIntensity: [],
      rubatoFrames: new Map(),
      asyncPieces: 0,
      asyncOff: [],
      movPieces: 0,
      movCc: [],
      movSegTicks: [],
      ccPoints: [],
    });
    s.windows++;
    s.movements.add(r.piece_id);
    s.beats.push(r.total_ticks / PPQ);
    s.notes.push(r.notes.length);
    let trans = 0;
    for (const t of r.tempo) {
      s.bpm.push(t[1]);
      if (t[2] !== null) {
        s.bpm.push(t[2]);
        trans++;
      }
    }
    s.tempoInstr.push(r.tempo.length);
    s.tempoTransFrac.push(r.tempo.length ? trans / r.tempo.length : 0);
    let dtrans = 0;
    for (const d of r.dynamics ?? []) {
      s.volume.push(d[1]);
      if (d[2] !== null) {
        s.volume.push(d[2]);
        dtrans++;
      }
    }
    s.dynTransFrac.push((r.dynamics ?? []).length ? dtrans / r.dynamics.length : 0);
    const dates = new Set(r.notes.map((n) => `${n[6] ?? 1}:${n[0]}`));
    s.articDensity.push(dates.size ? (r.articulation ?? []).length / dates.size : 0);
    for (const a of r.articulation ?? []) {
      s.relDur.push(a[1]);
      s.velCh.push(a[2]);
    }
    for (let i = 0; i < (r.rubato ?? []).length; i += 2) {
      s.rubatoSpans++;
      s.rubatoIntensity.push(r.rubato[i][2]);
      s.rubatoFrames.set(r.rubato[i][1], (s.rubatoFrames.get(r.rubato[i][1]) ?? 0) + 1);
    }
    if ((r.asynchrony ?? []).length) {
      s.asyncPieces++;
      for (const a of r.asynchrony) s.asyncOff.push(a[1]);
    }
    if ((r.movement ?? []).length) {
      s.movPieces++;
      for (let i = 0; i < r.movement.length; i++) {
        s.movCc.push(Math.round(127 * r.movement[i][1]));
        if (i) s.movSegTicks.push(r.movement[i][0] - r.movement[i - 1][0]);
      }
      s.ccPoints.push((r.sustain_cc ?? []).length);
    }
  }
  return out;
}

function report(stats) {
  let text = '';
  for (const era of ['baroque', 'classical', 'romantic']) {
    const s = stats[era];
    if (!s) continue;
    const cfg = ERA_RANGES[era];
    const frames = [...s.rubatoFrames.entries()].sort((a, b) => a[0] - b[0]).map(([f, n]) => `${f}:${n}`).join(' ');
    text +=
      `\n=== ${era} — ${s.movements.size} movements, ${s.windows} windows, ${s.notes.reduce((a, b) => a + b, 0)} notes ===\n` +
      `  window beats            min/med/max ${fmt(s.beats, 0)}\n` +
      `  notes per window        ${fmt(s.notes, 0)}\n` +
      `  tempo bpm literals      ${fmt(s.bpm, 1)}   prior [${cfg.tempo.bpmLo}, ${cfg.tempo.bpmHi}]\n` +
      `  tempo instructions      ${fmt(s.tempoInstr, 0)}   transition share ${fmt(s.tempoTransFrac, 2)}  prior p=${cfg.tempo.transitionP}\n` +
      `  dynamics volume         ${fmt(s.volume, 1)}   transition share ${fmt(s.dynTransFrac, 2)}  prior p=${cfg.dynamics.transitionP}\n` +
      `  articulation density    ${fmt(s.articDensity, 3)}   era prior ${cfg.articulation.density}, capped by the ` +
      `re-derived A1 budget; CANONICAL A1 literally says ${A1_LITERAL_DENSITY}\n` +
      `  articulation relDur     ${fmt(s.relDur, 2)}   prior [${cfg.articulation.relDur}]\n` +
      `  articulation velChange  ${fmt(s.velCh, 0)}   prior [${cfg.articulation.velChange}]\n` +
      `  rubato spans            ${s.rubatoSpans} over ${s.windows} windows (prior p=${cfg.rubato.p}), frames ${frames || '—'}\n` +
      `  rubato intensity        ${fmt(s.rubatoIntensity, 2)}   prior ${JSON.stringify(cfg.rubato.intensity)}\n` +
      `  asynchrony windows      ${s.asyncPieces}/${s.windows} (prior p=${cfg.asynchrony.p}), offsets ms ${fmt(s.asyncOff, 0)}  prior [${cfg.asynchrony.mag}]\n` +
      `  movement windows        ${s.movPieces}/${s.windows} (prior p=${cfg.movement.p}), position CC ${fmt(s.movCc, 0)}  prior [${cfg.movement.posLo}, ${cfg.movement.posHi}]\n` +
      `  movement segment ticks  ${fmt(s.movSegTicks, 0)}   CC points/window ${fmt(s.ccPoints, 0)}\n`;
  }
  return text;
}

function main(argv) {
  const path = resolve(argv[0]);
  const impIdx = argv.indexOf('--imprecision');
  const impPath = impIdx >= 0 ? resolve(argv[impIdx + 1]) : null;
  const recs = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  process.stdout.write('--- leg 0: selftest.mjs (score-side transforms, on constructed inputs)\n');
  let leg0 = 0;
  let stOut = '';
  try {
    stOut = execFileSync('nice', ['-n', '15', 'node', join(HERE, 'selftest.mjs')], { encoding: 'utf8' });
  } catch (e) {
    stOut = (e.stdout ?? '') + (e.stderr ?? '');
    leg0 = 1;
  }
  process.stdout.write(stOut.split('\n').filter((l) => !/^ {2}ok /.test(l)).join('\n'));
  if (!/SELFTEST_PASS/.test(stOut)) leg0 = 1;

  process.stdout.write(`--- leg 1: ml/node/verify_v4.mjs invariants (the synthetic corpus's own suite)\n`);
  let leg1 = 0;
  let v4out = '';
  try {
    v4out = execFileSync('nice', ['-n', '15', 'node', join(HERE, '../node/verify_v4.mjs'), 'invariants', path], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
  } catch (e) {
    v4out = (e.stdout ?? '') + (e.stderr ?? '');
    leg1 = 1;
  }
  process.stdout.write(v4out.split('\n').filter((l) => !/^ {4}/.test(l)).join('\n') + '\n');
  if (!/INVARIANTS_PASS/.test(v4out)) leg1 = 1;
  // What that suite does not contain, checked rather than remembered: if an A1 density test
  // ever lands in it, this line stops printing and leg 2's caveat can be retired.
  const v4Source = readFileSync(join(HERE, '../node/verify_v4.mjs'), 'utf8');
  process.stdout.write(
    `  NOTE: leg 1 does not attest CANONICAL A1 — verify_v4.mjs contains ` +
      `${/articulation[\s\S]{0,200}density|A1\b/.test(v4Source) ? 'a possible' : 'NO'} articulation-density test. ` +
      `A1 is attested only by leg 2 below, against the corpus's re-derived budget (RANGES.md §3).\n`,
  );

  process.stdout.write('--- leg 2: corpus-specific invariants\n');
  const { bad, a1 } = corpusInvariants(recs);
  process.stdout.write(bad.length ? bad.map((b) => `  ${b}\n`).join('') : '  all corpus invariants hold\n');
  process.stdout.write(
    `  A1: ${a1.windows} part-windows checked against the re-derived budget; ` +
      `${a1.capBinding} window(s) had the budget bind below the era prior; ` +
      `max realised density ${a1.maxRealised.toFixed(3)} = ${a1.maxRatio.toFixed(1)}x A1's literal ` +
      `${A1_LITERAL_DENSITY}; ${a1.overLiteral}/${a1.windows} exceed the literal 15 % ` +
      `(reported, NOT failed — the re-derivation is a CANONICAL-owned decision this subsystem only argues for)\n`,
  );

  let legImp = 0;
  if (impPath) {
    const imp = readFileSync(impPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    process.stdout.write('--- leg 2b: imprecision variant\n');
    if (imp.length !== recs.length) {
      process.stdout.write(`  FAIL variant has ${imp.length} records, base has ${recs.length}\n`);
      legImp = 1;
    } else {
      // Everything a model is trained on, not a sample of it. `sustain_cc` is deliberately in
      // the list: it is CANONICAL §9.9(3)'s prediction that the positionMap bypasses the
      // imprecision map, and it is the one field of these whose equality is *informative*.
      const SAME = ['tempo', 'dynamics', 'rubato', 'asynchrony', 'articulation', 'movement', 'sustain_cc'];
      let moved = 0;
      let bothSameMaps = 0;
      const fieldDiffs = new Map();
      for (let i = 0; i < imp.length; i++) {
        const a = recs[i];
        const b = imp[i];
        if (!b.imprecision || b.imprecision.map !== 'timing' || !(b.imprecision.sigma_ms > 0)) {
          process.stdout.write(`  FAIL record ${i} has no usable imprecision target\n`);
          legImp = 1;
          break;
        }
        const differing = SAME.filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));
        for (const k of differing) fieldDiffs.set(k, (fieldDiffs.get(k) ?? 0) + 1);
        if (!differing.length) bothSameMaps++;
        moved += a.notes.filter((n, j) => !Object.is(n[3], b.notes[j][3])).length;
      }
      const total = recs.reduce((s, r) => s + r.notes.length, 0);
      process.stdout.write(
        `  ${bothSameMaps}/${imp.length} records carry the identical interpretation across all of ` +
          `${SAME.join(', ')}${fieldDiffs.size ? ` — differing: ${[...fieldDiffs].map(([k, n]) => `${k} on ${n}`).join(', ')}` : ''}\n` +
          `  ${moved}/${total} note onsets differ from the base render (${((100 * moved) / total).toFixed(1)} %) — the band's\n` +
          `    footprint IN THIS FILE. It is not a reproducible quantity: re-rendering the same seed\n` +
          `    gives a different sample (README §5, repro_check.mjs). The targets above are reproducible; this is not.\n`,
      );
      if (bothSameMaps !== imp.length) legImp = 1;
    }
  }

  process.stdout.write('--- leg 3: realised era ranges\n');
  process.stdout.write(report(eraStats(recs)));

  const failed = leg0 || leg1 || bad.length || legImp;
  process.stdout.write(`\n${failed ? 'CORPUS_VERIFY_FAIL' : 'CORPUS_VERIFY_PASS'}\n`);
  return failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.length < 3) {
    process.stderr.write('usage: verify_corpus.mjs <corpus.jsonl> [--imprecision <variant.jsonl>]\n');
    process.exitCode = 2;
  } else process.exitCode = main(process.argv.slice(2));
}
