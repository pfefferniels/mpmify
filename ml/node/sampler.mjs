/**
 * Canonical-form MPM samplers for the v4 synthetic-data generator.
 *
 * Every sampler in the "v3 core" block below is a *faithful port* of the corresponding
 * method in `ml/java/SampleAndRender.java`: same draw order, same rejection loops, same
 * short-circuit evaluation (a `&&` whose left side is false must NOT consume a draw). Run
 * `generate_v4.mjs --v3-compat` against the Java generator with the same seed to prove it —
 * both emit byte-comparable v3 JSONL (see `verify_v4.mjs --v3-compat`).
 *
 * The normative reference for EVERY rule cited here is `ml/CANONICAL.md`: the G, T, D, A and R
 * rules of §2–§4, and v4's movement (**M1–M10**, §9) and asynchrony (**Y1–Y6**, §10). The rule
 * ids used below are CANONICAL's; the earlier private MV/AS numbering is gone, and so are the
 * four places where it disagreed with the document (M3's 1/4-beat grid, M4's 128-value CC
 * alphabet, M9's default-omission, Y3's [5,60] ms range) — see the changelog at the file end.
 */
import { jrint, jround } from './java_random.mjs';

export const PPQ = 720;

export const round1 = (v) => jround(v * 10.0) / 10.0;
export const round2 = (v) => jround(v * 100.0) / 100.0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** `pick(double[] p)` — accumulate in array order, exactly as the Java version does. */
function pick(rng, p) {
  const r = rng.nextDouble();
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    acc += p[i];
    if (r < acc) return i;
  }
  return p.length - 1;
}

function logUniform(rng, lo, hi) {
  return Math.exp(Math.log(lo) + rng.nextDouble() * (Math.log(hi) - Math.log(lo)));
}

// ===========================================================================================
// v3 core — ported 1:1 from SampleAndRender.java
// ===========================================================================================

/** `sampleScore` (v3 domain): single voice, {180,360,720,1440} grid, 8% rests, 15% chords. */
export function sampleScoreV3(rng, totalTicks) {
  const notes = [];
  const durs = [180, 360, 720, 1440];
  const durP = [0.2, 0.4, 0.3, 0.1];
  let pitch = 48 + rng.nextInt(24);
  let t = 0;
  while (t < totalTicks) {
    let dur = durs[pick(rng, durP)];
    if (t + dur > totalTicks) dur = totalTicks - t;
    if (dur < 180) break;
    if (rng.nextDouble() < 0.08) {
      t += dur;
      continue;
    }
    const chordSize = rng.nextDouble() < 0.15 ? 2 + rng.nextInt(3) : 1;
    for (let c = 0; c < chordSize; c++) {
      const p = clamp(pitch + (c === 0 ? 0 : 3 + rng.nextInt(9)), 30, 96);
      notes.push({ date: t, dur, pitch: p, part: 1 });
    }
    pitch = clamp(pitch + (rng.nextInt(15) - 7), 36, 90);
    t += dur;
  }
  return notes;
}

/**
 * `sampleTempoMap`. `cfg = {bpmLo, bpmHi, segMin, segSpan}`; the draw order is independent of
 * cfg, so the same function serves v3 (40/200/4/13) and v4 (25/240/4/variable).
 */
export function sampleTempoMap(rng, totalTicks, cfg) {
  const boundaries = [];
  const totalBeats = totalTicks / PPQ;
  for (let beat = 0; beat < totalBeats; beat += cfg.segMin + rng.nextInt(cfg.segSpan))
    boundaries.push(beat * PPQ);

  const instrs = [];
  let prevEnd = NaN;
  for (let i = 0; i < boundaries.length; i++) {
    const ti = { date: boundaries[i], bpm: 0, transitionTo: null, meanTempoAt: null };
    const cont = !Number.isNaN(prevEnd) && rng.nextDouble() < 0.6;
    ti.bpm = cont ? prevEnd : round1(logUniform(rng, cfg.bpmLo, cfg.bpmHi));
    const lastOne = i === boundaries.length - 1;
    const transition = !lastOne && rng.nextDouble() < 0.5; // G7: the last one is constant
    if (transition) {
      let to;
      do {
        to = round1(logUniform(rng, cfg.bpmLo, cfg.bpmHi));
      } while (Math.abs(Math.log(to / ti.bpm) / Math.log(2)) < 0.15); // T2
      ti.transitionTo = to;
      ti.meanTempoAt = round2(0.15 + rng.nextDouble() * 0.7); // T3
      prevEnd = to;
    } else {
      prevEnd = ti.bpm;
    }
    if (instrs.length) {
      const last = instrs[instrs.length - 1];
      if (last.transitionTo === null && ti.transitionTo === null && last.bpm === ti.bpm) continue; // G8
    }
    instrs.push(ti);
  }
  return instrs;
}

/** `sampleDynamicsMap`. `cfg = {volLo, volSpan, segMin, segSpan}`. */
export function sampleDynamicsMap(rng, totalTicks, cfg) {
  const boundaries = [];
  const totalBeats = totalTicks / PPQ;
  for (let beat = 0; beat < totalBeats; beat += cfg.segMin + rng.nextInt(cfg.segSpan))
    boundaries.push(beat * PPQ);

  const instrs = [];
  let prevEnd = NaN;
  for (let i = 0; i < boundaries.length; i++) {
    const di = { date: boundaries[i], volume: 0, transitionTo: null, curvature: null, protraction: null };
    const cont = !Number.isNaN(prevEnd) && rng.nextDouble() < 0.6;
    di.volume = cont ? prevEnd : round1(cfg.volLo + rng.nextDouble() * cfg.volSpan);
    const lastOne = i === boundaries.length - 1;
    const transition = !lastOne && rng.nextDouble() < 0.5;
    if (transition) {
      let to;
      do {
        to = round1(cfg.volLo + rng.nextDouble() * cfg.volSpan);
      } while (Math.abs(to - di.volume) < 8.0); // D1
      di.transitionTo = to;
      di.curvature = round2(rng.nextDouble() * 0.9);
      di.protraction = round2(rng.nextDouble() * 1.4 - 0.7);
      prevEnd = to;
    } else {
      prevEnd = di.volume;
    }
    if (instrs.length) {
      const last = instrs[instrs.length - 1];
      if (last.transitionTo === null && di.transitionTo === null && last.volume === di.volume) continue;
    }
    instrs.push(di);
  }
  return instrs;
}

function sampleArticulation(rng, date) {
  let relDur, velChange;
  do {
    relDur = round2(0.4 + rng.nextDouble() * 0.75); // A2
  } while (relDur >= 0.97 && relDur <= 1.03);
  do {
    velChange = jrint(-25.0 + rng.nextDouble() * 50.0); // A3/G6: integer
  } while (velChange >= -2.0 && velChange <= 2.0);
  return { date, relDur, velChange };
}

/**
 * `sampleArticulationMap` (A1/A4): one instruction on ~15% of the *distinct onset dates*.
 * `dates` must be the ascending, de-duplicated onset dates — in v4 that is the union over
 * both parts, because the map is global and meico applies it to every part.
 */
export function sampleArticulationMap(rng, dates) {
  const out = [];
  for (const d of dates) {
    if (rng.nextDouble() >= 0.15) continue;
    out.push(sampleArticulation(rng, d));
  }
  return out;
}

/** `sampleRubatoMap` — R1..R8, including the anti-skew "frame first" span-length draw. */
export function sampleRubatoMap(rng, totalTicks, tempi) {
  const out = [];
  const totalBeats = totalTicks / PPQ;
  const roll = rng.nextDouble();
  let nSpans = roll < 0.5 ? 1 : roll < 0.65 ? 2 : 0;
  if (nSpans === 0) return out;
  if (totalBeats < 8) return out;
  if (nSpans === 2 && totalBeats < 17) nSpans = 1;

  const s = [0, 0];
  const len = [0, 0];
  const frame = [0, 0];
  let ok = false;
  for (let attempt = 0; attempt < 100 && !ok; ++attempt) {
    const frameCand = [720, 1440, 2880];
    for (let i = 0; i < nSpans; ++i) {
      const f = frameCand[rng.nextInt(3)];
      const fBeats = f / PPQ;
      const minMult = Math.floor((8 + fBeats - 1) / fBeats); // >= 8 beats (R5)
      const maxMult = Math.floor(24 / fBeats);
      len[i] = fBeats * (minMult + rng.nextInt(maxMult - minMult + 1));
      frame[i] = f;
    }
    if (nSpans === 1) {
      if (len[0] > totalBeats) continue;
      s[0] = rng.nextInt(totalBeats - len[0] + 1);
    } else {
      const slack = totalBeats - len[0] - len[1] - 1;
      if (slack < 0) continue;
      const a = rng.nextInt(slack + 1);
      const b = rng.nextInt(slack - a + 1);
      s[0] = a;
      s[1] = a + len[0] + 1 + b;
    }
    ok = true;
    for (let i = 0; i < nSpans; ++i) {
      const startTick = s[i] * PPQ;
      const endTick = (s[i] + len[i]) * PPQ;
      let good = true;
      for (const ti of tempi) {
        if (ti.date > startTick && ti.date < endTick && (ti.date - startTick) % frame[i] !== 0) {
          good = false; // R8
          break;
        }
      }
      if (!good) {
        ok = false;
        break;
      }
    }
  }
  if (!ok) return out;

  for (let i = 0; i < nSpans; ++i) {
    const startTick = s[i] * PPQ;
    const endTick = (s[i] + len[i]) * PPQ;
    let intensity;
    do {
      intensity = round2(logUniform(rng, 0.45, 2.2)); // R3 with the [0.89,1.12] deadband
    } while (intensity >= 0.89 && intensity <= 1.12);
    out.push({ date: startTick, frameLength: frame[i], intensity, lateStart: 0.0, earlyEnd: 1.0, loop: true });
    // R6: neutral terminator, frameLength inherited, loop=true
    out.push({ date: endTick, frameLength: frame[i], intensity: 1.0, lateStart: 0.0, earlyEnd: 1.0, loop: true });
  }
  return out;
}

// ===========================================================================================
// v4 additions
// ===========================================================================================

/**
 * v4 part-1 score. Widened vs v3 (all deltas reported by `generate_v4.mjs --print-domain`):
 *  - rhythm grid gains 90 (32nd) and 540 (dotted 8th) ticks
 *  - "dense episodes": short runs restricted to {90,180} → up to 8 notes/beat
 *  - chord probability 0.15 → 0.18, chord size 2..4 unchanged
 */
export function sampleScoreV4Part1(rng, totalTicks, cfg) {
  const notes = [];
  const durs = [90, 180, 360, 540, 720, 1440];
  const durP = [0.08, 0.2, 0.32, 0.1, 0.22, 0.08];
  const denseDurs = [90, 180];
  const denseP = [0.6, 0.4];
  let pitch = 48 + rng.nextInt(24);
  let t = 0;
  let denseLeft = 0;
  while (t < totalTicks) {
    if (denseLeft <= 0 && rng.nextDouble() < cfg.denseStart) denseLeft = (1 + rng.nextInt(2)) * PPQ;
    let dur = denseLeft > 0 ? denseDurs[pick(rng, denseP)] : durs[pick(rng, durP)];
    if (denseLeft > 0) denseLeft -= dur;
    if (t + dur > totalTicks) dur = totalTicks - t;
    if (dur < 90) break;
    if (rng.nextDouble() < 0.08) {
      t += dur;
      continue;
    }
    const chordSize = rng.nextDouble() < 0.18 ? 2 + rng.nextInt(3) : 1;
    for (let c = 0; c < chordSize; c++) {
      const p = clamp(pitch + (c === 0 ? 0 : 3 + rng.nextInt(9)), 30, 96);
      notes.push({ date: t, dur, pitch: p, part: 1 });
    }
    pitch = clamp(pitch + (rng.nextInt(15) - 7), 36, 90);
    t += dur;
  }
  return notes;
}

/** v4 part 2: a bass line — lower register, sparser rhythm, occasional two-note chords. */
export function sampleScoreV4Part2(rng, totalTicks) {
  const notes = [];
  const durs = [360, 720, 1440, 2880];
  const durP = [0.1, 0.3, 0.4, 0.2];
  let pitch = 34 + rng.nextInt(14); // 34..47
  let t = 0;
  while (t < totalTicks) {
    let dur = durs[pick(rng, durP)];
    if (t + dur > totalTicks) dur = totalTicks - t;
    if (dur < 360) break;
    if (rng.nextDouble() < 0.12) {
      t += dur;
      continue;
    }
    const chordSize = rng.nextDouble() < 0.1 ? 2 : 1;
    for (let c = 0; c < chordSize; c++) {
      const p = clamp(pitch + (c === 0 ? 0 : 5 + rng.nextInt(8)), 24, 60);
      notes.push({ date: t, dur, pitch: p, part: 2 });
    }
    pitch = clamp(pitch + (rng.nextInt(11) - 5), 28, 52);
    t += dur;
  }
  return notes;
}

/**
 * asynchronyMap — v4, **part 2 only** (CANONICAL Y1: part 1 defines the timeline, so part 2's
 * offset is identifiable as a *relative* lead/lag rather than an unobservable rigid shift).
 *
 * Y2  offsets are INTEGER milliseconds, constant between instruction dates.
 * Y3  |offset| in [5,60] ms — deadband (-5,5). 5 ms is CANONICAL's observability floor and
 *     ~3 standard errors of the real quantity; 60 ms is the p90 of the measured Vienna
 *     per-window lead with headroom.
 * Y4  dates on the beat grid (G4), first at date 0 (G3), segments >= 4 beats, at most 3
 *     segments, adjacent equal offsets merged (G8). No terminator exists or is needed.
 * Y5  the offset in force at the part's first onset must not clamp:
 *     `AsynchronyMap.renderAsynchronyToMap` writes `Math.max(0.0, date + offset)`
 *     (AsynchronyMap.java:139), so a negative date-0 offset is silently truncated for every
 *     onset below |offset| and the label stops being recoverable. This sampler takes
 *     CANONICAL's recommended branch — part 1 is the leading voice, part 2's date-0 offset is
 *     positive — which also matches all 40 measured Vienna windows. Later segments start at
 *     beat >= 4, i.e. >= 1000 ms even at the fastest sampled tempo, so they carry either sign.
 */
export function sampleAsynchronyMap(rng, totalTicks) {
  const out = [];
  const totalBeats = totalTicks / PPQ;
  const nSeg = 1 + rng.nextInt(3);
  const boundaries = [0];
  let b = 0;
  for (let i = 1; i < nSeg; i++) {
    b += 4 + rng.nextInt(9); // 4..12 beats (Y4)
    if (b >= totalBeats) break;
    boundaries.push(b);
  }
  let prev = null;
  for (const beat of boundaries) {
    const mag = 5 + rng.nextInt(56); // 5..60 ms (Y3)
    const off = beat === 0 ? mag : rng.nextDouble() < 0.5 ? -mag : mag; // Y5 on the first
    if (prev !== null && off === prev) continue; // Y4/G8
    out.push({ date: beat * PPQ, msOffset: off });
    prev = off;
  }
  return out;
}

// --- movementMap constants (CANONICAL §9) --------------------------------------------------

/** M3: the 1/4-beat grid, in ticks. Boundaries are multiples of it and segments are >= it. */
export const MOVEMENT_GRID = 180;
/** M4: the canonical position alphabet is `k/127`, k an integer CC value in 0..127. */
export const CC_MAX = 127;
/** M9: meico's `MovementData` field defaults; writing them is a pure alias for omitting them. */
export const MOVEMENT_DEFAULT_CURVATURE = 0.4;
export const MOVEMENT_DEFAULT_PROTRACTION = 0.0;
/** Segment lengths in 1/4-beat units and their probabilities (mean 5.0 = 1.25 beats). */
const MOV_SEG_Q = [1, 2, 3, 4, 6, 8, 12, 16];
const MOV_SEG_P = [0.1, 0.16, 0.16, 0.18, 0.14, 0.12, 0.08, 0.06];
/** A transition moves >= 19 CC units (0.15 in position units) — M5's non-degeneracy with room. */
export const MOV_DEPTH_CC = 19;
/** A non-continuous boundary moves >= 13 CC units (0.10): an observable pedal change. */
export const MOV_JUMP_CC = 13;

/** M4: integer CC value -> canonical position. `round(127 * (k/127)) === k` for every k. */
export const ccPosition = (k) => k / CC_MAX;

/**
 * movementMap — v4 sustain pedal, per CANONICAL §9.
 *
 * M1  the chain is closed by a **terminator**: a final constant at the chain end date, which is
 *     the piece end. `MovementMap.renderMovementToMap` iterates `movementIndex < size()-1`, so
 *     the last instruction never renders and only supplies the previous one's end date — the
 *     movement analogue of G7/R6.
 *
 *     Two further properties are *forced* by that, and the first cut of this sampler had
 *     neither, which is why 32/60 of its pieces carried a label with no footprint in the render
 *     at all and 24/60 had no terminator left:
 *      (a) **the terminator is neutral**: its `position` is the value already in force, never a
 *          fresh draw. A drawn one is unlearnable — nothing in the CC stream depends on it.
 *      (b) **the element before it is always a transition**. Suppose it were a constant. Then
 *          the terminator's position must equal it (by (a)), and two adjacent equal constants
 *          are one instruction under G8 — so either the terminator is deleted (chain stops
 *          short, ramps lose their end date) or G8 needs an exemption written for it. Both were
 *          tried; the way out is that the *last rendering* element is a ramp, which makes the
 *          terminator's date observable (it ends that ramp), its position determined, and G8
 *          exemption-free. It also makes CANONICAL §12's step 16 — "append a terminator if the
 *          last instruction has a `transition.to`" — a fixed point instead of a contradiction.
 * M2  first instruction at date 0 with an explicit position (G3).
 * M3  dates on the 1/4-beat grid (multiples of 180 ticks), every segment >= 180 ticks. Below
 *     that, `MovementData.getTForDate`'s 1-tick x-tolerance costs more than a CC step, so
 *     curvature/protraction stop meaning anything. G4 (integer beats) does NOT apply here.
 * M4  `position` and `transition.to` live on the 128-value alphabet `round(127*p)/127`; the
 *     observable is `Math.round(127*p)` in `Msm.parsePositionMap`, so anything finer is
 *     unfalsifiable.
 * M5  no degenerate transitions — enforced by the >= 19 CC depth floor.
 * M6  `position` explicit on every instruction (inheritance is unusable in the fork).
 * M7  controller "sustain" only in v4 (both "sustain" and "soft" are legal; every other string
 *     silently renders as CC 0).
 * M9  curvature in [0,0.9], protraction in [-0.7,0.7], 2 decimals; **written only when they
 *     differ from meico's defaults 0.4/0.0** — that omission happens in `xml.mjs`, since the
 *     rendered result is identical either way and the sampled value is what the label reports.
 * M10 `movementSampleMaxStep` stays at the fork default 0.1.
 *
 * Continuity: 60 % of boundaries carry the previous segment's end value over; the rest jump by
 * >= 13 CC units, a discontinuity directly observable as two CC values on one millisecond.
 */
export function sampleMovementMap(rng, totalTicks) {
  // M3 + M1: grid-aligned boundaries, then a terminator at the chain end date (the piece end).
  const boundaries = [];
  for (let t = 0; t < totalTicks; t += MOV_SEG_Q[pick(rng, MOV_SEG_P)] * MOVEMENT_GRID) boundaries.push(t);
  while (boundaries.length > 1 && totalTicks - boundaries[boundaries.length - 1] < MOVEMENT_GRID)
    boundaries.pop();
  if (!boundaries.length || totalTicks - boundaries[0] < MOVEMENT_GRID) return [];

  const out = [];
  let prevEndK = null;
  for (let i = 0; i < boundaries.length; i++) {
    let k;
    if (prevEndK !== null && rng.nextDouble() < 0.6) {
      k = prevEndK;
    } else {
      do {
        k = rng.nextInt(CC_MAX + 1); // M4
      } while (prevEndK !== null && Math.abs(k - prevEndK) < MOV_JUMP_CC);
    }
    const mv = {
      date: boundaries[i],
      position: ccPosition(k),
      transitionTo: null,
      curvature: null,
      protraction: null,
      controller: 'sustain', // M7
    };
    // `||` short-circuits left-to-right, so the coin is drawn either way: the forced transition
    // on the last rendering element (M1(b)) does not shift the RNG stream.
    if (rng.nextDouble() < 0.55 || i === boundaries.length - 1) {
      let k2;
      do {
        k2 = rng.nextInt(CC_MAX + 1);
      } while (Math.abs(k2 - k) < MOV_DEPTH_CC); // M5
      mv.transitionTo = ccPosition(k2);
      mv.curvature = round2(rng.nextDouble() * 0.9); // M9
      mv.protraction = round2(rng.nextDouble() * 1.4 - 0.7);
      prevEndK = k2;
    } else {
      prevEndK = k;
    }
    if (out.length) {
      const last = out[out.length - 1];
      if (last.transitionTo === null && mv.transitionTo === null && last.position === mv.position) continue; // G8
    }
    out.push(mv);
  }
  // M1 terminator: neutral, at the chain end, closing the ramp that precedes it by construction.
  out.push({
    date: totalTicks,
    position: ccPosition(prevEndK),
    transitionTo: null,
    curvature: null,
    protraction: null,
    controller: 'sustain',
  });
  return out;
}

/**
 * metricalAccentuationMap — **flag-gated, default OFF** (`--with-accentuation`).
 *
 * The v4 program gate was that accentuation *supervision data* may only be generated once
 * meico-ts' TD3 (the `getAccentuationAt` segment-end fix, Java side meico@1d662105) has landed
 * on both renderers. TD3 has landed and the cross-renderer check on this sampler's output is
 * bit-exact (see ESPRESSIVO_DEFECTS E3 in generate_v4.mjs), so the technical condition is met;
 * the flag stays default-off because *whether* to generate the data is a program decision.
 *
 * One accentuationPatternDef of `beatsPerMeasure` anchors (beat 1..n, 1-based as
 * `MetricalAccentuationMap.renderMetricalAccentuationToMap` computes it), value in [-1,1] at
 * 2 decimals, transition.from=0 / transition.to=1 so the multi-anchor interpolation that TD3
 * fixed is actually exercised; one `accentuationPattern` at date 0, `loop`/`stickToMeasures`
 * true, `scale` in [2,15] at 1 decimal.
 */
export function sampleAccentuation(rng, beatsPerMeasure) {
  const anchors = [];
  for (let i = 0; i < beatsPerMeasure; i++)
    anchors.push({ beat: i + 1, value: round2(rng.nextDouble() * 2 - 1), from: 0.0, to: 1.0 });
  const scale = round1(2 + rng.nextDouble() * 13);
  return { length: beatsPerMeasure, anchors, scale };
}

/**
 * ## Changelog — reconciliation with CANONICAL.md §9/§10 (2026-08-09)
 *
 * The first cut of this file carried its own `MV*`/`AS*` numbering, written before
 * `CANONICAL.md` §9/§10 landed. Four of those rules were not merely differently named, they
 * **disagreed** with the document, and the shipped pilot was off-domain in consequence. All
 * four are now the document's:
 *
 * | was | is | why the document wins |
 * |---|---|---|
 * | MV1 2-decimal positions in [0,1] | **M4** `round(127·p)/127` | the observable is `Math.round(127·p)`; off-alphabet positions are unfalsifiable and make the label finer than the data |
 * | MV2 whole-beat grid, segments >= 2 beats | **M3** 1/4-beat grid (180 ticks), segments >= 180 ticks | a beat grid cannot express a sub-beat pedal change, which is most of real pedalling; 180 ticks is where the renderer's own inversion error drops below one CC step |
 * | MV6 always writes curvature/protraction | **M9** omit when equal to 0.4/0.0 | writing the `MovementData` default is a pure alias (G8's argument, one level down) |
 * | AS2 |offset| in [8,80] ms | **Y3** [5,60] ms, deadband (-5,5) | 5 ms is the document's observability floor throughout; 60 ms is the measured p90 lead with headroom |
 *
 * Two of the old rules survive with the document's names and stronger content: `AS3` is `Y5`
 * (unchanged), and `MV3` is `M1` — but M1's terminator is now *neutral* (its position is the
 * value already in force) and *unmergeable*, which is what makes the movement chain reach the
 * piece end and stops the terminator from being an unlearnable label.
 */
