/**
 * Era-conditioned interpretation samplers for the real-repertoire corpus.
 *
 * Layered over `ml/node/sampler.mjs`'s conventions — same `JavaRandom` stream, same
 * canonical-form vocabulary, same JSONL schema — but the score is no longer sampled: it comes
 * from `build_msm.mjs`, and the interpretation is conditioned on the piece's **era**.
 *
 * ## The rule that governs this file
 *
 * **Nothing here relaxes a rule of `ml/CANONICAL.md`.** Every G, T, D, A, R, M and Y rule
 * holds for every era; what varies is the *distribution inside* each rule — which segment
 * lengths, which depths, which probabilities, which sign. That is a deliberate constraint and
 * not a lack of ambition: the normal form is what makes the inverse problem well posed
 * (CANONICAL §0), and a per-era exception to it would make "the model learned baroque" and
 * "the model learned a different normal form" indistinguishable.
 *
 * The brief for this work explicitly offered latitude — widen rubato's `lateStart`/`earlyEnd`
 * and the frame alphabet for romantic playing, *if* an identifiability argument comes with it.
 * **The offer is declined for `lateStart`/`earlyEnd`, and taken (within R1) for frames.** The
 * argument, in full, because declining an offer needs one as much as accepting it does:
 *
 *   R2 pins `lateStart = 0, earlyEnd = 1`, which makes every frame boundary a fixed point of
 *   the warp, so a rubato span has **zero net tick displacement** at the frame grid
 *   (CANONICAL H2). Move `lateStart` off 0 and the whole frame translates — and a constant
 *   translation of a span of onsets is *exactly* what an asynchrony instruction is (Y1-Y3) and
 *   what a tempo instruction can absorb (H1). The three bands stop being disjoint, and they
 *   stop being disjoint in the one direction that matters here: romantic playing is the era
 *   where all three are simultaneously active and large, so it is the era where an alias
 *   between them costs the most. There is a second, mechanical reason: the v3 DSL production
 *   `U date F frame I intensity X endDate` has **no slots** for `lateStart`/`earlyEnd`
 *   (CANONICAL §5), so a span outside 0/1 is not representable in the training target at all —
 *   it would be a label the decoder cannot emit and the evaluator cannot score. Widening would
 *   mean vocabulary v5, a re-freeze (LOG.md B1), and a re-derivation of H2. None of that is
 *   justified by an era prior. What romantic playing *does* need — deeper, slower, longer
 *   rubato — is fully expressible inside R1/R3/R5 by choosing the 2- and 4-beat frames and the
 *   far tails of the intensity range, which is what `ERA_RANGES.romantic.rubato` does.
 *
 * ## What each era is, as ranges
 *
 * Every number in `ERA_RANGES` is a hand-set prior with a stated reason, exactly as SYSTEM.md
 * §2.1 says v1.0 priors are ("start hand-ranged, get fitted from real corpora in v1.1"). They
 * are documented in `RANGES.md` next to this file; the code below is the normative copy.
 */
import { jrint } from '../node/java_random.mjs';
import {
  CC_MAX,
  MOVEMENT_GRID,
  MOV_DEPTH_CC,
  MOV_JUMP_CC,
  PPQ,
  ccPosition,
  round1,
  round2,
} from '../node/sampler.mjs';

export { PPQ };
export const ERAS = ['baroque', 'classical', 'romantic'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const logUniform = (rng, lo, hi) => Math.exp(Math.log(lo) + rng.nextDouble() * (Math.log(hi) - Math.log(lo)));
const pick = (rng, arr) => arr[rng.nextInt(arr.length)];

/**
 * The era priors. Read `RANGES.md` for the prose; this is the machine-readable truth.
 *
 * Ranges are inclusive. `*Beats` are in quarter-note beats, `*Cc` in MIDI CC units, offsets in
 * milliseconds. Every one of them sits inside the corresponding CANONICAL rule's admissible
 * set; the rule id is named on each field group.
 */
export const ERA_RANGES = {
  baroque: {
    // T: steady tempo, long segments, shallow changes. Harpsichord/organ practice has no
    // continuous dynamic and little tempo shaping; what shaping exists is at section scale.
    tempo: { bpmLo: 52, bpmHi: 152, segBeats: [8, 24], continuity: 0.75, transitionP: 0.12, depth: [0.15, 0.25], slowerP: 0.5, mta: [0.15, 0.85], finalRitP: 0.15 },
    // D: TERRACED. transitionP 0 — the era's defining dynamic gesture is a level change, not a
    // hairpin. Levels come from a 5-step ladder so consecutive terraces are far apart.
    dynamics: { terraced: true, levels: [46, 62, 78, 94, 106], segBeats: [8, 24], transitionP: 0.0, jumpMin: 10, curvature: [0, 0.9], protraction: [-0.7, 0.7] },
    // A: dense and detached — the era's articulation is the primary expressive channel.
    articulation: { density: 0.35, relDur: [0.42, 0.92], velChange: [-10, 10] },
    // R: inegalite. intensity < 1 lengthens the first half of every frame (see sampleRubato).
    rubato: { p: 0.55, frames: [720], intensity: [[0.58, 0.86]], spanBeats: [8, 32], maxSpans: 2 },
    // Y: almost none. Two hands of a harpsichordist are not a melody-and-accompaniment texture.
    asynchrony: { p: 0.1, mag: [5, 14], maxSeg: 2 },
    // M: minimal pedal, and shallow when present (a damper lift on a fortepiano, not a wash).
    movement: { p: 0.2, posLo: 0, posHi: 48, segQuarters: [4, 8, 12, 16], transitionP: 0.25, continuity: 0.7 },
    imprecision: { sigmaMs: [6, 12] },
  },
  classical: {
    tempo: { bpmLo: 48, bpmHi: 168, segBeats: [4, 16], continuity: 0.6, transitionP: 0.35, depth: [0.15, 0.4], slowerP: 0.6, mta: [0.15, 0.85], finalRitP: 0.5 },
    dynamics: { terraced: false, levels: null, volume: [40, 112], segBeats: [4, 16], transitionP: 0.45, jumpMin: 8, curvature: [0, 0.7], protraction: [-0.5, 0.5] },
    articulation: { density: 0.2, relDur: [0.5, 1.08], velChange: [-16, 16] },
    rubato: { p: 0.2, frames: [1440], intensity: [[0.72, 0.88], [1.13, 1.35]], spanBeats: [8, 16], maxSpans: 1 },
    asynchrony: { p: 0.45, mag: [7, 24], maxSeg: 3 },
    movement: { p: 0.55, posLo: 0, posHi: CC_MAX, segQuarters: [2, 3, 4, 6, 8], transitionP: 0.3, continuity: 0.5 },
    imprecision: { sigmaMs: [8, 16] },
  },
  romantic: {
    tempo: { bpmLo: 34, bpmHi: 152, segBeats: [4, 12], continuity: 0.45, transitionP: 0.62, depth: [0.15, 0.75], slowerP: 0.6, mta: [0.3, 0.85], finalRitP: 0.85 },
    dynamics: { terraced: false, levels: null, volume: [30, 115], segBeats: [4, 12], transitionP: 0.75, jumpMin: 8, curvature: [0, 0.9], protraction: [-0.7, 0.7] },
    articulation: { density: 0.12, relDur: [0.62, 1.15], velChange: [-25, 25] },
    rubato: { p: 0.85, frames: [1440, 2880], intensity: [[0.55, 0.88], [1.13, 1.9]], spanBeats: [8, 32], maxSpans: 2 },
    // The brief's melody-lead spec: 10-40 ms, inside Y3's [5,60].
    asynchrony: { p: 0.9, mag: [10, 40], maxSeg: 3 },
    movement: { p: 1.0, posLo: 0, posHi: CC_MAX, segQuarters: [1, 2, 3, 4, 6, 8], transitionP: 0.6, continuity: 0.55 },
    imprecision: { sigmaMs: [10, 22] },
  },
};

// ===========================================================================================
// grids
// ===========================================================================================

/**
 * The coarsest grid that is both a whole number of bars and a whole number of **beats**.
 *
 * Map boundaries want to land on bar lines — that is where a real interpretation changes level
 * or tempo — but G4 requires tempo/dynamics/rubato dates to be integer multiples of `ppq`. In
 * 3/8 a bar is 1.5 beats, so bar-aligned and beat-aligned are incompatible until two bars are
 * taken together. This returns that group size in ticks, or `PPQ` when no group up to 8 bars
 * works (which cannot happen for any duple/triple meter but is not worth assuming).
 */
export function barGroupTicks(measureTicks) {
  for (let k = 1; k <= 8; k++) if ((k * measureTicks) % PPQ === 0) return k * measureTicks;
  return PPQ;
}

/**
 * Boundaries `0, g₁, g₂, …` on multiples of `grid`, each segment between `minBeats` and
 * `maxBeats` beats, with the final segment guaranteed at least `minBeats` (T1/D1/Y4).
 *
 * Segments are drawn in units of the grid, so a segment is always a whole number of bars where
 * `grid` is bar-aligned. When the grid alone is longer than `maxBeats` the grid wins: a
 * 4-beat minimum on a 6-beat bar means 6-beat segments, not a boundary inside the bar.
 */
export function segmentBoundaries(rng, totalTicks, grid, minBeats, maxBeats) {
  const gBeats = grid / PPQ;
  const lo = Math.max(1, Math.ceil(minBeats / gBeats));
  const hi = Math.max(lo, Math.floor(maxBeats / gBeats));
  const out = [0];
  let t = 0;
  for (;;) {
    const step = (lo + rng.nextInt(hi - lo + 1)) * grid;
    const next = t + step;
    // Stop when the remainder would be a segment shorter than the minimum: the last
    // instruction must govern at least `minBeats`, or T1/D1 is violated at the tail.
    if (totalTicks - next < lo * grid) break;
    out.push(next);
    t = next;
  }
  return out;
}

// ===========================================================================================
// tempoMap (CANONICAL T1-T4, G3/G4/G6/G7/G8)
// ===========================================================================================

/**
 * Era tempo map, with an optional closing ritardando.
 *
 * The ritardando is worth a note because it is the one structure the synthetic sampler could
 * not produce and every real classical/romantic performance has. A transition needs a *next*
 * instruction to bound it — meico renders a dangling transition as inert (G7) — so a final
 * ritardando is spelled as a transition on the last governing instruction plus a **constant
 * terminator at the piece end**, exactly as a movement chain is closed by M1. That keeps G7
 * literally true (the last instruction is constant) while making the last segment audible.
 */
export function sampleTempoEra(rng, cfg, totalTicks, grid) {
  const boundaries = segmentBoundaries(rng, totalTicks, grid, cfg.segBeats[0], cfg.segBeats[1]);
  const wantFinalRit = rng.nextDouble() < cfg.finalRitP && totalTicks - boundaries.at(-1) >= 4 * PPQ;

  const instrs = [];
  let prevEnd = NaN;
  for (let i = 0; i < boundaries.length; i++) {
    const isLast = i === boundaries.length - 1;
    const t = { date: boundaries[i], bpm: 0, transitionTo: null, meanTempoAt: null };
    const cont = !Number.isNaN(prevEnd) && rng.nextDouble() < cfg.continuity;
    t.bpm = cont ? prevEnd : round1(logUniform(rng, cfg.bpmLo, cfg.bpmHi));
    // G7: a transition on the last instruction is inert unless a terminator follows, and the
    // only terminator this sampler writes is the final ritardando's.
    const transition = isLast ? wantFinalRit : rng.nextDouble() < cfg.transitionP;
    if (transition) {
      const slower = isLast ? true : rng.nextDouble() < cfg.slowerP;
      let to;
      let guard = 0;
      do {
        const d = cfg.depth[0] + rng.nextDouble() * (cfg.depth[1] - cfg.depth[0]);
        to = round1(clamp(t.bpm * Math.pow(2, slower ? -d : d), cfg.bpmLo, cfg.bpmHi));
      } while (Math.abs(Math.log2(to / t.bpm)) < 0.15 && ++guard < 64); // T2
      if (Math.abs(Math.log2(to / t.bpm)) < 0.15) {
        // The clamp made the required depth unreachable from this bpm (only at the very edge
        // of the era's range). Fall back to a constant rather than emit a sub-T2 transition —
        // and fall THROUGH to the G8 merge below, because the fallback is exactly how two
        // adjacent equal constants arise.
        prevEnd = t.bpm;
      } else {
        t.transitionTo = to;
        t.meanTempoAt = round2(cfg.mta[0] + rng.nextDouble() * (cfg.mta[1] - cfg.mta[0])); // T3
        prevEnd = to;
      }
    } else {
      prevEnd = t.bpm;
    }
    const last = instrs.at(-1);
    if (last && last.transitionTo === null && t.transitionTo === null && last.bpm === t.bpm) continue; // G8
    instrs.push(t);
  }
  if (instrs.at(-1)?.transitionTo !== null)
    instrs.push({ date: totalTicks, bpm: instrs.at(-1).transitionTo, transitionTo: null, meanTempoAt: null }); // G7
  return instrs;
}

// ===========================================================================================
// dynamicsMap (CANONICAL D1, H4, G-rules)
// ===========================================================================================

/**
 * Era dynamics map. Two shapes, selected by `cfg.terraced`.
 *
 * **Terraced** (baroque) emits constants only, drawn from a fixed ladder of levels, with a
 * minimum jump of `jumpMin` velocity units between adjacent terraces. `jumpMin` is the
 * *observability* floor, the constants analogue of D1's transition depth: a level change
 * smaller than ~8 units is inside the rounding of the emitted MIDI velocity, so it costs
 * tokens and buys no evidence. The ladder additionally makes the target a small discrete
 * alphabet, which is what a terraced style *is*.
 *
 * **Continuous** (classical/romantic) is the v4 shape: constants and transitions with
 * curvature/protraction, depth >= D1's 8 units.
 */
export function sampleDynamicsEra(rng, cfg, totalTicks, grid) {
  const boundaries = segmentBoundaries(rng, totalTicks, grid, cfg.segBeats[0], cfg.segBeats[1]);
  const instrs = [];
  let prevEnd = NaN;
  for (let i = 0; i < boundaries.length; i++) {
    const isLast = i === boundaries.length - 1;
    const d = { date: boundaries[i], volume: 0, transitionTo: null, curvature: null, protraction: null };
    if (cfg.terraced) {
      let v;
      let guard = 0;
      do {
        v = pick(rng, cfg.levels);
      } while (!Number.isNaN(prevEnd) && Math.abs(v - prevEnd) < cfg.jumpMin && ++guard < 64);
      d.volume = round1(v);
      prevEnd = d.volume;
    } else {
      const cont = !Number.isNaN(prevEnd) && rng.nextDouble() < 0.5;
      d.volume = cont ? prevEnd : round1(cfg.volume[0] + rng.nextDouble() * (cfg.volume[1] - cfg.volume[0]));
      if (!isLast && rng.nextDouble() < cfg.transitionP) {
        let to;
        let guard = 0;
        do {
          to = round1(cfg.volume[0] + rng.nextDouble() * (cfg.volume[1] - cfg.volume[0]));
        } while (Math.abs(to - d.volume) < cfg.jumpMin && ++guard < 64); // D1
        if (Math.abs(to - d.volume) >= cfg.jumpMin) {
          d.transitionTo = to;
          d.curvature = round2(cfg.curvature[0] + rng.nextDouble() * (cfg.curvature[1] - cfg.curvature[0]));
          d.protraction = round2(cfg.protraction[0] + rng.nextDouble() * (cfg.protraction[1] - cfg.protraction[0]));
        }
      }
      prevEnd = d.transitionTo ?? d.volume;
    }
    const last = instrs.at(-1);
    if (last && last.transitionTo === null && d.transitionTo === null && last.volume === d.volume) continue; // G8
    instrs.push(d);
  }
  if (instrs.at(-1)?.transitionTo !== null)
    instrs.push({ date: totalTicks, volume: instrs.at(-1).transitionTo, transitionTo: null, curvature: null, protraction: null });
  return instrs;
}

// ===========================================================================================
// articulationMap (CANONICAL A1-A6)
// ===========================================================================================

/**
 * The largest articulation density that leaves A1's clean-observation budget intact.
 *
 * A1 sets ~15 % on the synthetic sampler and justifies it by what it *leaves*: ">= 5 clean
 * dates per 4-beat segment", the unarticulated dates from which the dynamics and tempo curves
 * are read. That justification is a function of note density, and real repertoire is 2-6x
 * denser than the synthetic score (median 1.6 onset dates per beat there; Bach's WTC reaches
 * 8). So the budget, not the 15 %, is the rule worth carrying over: this returns
 * `1 − 5/datesPer4Beats`, i.e. the density at which exactly five clean dates per 4-beat window
 * survive in expectation, and the caller takes the smaller of it and the era prior.
 *
 * A part too sparse to leave five clean dates gets **no** articulation at all (returns 0)
 * rather than a reduced amount: below the budget every date is doing two jobs and the
 * decomposition is not identified.
 */
export function maxArticulationDensity(distinctDates, totalTicks) {
  const windows = totalTicks / (4 * PPQ);
  if (windows <= 0) return 0;
  const datesPerWindow = distinctDates / windows;
  if (datesPerWindow <= 5) return 0;
  return 1 - 5 / datesPerWindow;
}

/** One articulation, era-ranged, respecting the A2/A3 deadbands. */
function sampleArticulationEra(rng, cfg, date) {
  let relDur;
  let guard = 0;
  do {
    relDur = round2(cfg.relDur[0] + rng.nextDouble() * (cfg.relDur[1] - cfg.relDur[0]));
  } while (relDur >= 0.97 && relDur <= 1.03 && ++guard < 64); // A2 deadband
  let velChange;
  guard = 0;
  do {
    velChange = jrint(cfg.velChange[0] + rng.nextDouble() * (cfg.velChange[1] - cfg.velChange[0]));
  } while (velChange >= -2 && velChange <= 2 && ++guard < 64); // A3 deadband
  return { date, relDur, velChange };
}

/**
 * A part-local articulation map (A6) over that part's own distinct onset dates (A1/A4).
 *
 * `pieceDates` is the number of distinct onset dates **over all parts**, and it is what the
 * budget is computed from — not the part's own count. A1's argument is about the observations
 * the *curves* are read from, and tempo and dynamics are global (G2): a clean date in either
 * hand is a clean observation of both curves. Computing the cap per part instead silences
 * articulation on every accompaniment voice, which is a stricter rule than A1 states and a
 * worse corpus.
 *
 * Returns `{rows, density, cap}` so the realised density and the budget that capped it are
 * reportable per piece — the era prior alone would not say which of the two was binding.
 */
export function sampleArticulationEraMap(rng, cfg, dates, totalTicks, pieceDates) {
  const cap = maxArticulationDensity(pieceDates ?? dates.length, totalTicks);
  const density = Math.min(cfg.density, cap);
  const rows = [];
  for (const d of dates) {
    if (rng.nextDouble() >= density) continue;
    rows.push(sampleArticulationEra(rng, cfg, d));
  }
  return { rows, density, cap };
}

// ===========================================================================================
// rubatoMap (CANONICAL R1-R8)
// ===========================================================================================

/**
 * Era rubato spans.
 *
 * The warp is `t ↦ t − ℓ + frame·(ℓ/frame)^intensity` with `ℓ = (t − start) mod frame`
 * (R2 pins the window to the whole frame). So at the frame midpoint the warped position is
 * `0.5^intensity`:
 *
 *   intensity 0.58 → 0.669  → the first half of the frame gets 67 % of its duration: a 2:1
 *                             long-short pair, i.e. classic *notes inégales*;
 *   intensity 0.86 → 0.551  → 1.23:1, a light swing;
 *   intensity 1.13 → 0.457  → short-long, the reverse (*lourée*) inflection;
 *   intensity 1.90 → 0.268  → a heavy delayed-arrival gesture.
 *
 * `intensity < 1` therefore *is* inégalité, and the baroque prior is the interval that spans
 * 2:1 down to 1.23:1 — entirely below R3's `[0.89, 1.12]` deadband, so every sampled span
 * displaces onsets by more than the 5 ms observability floor at every tempo in the era range.
 * Romantic playing gets both signs and the 2- and 4-beat frames, where the same intensity
 * produces a proportionally larger millisecond displacement (R3's table).
 *
 * R8 is enforced by rejection against the already-sampled tempo map, as in the v4 sampler:
 * meico picks a note's tempo segment from its *unwarped* key but evaluates the curve at the
 * warped date, so a frame straddling a tempo boundary can render NaN.
 */
export function sampleRubatoEra(rng, cfg, totalTicks, grid, tempi) {
  const out = [];
  if (rng.nextDouble() >= cfg.p) return out;
  const totalBeats = totalTicks / PPQ;
  if (totalBeats < cfg.spanBeats[0]) return out;

  const nSpans = 1 + (cfg.maxSpans > 1 && rng.nextDouble() < 0.3 ? 1 : 0);
  const spans = [];
  for (let s = 0; s < nSpans; s++) {
    let placed = null;
    for (let attempt = 0; attempt < 60 && !placed; attempt++) {
      const frame = pick(rng, cfg.frames);
      const fBeats = frame / PPQ;
      const minMult = Math.ceil(cfg.spanBeats[0] / fBeats);
      const maxMult = Math.floor(Math.min(cfg.spanBeats[1], totalBeats) / fBeats);
      if (maxMult < minMult) continue;
      const lenBeats = fBeats * (minMult + rng.nextInt(maxMult - minMult + 1));
      // R5: the span starts on a frame multiple counted from its own start, which is trivially
      // true, and — so that bar lines stay meaningful — on a bar-group boundary where the
      // group is itself a multiple of the frame; otherwise on any beat.
      const stepBeats = grid % frame === 0 ? grid / PPQ : fBeats;
      const maxStart = Math.floor((totalBeats - lenBeats) / stepBeats);
      if (maxStart < 0) continue;
      const startBeat = rng.nextInt(maxStart + 1) * stepBeats;
      const startTick = startBeat * PPQ;
      const endTick = startTick + lenBeats * PPQ;
      if (spans.some((sp) => startTick < sp.end && endTick > sp.start)) continue; // R7
      // R8: no tempo date strictly inside a frame.
      const bad = tempi.some((t) => t.date > startTick && t.date < endTick && (t.date - startTick) % frame !== 0);
      if (bad) continue;
      placed = { start: startTick, end: endTick, frame };
    }
    if (placed) spans.push(placed);
  }
  spans.sort((a, b) => a.start - b.start);

  for (const sp of spans) {
    const band = pick(rng, cfg.intensity);
    let intensity;
    let guard = 0;
    do {
      intensity = round2(band[0] + rng.nextDouble() * (band[1] - band[0]));
    } while (intensity >= 0.89 && intensity <= 1.12 && ++guard < 64); // R3
    out.push({ date: sp.start, frameLength: sp.frame, intensity, lateStart: 0.0, earlyEnd: 1.0, loop: true }); // R2/R4
    out.push({ date: sp.end, frameLength: sp.frame, intensity: 1.0, lateStart: 0.0, earlyEnd: 1.0, loop: true }); // R6
  }
  return out;
}

// ===========================================================================================
// asynchronyMap (CANONICAL Y1-Y6)
// ===========================================================================================

/**
 * Melody lead, as a step function on part 2 (Y1).
 *
 * `build_msm.mjs` has already put the highest-register part first, so part 2 is the
 * accompaniment and a **positive** offset means it sounds *after* the melody — which is the
 * sign real playing has (LOG.md: positive top-voice lead in 35 of 40 Vienna windows) and the
 * sign Y5 requires at date 0 to avoid meico's `max(0, date+offset)` truncation.
 *
 * Later segments carry either sign: they start at beat >= 4, i.e. >= 1 s into the piece at the
 * fastest era tempo, so a negative offset cannot reach the clamp.
 */
export function sampleAsynchronyEra(rng, cfg, totalTicks) {
  const out = [];
  if (rng.nextDouble() >= cfg.p) return out;
  const totalBeats = totalTicks / PPQ;
  const nSeg = 1 + rng.nextInt(cfg.maxSeg);
  const boundaries = [0];
  let b = 0;
  for (let i = 1; i < nSeg; i++) {
    b += 4 + rng.nextInt(9); // Y4: >= 4 beats apart
    if (b >= totalBeats) break;
    boundaries.push(b);
  }
  let prev = null;
  for (const beat of boundaries) {
    const mag = cfg.mag[0] + rng.nextInt(cfg.mag[1] - cfg.mag[0] + 1); // Y3 (inside [5,60])
    const off = beat === 0 ? mag : rng.nextDouble() < 0.35 ? -mag : mag; // Y5 on the first
    if (prev !== null && off === prev) continue; // Y4/G8
    out.push({ date: beat * PPQ, msOffset: off });
    prev = off;
  }
  return out;
}

// ===========================================================================================
// movementMap (CANONICAL M1-M10)
// ===========================================================================================

/**
 * Era pedalling, as a sustain chain on the 1/4-beat grid.
 *
 * Same skeleton as `ml/node/sampler.mjs::sampleMovementMap` — the M1 terminator discipline is
 * subtle enough that reproducing it rather than reinventing it is the point — with three
 * era-conditioned distributions layered on: the position band (`posLo`/`posHi`, which is what
 * makes baroque pedalling shallow and romantic pedalling full-range), the segment-length
 * alphabet in quarter-beats, and the transition probability, which is the difference between a
 * pedal that steps (classical, mostly plateaus and jumps) and one that sweeps (romantic
 * half-pedalling, mostly ramps with sampled `curvature`/`protraction`).
 *
 * The four invariants that make the chain observable are era-independent and enforced here:
 * M2 (date 0), M3 (grid and minimum segment), M4 (the 128-value CC alphabet), M5 (no
 * degenerate transition), and M1 (a terminator at the chain end, neutral, preceded by a
 * transition — see the long note in `sampler.mjs` for why the last rendering element must be a
 * ramp).
 */
export function sampleMovementEra(rng, cfg, totalTicks) {
  if (rng.nextDouble() >= cfg.p) return [];
  const span = cfg.posHi - cfg.posLo;
  // A jump/depth floor cannot exceed the band; a shallow band gets a proportionally smaller
  // floor, kept at >= 6 CC so it stays above the CC quantiser and M3's inversion error.
  const depthCc = Math.max(6, Math.min(MOV_DEPTH_CC, Math.floor(span * 0.4)));
  const jumpCc = Math.max(6, Math.min(MOV_JUMP_CC, Math.floor(span * 0.3)));

  const boundaries = [];
  for (let t = 0; t < totalTicks; t += pick(rng, cfg.segQuarters) * MOVEMENT_GRID) boundaries.push(t);
  while (boundaries.length > 1 && totalTicks - boundaries.at(-1) < MOVEMENT_GRID) boundaries.pop();
  if (!boundaries.length || totalTicks - boundaries[0] < MOVEMENT_GRID) return [];

  const drawK = (avoid) => {
    let k;
    let guard = 0;
    do {
      k = cfg.posLo + rng.nextInt(span + 1);
    } while (avoid !== null && Math.abs(k - avoid) < jumpCc && ++guard < 64);
    return k;
  };

  const out = [];
  let prevEndK = null;
  for (let i = 0; i < boundaries.length; i++) {
    const isLastRendering = i === boundaries.length - 1;
    const k = prevEndK !== null && rng.nextDouble() < cfg.continuity ? prevEndK : drawK(prevEndK);
    const mv = { date: boundaries[i], position: ccPosition(k), transitionTo: null, curvature: null, protraction: null, controller: 'sustain' };
    // `||` short-circuits, so the coin is consumed either way and forcing the last element to
    // be a transition (M1) does not shift the RNG stream relative to a run without it.
    if (rng.nextDouble() < cfg.transitionP || isLastRendering) {
      let k2;
      let guard = 0;
      do {
        k2 = cfg.posLo + rng.nextInt(span + 1);
      } while (Math.abs(k2 - k) < depthCc && ++guard < 64); // M5
      if (Math.abs(k2 - k) >= depthCc) {
        mv.transitionTo = ccPosition(k2);
        mv.curvature = round2(rng.nextDouble() * 0.9); // M9
        mv.protraction = round2(rng.nextDouble() * 1.4 - 0.7);
        prevEndK = k2;
      } else prevEndK = k;
    } else prevEndK = k;
    const last = out.at(-1);
    if (last && last.transitionTo === null && mv.transitionTo === null && last.position === mv.position) continue; // G8
    out.push(mv);
  }
  // M1: without a ramp before it the terminator is a G8 duplicate and the chain stops short.
  if (out.at(-1)?.transitionTo === null) return [];
  out.push({ date: totalTicks, position: ccPosition(prevEndK), transitionTo: null, curvature: null, protraction: null, controller: 'sustain' });
  return out;
}

// ===========================================================================================
// imprecisionMap.timing — the NEW map (SYSTEM.md v1.1)
// ===========================================================================================

/**
 * A seeded Gaussian timing-imprecision map, as MPM XML.
 *
 * The supervision target for this band is **the distribution's parameters**, never the
 * per-note offsets: the offsets are a sample, and a model asked to reproduce a sample of a
 * Gaussian is being asked to memorise a random number generator. `sigma` (and the seed, which
 * is provenance rather than a target) is what a record carries.
 *
 * `limit.lower`/`limit.upper` are hard clips on the drawn offset. They are set to ±3σ, which
 * removes 0.27 % of the mass — enough to keep a tail draw from moving a note past its
 * neighbour, little enough that the clipped distribution's sd is within 0.2 % of σ, so the
 * label stays true.
 *
 * `milliseconds.timingBasis` is the sampling grid in ms: the provider is indexed by
 * `msDate / timingBasis`, so notes closer together than the basis share an index and therefore
 * an offset. 200 ms is well below any note rate this corpus contains at any sampled tempo, so
 * distinct notes get distinct draws.
 */
export function buildImprecisionTimingXml({ sigma, seed, limit, timingBasis = 200 }) {
  if (!(sigma >= 0)) throw new Error(`imprecision sigma must be >= 0, got ${sigma}`);
  const lim = limit ?? 3 * sigma;
  const seedAttr = seed === null || seed === undefined ? '' : ` seed="${Math.trunc(seed)}"`;
  return (
    '<imprecisionMap.timing>' +
    `<distribution.gaussian date="0.0" deviation.standard="${sigma}" limit.lower="${-lim}" limit.upper="${lim}"` +
    `${seedAttr} milliseconds.timingBasis="${timingBasis}" />` +
    '</imprecisionMap.timing>'
  );
}

// ===========================================================================================
// the whole interpretation
// ===========================================================================================

/** Ascending, de-duplicated onset dates of one part — the articulation domain (A1/A4/A6). */
const distinctDates = (notes) => [...new Set(notes.map((n) => n.date))].sort((a, b) => a - b);

/**
 * Sample one era-conditioned interpretation for a windowed score.
 *
 * `score` is `{parts:[{number, name, notes:[{date,dur,pitch,id}]}], totalTicks, measureTicks}`.
 * Returns the sampler's own shape — `{maps, parts, meta}` — which `ml/node/xml.mjs::buildMpm`
 * consumes unchanged, so the corpus and the synthetic set produce byte-comparable MPM.
 */
export function sampleEraPerformance(rng, score, era, opts = {}) {
  const cfg = ERA_RANGES[era];
  if (!cfg) throw new Error(`unknown era ${era}; known: ${ERAS.join(', ')}`);
  const { totalTicks, measureTicks } = score;
  if (totalTicks % PPQ !== 0) throw new Error(`window length ${totalTicks} is not a whole number of beats (G4)`);
  const grid = barGroupTicks(measureTicks);
  const want = { dynamics: true, articulation: true, rubato: true, asynchrony: true, movement: true, ...(opts.maps ?? {}) };

  const tempo = sampleTempoEra(rng, cfg.tempo, totalTicks, grid);
  const dynamics = want.dynamics ? sampleDynamicsEra(rng, cfg.dynamics, totalTicks, grid) : [];
  const rubato = want.rubato ? sampleRubatoEra(rng, cfg.rubato, totalTicks, grid, tempo) : [];
  const movement = want.movement ? sampleMovementEra(rng, cfg.movement, totalTicks) : [];

  // Y1 needs a part 2 and only a part 2: a three-staff score has no canonical answer to
  // "which part lags", so it gets none. Reported in `meta`, never silently skipped.
  const twoPart = score.parts.length === 2;
  const asynchrony = want.asynchrony && twoPart ? sampleAsynchronyEra(rng, cfg.asynchrony, totalTicks) : [];

  const parts = [];
  const articMeta = [];
  const pieceDates = distinctDates(score.parts.flatMap((p) => p.notes)).length;
  for (const p of score.parts) {
    let rows = [];
    if (want.articulation) {
      const a = sampleArticulationEraMap(rng, cfg.articulation, distinctDates(p.notes), totalTicks, pieceDates);
      rows = a.rows;
      articMeta.push({ part: p.number, density: a.density, cap: a.cap, n: a.rows.length });
    }
    parts.push({
      name: p.name || `part${p.number}`,
      number: p.number,
      midiChannel: p.number - 1,
      midiPort: 0,
      notes: p.notes,
      asynchrony: p.number === 2 ? asynchrony : [],
      articulation: rows,
    });
  }

  return {
    maps: { tempo, dynamics, articulation: [], rubato, movement, accentuation: null },
    parts,
    meta: {
      era,
      grid,
      barGroupBeats: grid / PPQ,
      twoPart,
      asynchronySkippedParts: want.asynchrony && !twoPart ? score.parts.length : 0,
      articulation: articMeta,
    },
  };
}
