#!/usr/bin/env node
/**
 * Cross-renderer proof for the v4 generator.
 *
 * Every comparison is `Object.is` on IEEE-754 doubles — bit equality, +0 ≠ −0 — and every
 * difference is reported, none is silently absorbed. Differences are then *classified* by
 * their distance in ULPs, because exactly one class of difference is not a logic difference:
 * Java's fdlibm and macOS' libm disagree by an ULP on some `pow`/`log` arguments. See
 * `ULP_PER_TERM` / `ABS_TOLERANCE_MS`, and note that the attribution is earned by a control
 * (`--probe-no-pow`), not assumed.
 *
 *   node verify_v4.mjs cross <pilot.jsonl> <dumpDir> [espressivo|java]
 *       1. re-render every dumped piece<i>.msm/.mpm with espressivo
 *       2. render the SAME two files with the Java fork (RenderMpm --batch, one JVM)
 *       3. compare, field class by field class: notes (xml:id, date, duration, pitch,
 *          velocity, milliseconds.date, milliseconds.date.end, part order) and every
 *          control-change stream point-for-point (date, milliseconds, value, controller,
 *          ccNumber); then check the JSONL against whichever renderer wrote it (3rd argument),
 *          which must be lossless.
 *
 *   node verify_v4.mjs v3proof <numPieces> <seed> <workDir>
 *       the whole v3-compat proof in one command: runs `java SampleAndRender` and
 *       `generate_v4.mjs --v3-compat --renderer java` at the same seed **with the same map
 *       list** and diffs them. The map list matters and is why this mode exists — see v3proof.
 *
 *   node verify_v4.mjs v3compat <node.jsonl> <java.jsonl>
 *       numeric deep-equality of the two generators' v3 output, proving the sampling port.
 *       Reports the sampled maps and the rendered notes separately, so a renderer difference
 *       can never be mistaken for a sampling-port difference.
 *
 *   node verify_v4.mjs invariants <pilot.jsonl>
 *       the canonical rules of CANONICAL.md checked on the emitted JSONL, plus the realised
 *       sampling domain.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAugmentedMsm } from './augmented_msm.mjs';
import { ESPRESSIVO, JAVA_CP as CP } from './paths.mjs';
import { CC_MAX, MOVEMENT_GRID, MOV_DEPTH_CC, MOV_JUMP_CC } from './sampler.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The map list the v3 proof needs. `SampleAndRender` defaults to tempo only — see `v3proof`. */
const V3_MAPS = ['tempo', 'dynamics', 'articulation', 'rubato'];

// -------------------------------------------------------------------------------------------

/**
 * The libm envelope — **derived per value, not asserted**.
 *
 * Java's `Math.pow`/`Math.log` (fdlibm) and macOS' libm, which V8 calls, are both
 * correctly-rounded-ish but not identical: they disagree by 1 ULP on a few percent of
 * arguments (LOG.md, "Build-team wave 1" — the finding that retired this project's earlier
 * "0.000000000 ms" claims).
 *
 * The first version of this file fixed the envelope at 2 ULP, reasoning that a rendered onset
 * passes through at most two `pow` calls in series (rubato's warp, then the tempo power
 * function). That reasoning is wrong, and the constant with it: a millisecond date is not the
 * output of one `pow`, it is an **accumulated sum**
 *
 *     ms(note) = Σ_{i < s} computeDiffTiming(segment i)  +  computeDiffTiming(partial segment s)
 *
 * (`TempoMap.renderTempoToMap:384-404` — every term is a Simpson integral of the power
 * function, each carrying its own `Math.pow`, plus two `Math.log` in `computeExponent`). Each
 * term can therefore be off by one libm ULP *independently*, and a sum of `k` such terms is off
 * by up to `k` ULP of the sum — plus the summation's own rounding. The envelope grows with the
 * tempo map, and a fixed 2 was simply a seed-lucky sample: at seed 4242 the shipped
 * pilot_v4_exact configuration produces a 3-ULP note (`piece19.p0.n23.ms.date`,
 * 3766.7262448526417 vs …403, |diff| 1.4e-12 ms) and fails the gate outright.
 *
 * So the gate is now two independent constraints, both of them derived:
 *
 *  1. **ULP.** Only fields the transcendental path can reach get any envelope at all, and it is
 *     `ULP_PER_TERM · (1 + #tempo instructions + rubato?)`, the piece's own term count. Every
 *     other field — velocities, CC values, tick dates, pitches, and *all* JSONL fields — must
 *     be bit-exact, because meico's dynamics and movement Béziers contain no transcendental
 *     call at all (verified: the only `Math.pow`/`log` on the in-scope render path are
 *     `TempoMap:299,336` and `RubatoMap:336`; `DynamicsData`'s are commented out).
 *     `ULP_PER_TERM = 4` is the standard bound for a positive sum of `k` terms each carrying a
 *     ≤1-ULP relative error: relative error ≤ k·2^-52 + k·2^-53, and a ULP step is between 1
 *     and 2 units of 2^-52 relative, giving ≤ 3k, rounded up to 4k.
 *  2. **Magnitude.** No difference may exceed `ABS_TOLERANCE_MS`, whatever the ULP count says.
 *     The constant is placed in a measured gap, not guessed. Over the 60-piece all-maps pilot
 *     (7251 notes, both renderers, 5643 non-zero differences) the two populations do not
 *     overlap: libm divergences top out at **3.64e-12 ms** (n=8) while the smallest genuine
 *     logic divergence — E1's dropped articulation — is **0.0167 ms** (n=5635, median 10, max
 *     5395). `1e-6` sits 4.6 orders above the first and 4.2 below the second. This constraint
 *     carries a unit and does not scale with the tempo map, so a long map cannot buy a real bug
 *     any slack.
 *
 * Neither constraint is what *proves* the two renderers agree. That is `--probe-no-pow`, which
 * renders a configuration with no transcendental call on the path at all and is required to be
 * **bit** exact; the envelope is only how the remaining configuration is allowed to differ once
 * that control has passed.
 */
const ULP_PER_TERM = 4;
const ABS_TOLERANCE_MS = 1e-6;

/**
 * Field classes the tempo/rubato transcendental path can reach. Everything else is bit-exact.
 * The `jsonl.*` classes are deliberately absent: the JSONL is compared against the very render
 * that produced it, so a difference there is a serialization defect, never a libm one.
 */
const LIBM_REACHABLE = new Set(['note.ms.date', 'note.ms.end', 'cc.position.ms', 'cc.channelVolume.ms']);

/** The piece's own term count: one Simpson integral per tempo instruction, plus rubato's warp. */
function ulpBudgetOf(rec) {
  const terms = 1 + (rec.tempo?.length ?? 0) + (rec.rubato?.length ? 1 : 0);
  return ULP_PER_TERM * terms;
}

const F64 = new DataView(new ArrayBuffer(8));

/**
 * Distance in representable doubles ("ULPs") between `a` and `b`, or Infinity if they are not
 * both finite. 1 means adjacent doubles — the granularity at which two correctly-rounded but
 * *different* `pow`/`log` implementations are allowed to disagree.
 */
function ulpDistance(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  const key = (x) => {
    F64.setFloat64(0, x);
    const bits = F64.getBigUint64(0);
    return bits & 0x8000000000000000n ? 0x8000000000000000n - (bits & 0x7fffffffffffffffn) : bits;
  };
  const d = key(a) - key(b);
  return Number(d < 0n ? -d : d);
}

class Diff {
  constructor() {
    this.fails = [];
    this.compared = 0;
    this.maxAbs = 0;
    this.maxUlp = 0;
    this.maxUlpRatio = 0; // observed ULP / the budget that allowed it — the headroom measure
    this.budget = 0; // per-piece, set by the caller before each piece
    this.byField = new Map(); // field class -> [compared, mismatched, outOfEnvelope]
  }
  /**
   * Compare one scalar. A field class in {@link LIBM_REACHABLE} is allowed the piece's derived
   * ULP budget *and* must stay within {@link ABS_TOLERANCE_MS}; every other class must be bit
   * exact (`Object.is`, so +0 !== -0).
   */
  eq(path, a, b, field) {
    this.compared++;
    const key = field ?? 'other';
    const s = this.byField.get(key) ?? [0, 0, 0];
    s[0]++;
    if (Object.is(a, b)) {
      this.byField.set(key, s);
      return true;
    }
    s[1]++;
    const numeric = typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b);
    const ulp = numeric ? ulpDistance(a, b) : Infinity;
    const abs = numeric ? Math.abs(a - b) : Infinity;
    const budget = LIBM_REACHABLE.has(key) ? this.budget : 0;
    const inEnvelope = ulp <= budget && abs <= ABS_TOLERANCE_MS;
    if (!inEnvelope) s[2]++;
    this.byField.set(key, s);
    if (Number.isFinite(ulp)) {
      this.maxUlp = Math.max(this.maxUlp, ulp);
      if (budget > 0) this.maxUlpRatio = Math.max(this.maxUlpRatio, ulp / budget);
    }
    if (numeric) this.maxAbs = Math.max(this.maxAbs, abs);
    if (!inEnvelope && this.fails.length < 12)
      this.fails.push(`${path}: ${a} !== ${b} (${ulp} ulp, budget ${budget}, |diff| ${abs})`);
    return false;
  }
  report() {
    return [...this.byField.entries()]
      .map(([k, [n, bad, beyond]]) => {
        const gate = LIBM_REACHABLE.has(k) ? 'out of envelope' : 'not bit-exact ';
        return `    ${k.padEnd(26)} ${String(n).padStart(8)} compared, ${String(bad).padStart(7)} differ, ${String(beyond).padStart(7)} ${gate}`;
      })
      .join('\n');
  }
  get mismatches() {
    return [...this.byField.values()].reduce((s, v) => s + v[1], 0);
  }
  get beyondUlp() {
    return [...this.byField.values()].reduce((s, v) => s + v[2], 0);
  }
}

const NOTE_FIELDS = ['note.date', 'note.duration', 'note.pitch', 'note.ms.date', 'note.ms.end', 'note.velocity', 'note.part'];

function compareRenders(d, tag, ts, java) {
  d.eq(`${tag}.parts.length`, ts.parts.length, java.parts.length, 'structure');
  for (let p = 0; p < Math.min(ts.parts.length, java.parts.length); p++) {
    const a = ts.parts[p];
    const b = java.parts[p];
    d.eq(`${tag}.p${p}.notes.length`, a.notes.length, b.notes.length, 'structure');
    for (let i = 0; i < Math.min(a.notes.length, b.notes.length); i++) {
      const x = a.notes[i];
      const y = b.notes[i];
      d.eq(`${tag}.p${p}.n${i}.id`, x.id, y.id, 'note.id');
      d.eq(`${tag}.p${p}.n${i}.date`, x.date, y.date, 'note.date');
      d.eq(`${tag}.p${p}.n${i}.duration`, x.duration, y.duration, 'note.duration');
      d.eq(`${tag}.p${p}.n${i}.pitch`, x.pitch, y.pitch, 'note.pitch');
      d.eq(`${tag}.p${p}.n${i}.velocity`, x.velocity, y.velocity, 'note.velocity');
      d.eq(`${tag}.p${p}.n${i}.ms.date`, x.milliseconds.date, y.milliseconds.date, 'note.ms.date');
      d.eq(`${tag}.p${p}.n${i}.ms.end`, x.milliseconds.end, y.milliseconds.end, 'note.ms.end');
    }
    d.eq(`${tag}.p${p}.cc.length`, a.controlChanges.length, b.controlChanges.length, 'structure');
    for (let s = 0; s < Math.min(a.controlChanges.length, b.controlChanges.length); s++) {
      const sa = a.controlChanges[s];
      const sb = b.controlChanges[s];
      const kind = sa.kind === 'position' ? 'cc.position' : 'cc.channelVolume';
      d.eq(`${tag}.p${p}.cc${s}.kind`, sa.kind, sb.kind, 'structure');
      d.eq(`${tag}.p${p}.cc${s}.controller`, sa.controller, sb.controller, 'structure');
      d.eq(`${tag}.p${p}.cc${s}.ccNumber`, sa.ccNumber, sb.ccNumber, 'structure');
      d.eq(`${tag}.p${p}.cc${s}.points`, sa.points.length, sb.points.length, 'structure');
      for (let i = 0; i < Math.min(sa.points.length, sb.points.length); i++) {
        d.eq(`${tag}.p${p}.cc${s}.pt${i}.date`, sa.points[i].date, sb.points[i].date, `${kind}.date`);
        d.eq(`${tag}.p${p}.cc${s}.pt${i}.ms`, sa.points[i].milliseconds, sb.points[i].milliseconds, `${kind}.ms`);
        d.eq(`${tag}.p${p}.cc${s}.pt${i}.value`, sa.points[i].value, sb.points[i].value, `${kind}.value`);
      }
    }
  }
}

/** The JSONL must be a lossless view of whichever render produced it. */
function compareJsonl(d, tag, rec, render) {
  const rows = [];
  for (const part of render.parts)
    for (const n of part.notes)
      rows.push([n.date, n.duration, n.pitch, n.milliseconds.date, n.milliseconds.end, n.velocity, part.index + 1]);
  d.eq(`${tag}.jsonl.notes.length`, rec.notes.length, rows.length, 'structure');
  for (let i = 0; i < Math.min(rec.notes.length, rows.length); i++)
    for (let k = 0; k < 7; k++) d.eq(`${tag}.jsonl.note${i}[${k}]`, rec.notes[i][k], rows[i][k], `jsonl.${NOTE_FIELDS[k]}`);

  const stream = render.parts[0].controlChanges.find((s) => s.kind === 'position' && s.controller === 'sustain');
  const cc = rec.sustain_cc ?? [];
  d.eq(`${tag}.jsonl.sustain_cc.length`, cc.length, stream ? stream.points.length : 0, 'structure');
  if (stream)
    for (let i = 0; i < Math.min(cc.length, stream.points.length); i++) {
      d.eq(`${tag}.jsonl.cc${i}.ms`, cc[i][0], stream.points[i].milliseconds, 'jsonl.sustain_cc.ms');
      // The JSONL carries the MIDI observable, `Math.round(value)` (Msm.java:1113), not the raw
      // positionMap double — so losslessness is checked against the rounded value.
      d.eq(`${tag}.jsonl.cc${i}.value`, cc[i][1], Math.round(stream.points[i].value), 'jsonl.sustain_cc.value');
      if (!Number.isInteger(cc[i][1])) d.eq(`${tag}.jsonl.cc${i}.integer`, cc[i][1], Math.round(cc[i][1]), 'jsonl.sustain_cc.value');
    }
}

// -------------------------------------------------------------------------------------------

async function cross(jsonlPath, dumpDir, jsonlFrom = 'espressivo') {
  const { performMsmToData } = await import(ESPRESSIVO);
  const records = readFileSync(jsonlPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  const manifest = records
    .map((r) => `${join(dumpDir, `piece${r.id}.msm`)}\t${join(dumpDir, `piece${r.id}.mpm`)}\t${join(dumpDir, `piece${r.id}_java.msm`)}`)
    .join('\n');
  const manifestPath = join(dumpDir, 'manifest.tsv');
  writeFileSync(manifestPath, manifest + '\n');

  process.stdout.write(`[java] rendering ${records.length} pieces with the meico fork …\n`);
  const tJava0 = Date.now();
  execFileSync('nice', ['-n', '15', 'java', '-cp', CP, 'RenderMpm', '--batch', manifestPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 28,
  });
  const tJava = Date.now() - tJava0;

  const d = new Diff();
  const budgets = [];
  const log = console.log;
  const err = console.error;
  let tsMs = 0;
  for (const rec of records) {
    const msm = readFileSync(join(dumpDir, `piece${rec.id}.msm`), 'utf8');
    const mpm = readFileSync(join(dumpDir, `piece${rec.id}.mpm`), 'utf8');
    console.log = () => {};
    console.error = () => {};
    const t0 = Date.now();
    const ts = performMsmToData({ msm, mpm });
    tsMs += Date.now() - t0;
    console.log = log;
    console.error = err;
    const java = readAugmentedMsm(readFileSync(join(dumpDir, `piece${rec.id}_java.msm`), 'utf8'));
    d.budget = ulpBudgetOf(rec);
    budgets.push(d.budget);
    compareRenders(d, `piece${rec.id}`, ts, java);
    compareJsonl(d, `piece${rec.id}`, rec, jsonlFrom === 'java' ? java : ts);
  }

  const notes = records.reduce((s, r) => s + r.notes.length, 0);
  const cc = records.reduce((s, r) => s + (r.sustain_cc ? r.sustain_cc.length : 0), 0);
  process.stdout.write(
    `pieces ${records.length} | notes ${notes} | sustain CC points (part 1) ${cc} | JSONL rendered by ${jsonlFrom}\n` +
      `scalar comparisons ${d.compared} | differing ${d.mismatches} | out of envelope ${d.beyondUlp} | ` +
      `max |diff| ${d.maxAbs} | max ulp ${d.maxUlp}\n` +
      `ulp budget ${ULP_PER_TERM}*(1 + #tempo + rubato?): min ${Math.min(...budgets)} max ${Math.max(...budgets)}; ` +
      `worst observed/budget ${d.maxUlpRatio.toFixed(3)}; |diff| tolerance ${ABS_TOLERANCE_MS} ms, worst ` +
      `${(d.maxAbs / ABS_TOLERANCE_MS).toExponential(2)} of it\n` +
      `${d.report()}\n` +
      `render time: espressivo ${tsMs} ms, java fork ${tJava} ms (incl. JVM startup)\n`,
  );
  for (const f of d.fails) process.stdout.write(`  FAIL ${f}\n`);
  if (d.beyondUlp) {
    process.stdout.write('CROSS_RENDERER_FAIL\n');
    return 1;
  }
  process.stdout.write(
    d.mismatches
      ? `CROSS_RENDERER_ULP_PASS (${d.mismatches} values differ, every one inside its piece's derived ` +
          `libm envelope and 1e${Math.round(Math.log10(d.maxAbs / ABS_TOLERANCE_MS))} of the magnitude ` +
          `tolerance — the fdlibm/libm pow-log divergence, LOG.md "Build-team wave 1"; no logic difference)\n`
      : 'CROSS_RENDERER_PASS (0-diff, bit level)\n',
  );
  return 0;
}

function v3compat(nodePath, javaPath) {
  const a = readFileSync(nodePath, 'utf8').trim().split('\n');
  const b = readFileSync(javaPath, 'utf8').trim().split('\n');
  const d = new Diff();
  d.eq('lines', a.length, b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = JSON.parse(a[i]);
    const y = JSON.parse(b[i]);
    for (const key of ['id', 'ppq']) d.eq(`p${i}.${key}`, x[key], y[key], 'header');
    // `notes` is the *render*; the other four are the *sampling*. Reported separately so a
    // renderer defect can never be mistaken for a sampling-port defect.
    for (const key of ['notes', 'tempo', 'dynamics', 'articulation', 'rubato']) {
      const label = key === 'notes' ? 'render.notes' : `sampling.${key}`;
      d.eq(`p${i}.${key}.length`, (x[key] ?? []).length, (y[key] ?? []).length, label);
      const n = Math.min((x[key] ?? []).length, (y[key] ?? []).length);
      for (let r = 0; r < n; r++) {
        d.eq(`p${i}.${key}[${r}].length`, x[key][r].length, y[key][r].length, label);
        for (let c = 0; c < Math.min(x[key][r].length, y[key][r].length); c++)
          d.eq(`p${i}.${key}[${r}][${c}]`, x[key][r][c], y[key][r][c], label);
      }
    }
  }
  process.stdout.write(
    `v3-compat: ${a.length} node lines vs ${b.length} java lines | scalar comparisons ${d.compared} | ` +
      `differing ${d.mismatches} | max |diff| ${d.maxAbs}\n${d.report()}\n`,
  );
  for (const f of d.fails) process.stdout.write(`  FAIL ${f}\n`);
  process.stdout.write(d.mismatches ? 'V3_COMPAT_FAIL\n' : 'V3_COMPAT_PASS (0-diff, bit level)\n');
  return d.mismatches ? 1 : 0;
}

/**
 * The v3-compat proof, run end to end so that it is reproducible from one command.
 *
 * The proof used to be quoted as "node --v3-compat --renderer java vs java SampleAndRender at
 * the same seed", which does not reproduce: `SampleAndRender`'s optional `[maps]` argument
 * **defaults to tempo only**, so run literally, the comparison fails with thousands of
 * differences (java velocities all 100, three empty map arrays) and looks like a broken port.
 * The map list is part of the claim, so it lives in code here rather than in prose.
 */
function v3proof(n, seed, workDir) {
  mkdirSync(workDir, { recursive: true });
  const nodeOut = join(workDir, 'v3_node.jsonl');
  const javaOut = join(workDir, 'v3_java.jsonl');
  const maps = V3_MAPS.join(',');
  process.stdout.write(`[v3proof] ${n} pieces, seed ${seed}, maps ${maps}\n`);
  execFileSync('nice', ['-n', '15', 'java', '-cp', CP, 'SampleAndRender', javaOut, String(n), String(seed), maps], {
    stdio: ['ignore', 'ignore', 'pipe'],
    maxBuffer: 1 << 28,
  });
  execFileSync(
    'nice',
    ['-n', '15', 'node', join(HERE, 'generate_v4.mjs'), nodeOut, String(n), String(seed), '--v3-compat', '--renderer', 'java', '--maps', maps],
    { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 },
  );
  return v3compat(nodeOut, javaOut);
}

/**
 * Check the v4 canonical rules directly on the emitted JSONL — the sampler could satisfy them
 * by construction and still drift, and a downstream consumer only ever sees this file.
 * Also prints the realised sampling domain, which is what makes the "widened ranges" claim
 * checkable rather than asserted.
 */
function invariants(jsonlPath) {
  const recs = readFileSync(jsonlPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const bad = [];
  const fail = (id, msg) => bad.length < 20 && bad.push(`piece${id}: ${msg}`);
  const dp2 = (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;
  const dp1 = (v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9;
  const st = { beats: [], bpm: [], notesPerBeat: [], peakLocal: [], durs: new Map(), parts2: 0, withAsync: 0, withMov: 0, withRub: 0, movSeg: [], asyncOff: [], ccPts: [] };

  for (const r of recs) {
    const ppq = r.ppq;
    // The sampled piece length, not "wherever the last note happened to end". Deriving it from
    // the notes cannot distinguish a map that stops short of the piece from one that ends with
    // it, which is exactly how a lost movement terminator used to go unnoticed.
    if (typeof r.total_ticks !== 'number') fail(r.id, 'no total_ticks in the record');
    const totalTicks = r.total_ticks ?? Math.max(...r.notes.map((n) => n[0] + n[1]));
    const beats = totalTicks / ppq;
    st.beats.push(beats);
    st.notesPerBeat.push(r.notes.length / beats);
    // peak LOCAL density: the busiest one-beat window, which is what the dense-episode
    // widening is actually about (the piece average barely moves).
    const perBeat = new Map();
    for (const n of r.notes) {
      const w = Math.floor(n[0] / ppq);
      perBeat.set(w, (perBeat.get(w) ?? 0) + 1);
    }
    st.peakLocal.push(Math.max(...perBeat.values()));
    for (const n of r.notes) st.durs.set(n[1], (st.durs.get(n[1]) ?? 0) + 1);
    const parts = new Set(r.notes.map((n) => n[6]));
    if (parts.has(2)) st.parts2++;
    for (const p of parts) if (p !== 1 && p !== 2) fail(r.id, `note part number ${p}`);

    // G3/G4/G7/G8 on tempo; the same shape on dynamics. Movement has its own grid (M3) and its
    // own terminator rule (M1), so it is checked separately below.
    for (const [name, map] of [['tempo', r.tempo], ['dynamics', r.dynamics]]) {
      if (!map || !map.length) continue;
      if (map[0][0] !== 0) fail(r.id, `${name}: no instruction at date 0 (G3)`);
      if (map[map.length - 1][2] !== null) fail(r.id, `${name}: last instruction is a transition (G7)`);
      for (let i = 0; i < map.length; i++) {
        if (map[i][0] % ppq !== 0) fail(r.id, `${name}[${i}]: date ${map[i][0]} off the beat grid (G4)`);
        if (i && (map[i][0] - map[i - 1][0]) / ppq < 4) fail(r.id, `${name}[${i}]: segment shorter than 4 beats`);
        // G8: two adjacent constants of equal value are one instruction, not two.
        if (i && map[i][2] === null && map[i - 1][2] === null && map[i][1] === map[i - 1][1])
          fail(r.id, `${name}[${i}]: adjacent equal constants not merged (G8)`);
      }
    }
    for (const t of r.tempo) {
      st.bpm.push(t[1]);
      if (t[2] !== null) st.bpm.push(t[2]);
      if (!dp1(t[1])) fail(r.id, `tempo bpm ${t[1]} not 1 decimal (G6)`);
      if (t[2] !== null && !dp1(t[2])) fail(r.id, `tempo transition.to ${t[2]} not 1 decimal (G6)`);
      if (t[2] !== null && Math.abs(Math.log2(t[2] / t[1])) < 0.15) fail(r.id, `tempo depth < 0.15 (T2)`);
      if (t[3] !== null && (t[3] < 0.15 || t[3] > 0.85)) fail(r.id, `meanTempoAt ${t[3]} outside [0.15,0.85] (T3)`);
      if (t[3] !== null && !dp2(t[3])) fail(r.id, `meanTempoAt ${t[3]} not 2 decimals (G6)`);
    }
    for (const dy of r.dynamics ?? []) {
      if (!dp1(dy[1])) fail(r.id, `dynamics volume ${dy[1]} not 1 decimal (G6)`);
      if (dy[2] !== null) {
        if (!dp1(dy[2])) fail(r.id, `dynamics transition.to ${dy[2]} not 1 decimal (G6)`);
        if (Math.abs(dy[2] - dy[1]) < 8) fail(r.id, `dynamics depth ${Math.abs(dy[2] - dy[1])} < 8 (D1)`);
        if (!dp2(dy[3]) || !dp2(dy[4])) fail(r.id, `dynamics curvature/protraction not 2 decimals (G6)`);
      } else if (dy[3] !== null || dy[4] !== null) fail(r.id, 'constant dynamics carries curve parameters');
    }
    // A6: articulationMaps are part-local, so every row carries its part and every date must
    // be an onset OF THAT PART. This is the invariant the pre-A6 global map violated on 80 %
    // of its rows while every other check here stayed green — the reason it is checked on the
    // JSONL rather than trusted from the sampler.
    const onsetsByPart = new Map();
    for (const n of r.notes) {
      const p = n[6] ?? 1;
      if (!onsetsByPart.has(p)) onsetsByPart.set(p, new Set());
      onsetsByPart.get(p).add(n[0]);
    }
    let prevArtic = null;
    for (const a of r.articulation ?? []) {
      if (a[1] >= 0.97 && a[1] <= 1.03) fail(r.id, `relativeDuration ${a[1]} inside the A2 deadband`);
      if (a[2] >= -2 && a[2] <= 2) fail(r.id, `velocityChange ${a[2]} inside the A3 deadband`);
      if (!Number.isInteger(a[2])) fail(r.id, `velocityChange ${a[2]} not an integer (A3/G6)`);
      if (a.length !== 4) {
        fail(r.id, `articulation row has ${a.length} fields, expected 4 (date,relDur,velChange,part) (A6)`);
        continue;
      }
      if (!onsetsByPart.has(a[3])) fail(r.id, `articulation on part ${a[3]}, which has no notes (A6)`);
      else if (!onsetsByPart.get(a[3]).has(a[0])) fail(r.id, `articulation date ${a[0]} is not an onset of part ${a[3]} (A6)`);
      // part-major, ascending within a part: the order the map is read back in.
      if (prevArtic && (a[3] < prevArtic[3] || (a[3] === prevArtic[3] && a[0] < prevArtic[0])))
        fail(r.id, `articulation rows not in (part, date) order at ${a[0]}/part ${a[3]}`);
      prevArtic = a;
    }
    if (r.rubato && r.rubato.length) {
      st.withRub++;
      for (let i = 0; i < r.rubato.length; i += 2) {
        const [d, f, inten, ls, ee, loop] = r.rubato[i];
        if (![720, 1440, 2880].includes(f)) fail(r.id, `rubato frameLength ${f} (R1)`);
        if (ls !== 0 || ee !== 1) fail(r.id, `rubato lateStart/earlyEnd ${ls}/${ee} (R2)`);
        if (loop !== 1) fail(r.id, `rubato loop ${loop} (R4)`);
        if (inten >= 0.89 && inten <= 1.12) fail(r.id, `rubato intensity ${inten} inside the R3 deadband`);
        const term = r.rubato[i + 1];
        if (!term || term[2] !== 1) fail(r.id, `rubato span at ${d} has no neutral terminator (R6)`);
        else if (term[1] !== f) fail(r.id, `rubato terminator at ${term[0]} has frameLength ${term[1]}, not ${f} (R6)`);
        else if ((term[0] - d) % f !== 0 || (term[0] - d) / ppq < 8) fail(r.id, `rubato span at ${d} violates R5`);
        else if (term[0] > totalTicks) fail(r.id, `rubato terminator at ${term[0]} is past the piece end ${totalTicks}`);
        for (const t of r.tempo)
          if (t[0] > d && term && t[0] < term[0] && (t[0] - d) % f !== 0) fail(r.id, `tempo date ${t[0]} inside a rubato frame (R8)`);
      }
    }
    if (r.asynchrony && r.asynchrony.length) {
      st.withAsync++;
      if (!parts.has(2)) fail(r.id, 'asynchronyMap without a part 2 (Y1)');
      if (r.asynchrony[0][0] !== 0) fail(r.id, 'asynchrony: no instruction at date 0 (G3/Y4)');
      if (r.asynchrony[0][1] <= 0) fail(r.id, `asynchrony date-0 offset ${r.asynchrony[0][1]} is not positive (Y5)`);
      for (let i = 0; i < r.asynchrony.length; i++) {
        const [d, off] = r.asynchrony[i];
        st.asyncOff.push(off);
        if (d % ppq !== 0) fail(r.id, `asynchrony date ${d} off the beat grid (Y4)`);
        if (d > totalTicks) fail(r.id, `asynchrony date ${d} past the piece end ${totalTicks}`);
        if (i && (d - r.asynchrony[i - 1][0]) / ppq < 4) fail(r.id, 'asynchrony segments closer than 4 beats (Y4)');
        if (!Number.isInteger(off)) fail(r.id, `asynchrony offset ${off} is not an integer (Y2)`);
        if (Math.abs(off) < 5 || Math.abs(off) > 60) fail(r.id, `asynchrony offset ${off} outside [5,60] ms (Y3)`);
        if (i && off === r.asynchrony[i - 1][1]) fail(r.id, 'adjacent equal asynchrony offsets (Y4/G8)');
      }
      if (r.asynchrony.length > 3) fail(r.id, `asynchrony has ${r.asynchrony.length} segments (> 3)`);
    }
    if (r.movement && r.movement.length) {
      st.withMov++;
      st.ccPts.push((r.sustain_cc ?? []).length);
      const mov = r.movement;
      const last = mov[mov.length - 1];
      // M1, in the three parts the render semantics force. `renderMovementToMap` skips the last
      // element, so the terminator must (a) exist at the piece end, (b) be a constant whose
      // position is the value already in force — anything else is a label with no footprint in
      // the CC stream — and (c) follow a *transition*, because a terminator after a constant is
      // a G8 duplicate of it and gets merged away, which is how chains used to stop short.
      if (mov.length < 2) fail(r.id, `movement chain of ${mov.length} instruction(s) has no terminator (M1)`);
      if (last[2] !== null) fail(r.id, 'movement: last instruction is a transition (M1)');
      if (last[0] !== totalTicks) fail(r.id, `movement chain ends at ${last[0]}, not at the piece end ${totalTicks} (M1)`);
      if (mov.length >= 2 && mov[mov.length - 2][2] === null)
        fail(r.id, 'movement terminator follows a constant: it is inert AND unmergeable (M1)');
      if (mov[0][0] !== 0) fail(r.id, 'movement: no instruction at date 0 (M2/G3)');
      let prevEnd = null;
      for (let i = 0; i < mov.length; i++) {
        const [d, pos, to, curv, prot, controller] = mov[i];
        const isTerminator = i === mov.length - 1;
        if (i) st.movSeg.push(d - mov[i - 1][0]); // ticks: the M3 grid is sub-beat
        if (mov[i].length !== 6) fail(r.id, `movement[${i}] has ${mov[i].length} fields, expected 6`);
        if (controller !== 'sustain' && controller !== 'soft') fail(r.id, `movement controller ${controller} (M7)`);
        if (d % MOVEMENT_GRID !== 0) fail(r.id, `movement[${i}]: date ${d} off the 1/4-beat grid (M3)`);
        if (i && d - mov[i - 1][0] < MOVEMENT_GRID)
          fail(r.id, `movement[${i}]: segment ${d - mov[i - 1][0]} ticks shorter than ${MOVEMENT_GRID} (M3)`);
        // M4: the canonical alphabet is round(127*p)/127, and the rewrite is idempotent.
        for (const [what, v] of [['position', pos], ['transition.to', to]]) {
          if (v === null) continue;
          if (v < 0 || v > 1) fail(r.id, `movement ${what} ${v} outside [0,1] (M4)`);
          if (Math.round(CC_MAX * v) / CC_MAX !== v) fail(r.id, `movement ${what} ${v} off the CC alphabet (M4)`);
        }
        if (to !== null) {
          const depthCC = Math.abs(Math.round(CC_MAX * to) - Math.round(CC_MAX * pos));
          if (depthCC === 0) fail(r.id, 'degenerate movement transition (M5)');
          if (depthCC < MOV_DEPTH_CC) fail(r.id, `movement depth ${depthCC} < ${MOV_DEPTH_CC} CC units`);
          if (curv < 0 || curv > 0.9 || !dp2(curv)) fail(r.id, `movement curvature ${curv} (M9)`);
          if (prot < -0.7 || prot > 0.7 || !dp2(prot)) fail(r.id, `movement protraction ${prot} (M9)`);
        } else if (curv !== null || prot !== null) fail(r.id, 'constant movement carries curve parameters');
        if (isTerminator) {
          if (pos !== prevEnd) fail(r.id, `movement terminator position ${pos} != the value in force ${prevEnd} (M1)`);
        } else if (prevEnd !== null && pos !== prevEnd) {
          const jumpCC = Math.abs(Math.round(CC_MAX * pos) - Math.round(CC_MAX * prevEnd));
          if (jumpCC < MOV_JUMP_CC) fail(r.id, `movement jump ${jumpCC} CC units inside the continuity deadband`);
        }
        // G8 applies uniformly — no terminator exemption, by construction (M1(c)).
        if (i && to === null && mov[i - 1][2] === null && pos === mov[i - 1][1])
          fail(r.id, `movement[${i}]: adjacent equal constants not merged (G8)`);
        prevEnd = to === null ? pos : to;
      }
      for (const [ms, v] of r.sustain_cc ?? []) {
        // The MIDI observable: integers 0..127, the same alphabet the real Vienna streams use.
        if (!Number.isInteger(v) || v < 0 || v > CC_MAX) fail(r.id, `sustain_cc value ${v} is not an integer CC (M4)`);
        if (!Number.isFinite(ms) || ms < 0) fail(r.id, `sustain_cc ms ${ms}`);
      }
    } else if (r.sustain_cc && r.sustain_cc.length) {
      fail(r.id, 'sustain_cc without a movementMap');
    }
  }

  const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  process.stdout.write(
    `invariants over ${recs.length} pieces: ${bad.length ? bad.length + ' VIOLATIONS' : 'all canonical rules hold'}\n` +
      bad.map((b) => `  ${b}\n`).join('') +
      `realised domain:\n` +
      `    piece length beats   min ${Math.min(...st.beats)} median ${q(st.beats, 0.5)} max ${Math.max(...st.beats)}\n` +
      `    bpm literals         min ${Math.min(...st.bpm)} median ${q(st.bpm, 0.5)} max ${Math.max(...st.bpm)} (n=${st.bpm.length})\n` +
      `    notes per beat       piece mean: min ${q(st.notesPerBeat, 0).toFixed(2)} median ${q(st.notesPerBeat, 0.5).toFixed(2)} max ${q(st.notesPerBeat, 1).toFixed(2)}; ` +
      `busiest 1-beat window: median ${q(st.peakLocal, 0.5)} max ${Math.max(...st.peakLocal)}\n` +
      `    note durations       ${[...st.durs.entries()].sort((a, b) => a[0] - b[0]).map(([d, n]) => `${d}:${n}`).join(' ')}\n` +
      `    2-part pieces        ${st.parts2}/${recs.length}; with asynchrony ${st.withAsync}; with movement ${st.withMov}; with rubato ${st.withRub}\n` +
      (st.movSeg.length
        ? `    movement segments    min ${Math.min(...st.movSeg)} median ${q(st.movSeg, 0.5)} max ${Math.max(...st.movSeg)} ticks ` +
          `(n=${st.movSeg.length}, 1/4 beat = ${MOVEMENT_GRID}); sustain CC points/piece median ${q(st.ccPts, 0.5)} total ${sum(st.ccPts)}\n`
        : '') +
      (st.asyncOff.length
        ? `    asynchrony offsets   min ${Math.min(...st.asyncOff)} max ${Math.max(...st.asyncOff)} ms, n=${st.asyncOff.length}\n`
        : ''),
  );
  process.stdout.write(bad.length ? 'INVARIANTS_FAIL\n' : 'INVARIANTS_PASS\n');
  return bad.length ? 1 : 0;
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'cross') process.exitCode = await cross(rest[0], rest[1], rest[2] ?? 'espressivo');
else if (mode === 'v3compat') process.exitCode = v3compat(rest[0], rest[1]);
else if (mode === 'v3proof') process.exitCode = v3proof(parseInt(rest[0], 10), rest[1], rest[2]);
else if (mode === 'invariants') process.exitCode = invariants(rest[0]);
else {
  process.stderr.write(
    'usage: verify_v4.mjs cross <pilot.jsonl> <dumpDir> [espressivo|java]\n' +
      '       verify_v4.mjs v3proof <numPieces> <seed> <workDir>   (runs both generators itself)\n' +
      '       verify_v4.mjs v3compat <node.jsonl> <java.jsonl>\n' +
      '       verify_v4.mjs invariants <pilot.jsonl>\n',
  );
  process.exitCode = 2;
}
