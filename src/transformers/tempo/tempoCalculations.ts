/**
 * Tick ⇄ millisecond conversion under a `<tempo>` instruction.
 *
 * **The arithmetic is espressivo's, not mpmify's.** Every function here that answers "how long
 * does this take" or "how fast is it here" delegates to `resolveTempo` + `tempoAt` +
 * `TempoMap.computeDiffTiming`, which are the renderer's own code, held byte-equivalent to
 * meico. This module used to carry hand-copies of all three — Simpson's rule included, down to
 * the sub-interval count — and they had drifted:
 *
 * - `meanTempoAt` of exactly 1 gave `pow(x, -Infinity)`, so the tempo read as ±Infinity where
 *   meico reads a constant at `@bpm`;
 * - a `meanTempoAt` above 1 overshot both endpoints (256 bpm on a 60→120 ramp) instead of the
 *   same constant;
 * - a negative one gave `NaN` where meico gives a constant at `@transition.to`;
 * - `|| 0.5` turned an *explicit* `meanTempoAt="0"` into a linear ramp, where meico makes it a
 *   constant at the target, and swallowed a malformed one into a linear ramp as well.
 *
 * The last of those is a behaviour change worth stating plainly: a document with
 * `meanTempoAt="x"` used to fit quietly against a ramp the renderer would never draw, and now
 * produces `NaN` — which `auditInstructions` refuses to let a transformer leave standing. That is
 * the intended outcome. The renderer's answer is the one that decides whether a fit is right, so
 * matching it is correctness and not precision.
 *
 * What is genuinely mpmify's stays here: the inverse direction — {@link ticksForConstantTempo}
 * and {@link dateAtMilliseconds}, which answer "which tick is this millisecond" and have no
 * counterpart in espressivo because a renderer never needs one — and the two fitting helpers the
 * desks drive, which now measure with the renderer's quadrature instead of their own.
 */
import { TempoMap, resolveTempo, tempoAt, type Tempo as ResolvedTempo } from 'espressivo';
import type { InstructionOptions } from '../../mpm';
import { beatLengthInTicks, PULSES_PER_QUARTER } from '../../ppq';

export interface WithEndDate {
  endDate: number;
}

/**
 * A `<tempo>` as the document states it, plus the date the next one takes over.
 *
 * `@endDate` is not an MPM attribute and never was: it is the window a span is evaluated over,
 * which every one of these functions needs and which the instruction itself does not carry.
 */
export type TempoWithEndDate = InstructionOptions<'tempo'> & WithEndDate;

// ── the bridge to espressivo ──────────────────────────────────────

/**
 * One of mpmify's `<tempo>` records, resolved the way the renderer resolves it.
 *
 * Everything downstream of this call is espressivo's: the choice between the constant and the
 * transitioning arm, the power-curve exponent, and the defaults for the attributes that are
 * absent. Three of those normalisations are the ones the hand-written version got wrong (see the
 * module header), and they are made here, once, rather than at each evaluation.
 *
 * Exported because it is worth calling once per segment and then evaluating many times: it
 * parses `@bpm` and `@transition.to` out of text, and a walk over a score asks about the same
 * span once per note. `tempoAt`, {@link millisecondsAt} and {@link dateAtMilliseconds} all take
 * the result rather than the record.
 *
 * `@bpm` and `@transition.to` go across as text because that is what espressivo resolves from:
 * a style-relative name (`"Allegro"`) is as legal an `@bpm` as a number, and with no style in
 * scope it becomes meico's default of 100 rather than the `NaN` arithmetic on the string used to
 * give. `String(x)` round-trips a double exactly, so a numeric one is unchanged.
 */
export const resolveSpan = (tempo: TempoWithEndDate): ResolvedTempo =>
  resolveTempo(
    {
      startDate: tempo.date,
      endDate: tempo.endDate,
      beatLength: tempo.beatLength,
    },
    String(tempo.bpm),
    tempo.transitionTo === undefined ? null : String(tempo.transitionTo),
    tempo.meanTempoAt === undefined ? null : String(tempo.meanTempoAt),
    // No style: mpmify writes numeric `@bpm` throughout, and a `<tempoDef>` it did not write is
    // not in scope here anyway. An unresolvable name therefore lands on meico's 100.0.
    null,
  );

/**
 * The instantaneous tempo of an already-resolved span at `date`, clamped to the span's own ends.
 *
 * Both ends need clamping and for different reasons. Below `startDate` the progress term goes
 * negative and `Math.pow(negative, non-integer)` is `NaN`, which then propagates silently through
 * every comparison that reads it — `Math.abs(NaN - x) > 1` is `false`, so a loop testing for
 * convergence exits as though it had converged (issue #26). meico's `TempoMap.renderTempoToMap`
 * has the same hole and the same fix (`bugs.md` #7), so clamping here keeps the two in step.
 * Above `endDate` there is no `NaN` — the curve simply runs away from *both* of its endpoints,
 * which is worse than wrong because it looks like an answer.
 *
 * The clamped value is the honest reading either way: the next instruction takes over at
 * `endDate`, and the previous one was in force before `startDate`.
 */
const tempoAtClamped = (tempo: ResolvedTempo, date: number): number =>
  tempoAt(tempo, Math.min(Math.max(date, tempo.startDate), tempo.endDate));

/**
 * Milliseconds elapsed across `ticks` at a constant `bpm` — meico's own constant-tempo formula,
 * and the exact inverse of {@link ticksForConstantTempo}. The two are written next to each
 * other's constants deliberately: an extrapolation and its inversion that disagree would show up
 * as a fit that will not round-trip, which is expensive to trace back to a divisor.
 */
const msForConstantTempo = (
  ticks: number,
  bpm: number,
  tempo: Pick<ResolvedTempo, 'beatLength'>,
): number => (15000.0 * ticks) / (bpm * tempo.beatLength * PULSES_PER_QUARTER);

/**
 * Elapsed milliseconds from the start of an already-resolved span to `date`, for **any** `date`.
 *
 * ## Outside the span
 *
 * espressivo never evaluates a `<tempo>` outside its own span — the neighbouring instructions
 * take over there — so neither end of `tempoAt` is defined beyond it: past `endDate` the progress
 * term rises above 1 and the curve runs away from both of its endpoints, and before `startDate`
 * it goes negative and the power is `NaN`. mpmify *does* ask, at both ends.
 * {@link dateAtMilliseconds} inverts this function and has to be able to walk a guess outside
 * the span to get back into it; an ornament's frame reaches backwards from its anchor, so a roll
 * on the first beat asks about a negative time; and a note released after the last modelled
 * moment of the piece asks about one past the end.
 *
 * So outside the span the answer is a continuation at the boundary tempo — the one the transition
 * arrives at, or the one it departs from. That is the honest reading (the neighbouring
 * instruction starts there, or the piece goes on at that tempo), it is exact wherever the
 * boundary segment is constant, and it is the right limit approaching the boundary where it is
 * not. This is mpmify's own semantics layered on espressivo's arithmetic, not a second copy of
 * it: everything inside the span is `computeDiffTiming`, and the continuations are the
 * constant-tempo formula that {@link ticksForConstantTempo} inverts.
 *
 * The result is total, continuous and strictly increasing in `date` — which is what makes
 * inverting it a well-posed problem rather than a search that can silently fail.
 *
 * A constant tempo is unaffected — its formula is already linear in `date` over the whole real
 * line, so the split changes nothing. Only transitions reach the outer branches.
 */
export const millisecondsAt = (date: number, tempo: ResolvedTempo): number => {
  // Already linear in `date` over the whole real line, and espressivo's own formula for it.
  if (tempo.kind === 'constant') {
    return TempoMap.computeDiffTiming(date, PULSES_PER_QUARTER, tempo);
  }

  if (date < tempo.startDate) {
    return msForConstantTempo(
      date - tempo.startDate,
      tempoAtClamped(tempo, tempo.startDate),
      tempo,
    );
  }

  if (date > tempo.endDate) {
    const toEnd = TempoMap.computeDiffTiming(tempo.endDate, PULSES_PER_QUARTER, tempo);
    return (
      toEnd + msForConstantTempo(date - tempo.endDate, tempoAtClamped(tempo, tempo.endDate), tempo)
    );
  }

  return TempoMap.computeDiffTiming(date, PULSES_PER_QUARTER, tempo);
};

// ── Curve shape fitting ───────────────────────────────────────────

/**
 * Fits the `meanTempoAt` parameter (0–1) for a power-function tempo
 * curve by minimising the squared error against a sampled trail of
 * (seconds, bpm) points drawn by the user.
 *
 * The curve is evaluated by {@link tempoAt} over a unit span, so the shape being fitted is
 * exactly the shape the renderer draws. `x` stays a fraction of *elapsed seconds* rather than of
 * ticks, which is the domain the trail is drawn in and is deliberate: the desk asks "what shape
 * did you draw", and turning that into a tick-domain instruction is the fitter's job downstream.
 */
export function fitMeanTempoAt(
  from: { seconds: number; bpm: number },
  to: { seconds: number; bpm: number },
  trail: { seconds: number; bpm: number }[],
): number {
  const duration = to.seconds - from.seconds;
  const bpmRange = to.bpm - from.bpm;

  if (Math.abs(duration) < 1e-9 || Math.abs(bpmRange) < 1e-9 || trail.length < 2) return 0.5;

  const normalized = trail
    .map((pt) => ({
      x: (pt.seconds - from.seconds) / duration,
      bpm: pt.bpm,
    }))
    .filter((pt) => pt.x > 0.01 && pt.x < 0.99);

  if (normalized.length === 0) return 0.5;

  let bestIm = 0.5;
  let bestError = Infinity;

  for (let i = 2; i <= 98; i++) {
    const im = i / 100;
    // A unit span, so `tempoAt`'s progress term is `x` itself and nothing is lost to the
    // division. `beatLength` does not enter the tempo curve at all.
    const curve = resolveSpan({
      date: 0,
      endDate: 1,
      beatLength: 0.25,
      bpm: from.bpm,
      transitionTo: to.bpm,
      meanTempoAt: im,
    });
    let error = 0;
    for (const pt of normalized) {
      const predicted = tempoAt(curve, pt.x);
      error += (predicted - pt.bpm) ** 2;
    }
    if (error < bestError) {
      bestError = error;
      bestIm = im;
    }
  }

  return bestIm;
}

// ── Elapsed-time calculation ──────────────────────────────────────

/**
 * Computes elapsed milliseconds for a tempo segment of `segLengthBeats`
 * beats, transitioning from `startBpm` to `endBpm` with the given
 * `meanTempoAt` curve shape.
 *
 * Measured with the renderer's quadrature. It used to be a 200-step trapezoid rule of its own,
 * which disagreed with what the piece would actually sound like by **up to 31 ms (4.25%)** on
 * short, steeply curved segments — while {@link optimizeForElapsedTime}, its only caller of
 * consequence, bisects against it to a tolerance of 0.1 ms. Converging precisely on the wrong
 * number is not an improvement over converging loosely on the right one.
 *
 * `beatLength` cancels: elapsed time per beat is `60000 / T` whatever the beat is, so the span is
 * expressed in quarters here regardless of what the real instruction counts in.
 */
export function computeElapsedMs(
  startBpm: number,
  endBpm: number,
  meanTempoAt: number,
  segLengthBeats: number,
): number {
  if (segLengthBeats <= 0) return 0;

  const endDate = segLengthBeats * PULSES_PER_QUARTER;
  return millisecondsAt(
    endDate,
    resolveSpan({
      date: 0,
      endDate,
      beatLength: 0.25,
      bpm: startBpm,
      transitionTo: endBpm,
      meanTempoAt,
    }),
  );
}

// ── Elapsed-time optimiser ────────────────────────────────────────

/**
 * Adjusts `startBpm`, `endBpm`, and `meanTempoAt` so the segment
 * spanning `[startTick, endTick)` matches `targetMs` milliseconds.
 *
 * Phase 1 – bisect `meanTempoAt` (shape only, BPMs unchanged).
 * Phase 2 – scale BPMs uniformly if phase 1 cannot reach the target.
 */
export function optimizeForElapsedTime(
  startBpm: number,
  endBpm: number,
  meanTempoAt: number,
  beatLength: number,
  startTick: number,
  endTick: number,
  targetMs: number,
): { startBpm: number; endBpm: number; meanTempoAt: number; bpmScaled: boolean } {
  const segLengthBeats = Math.abs(endTick - startTick) / beatLengthInTicks(beatLength);
  if (segLengthBeats <= 0 || targetMs <= 0) {
    return { startBpm, endBpm, meanTempoAt, bpmScaled: false };
  }

  if (Math.abs(startBpm - endBpm) < 0.5) {
    const neededBpm = (segLengthBeats * 60000) / targetMs;
    const avgBpm = (startBpm + endBpm) / 2;
    const scaled = Math.abs(neededBpm - avgBpm) > 0.5;
    return { startBpm: neededBpm, endBpm: neededBpm, meanTempoAt: 0.5, bpmScaled: scaled };
  }

  const msAt02 = computeElapsedMs(startBpm, endBpm, 0.02, segLengthBeats);
  const msAt98 = computeElapsedMs(startBpm, endBpm, 0.98, segLengthBeats);
  const msMin = Math.min(msAt02, msAt98);
  const msMax = Math.max(msAt02, msAt98);

  if (targetMs >= msMin && targetMs <= msMax) {
    const increasing = msAt98 > msAt02;
    let lo = 0.02,
      hi = 0.98;

    for (let iter = 0; iter < 50; iter++) {
      const mid = (lo + hi) / 2;
      const msMid = computeElapsedMs(startBpm, endBpm, mid, segLengthBeats);
      if (Math.abs(msMid - targetMs) < 0.1) {
        return { startBpm, endBpm, meanTempoAt: mid, bpmScaled: false };
      }
      if (msMid < targetMs === increasing) {
        lo = mid;
      } else {
        hi = mid;
      }
    }

    return { startBpm, endBpm, meanTempoAt: (lo + hi) / 2, bpmScaled: false };
  }

  const currentMs = computeElapsedMs(startBpm, endBpm, meanTempoAt, segLengthBeats);
  const scale = currentMs / targetMs;
  return {
    startBpm: startBpm * scale,
    endBpm: endBpm * scale,
    meanTempoAt,
    bpmScaled: true,
  };
}

// ── evaluating one instruction ────────────────────────────────────

/**
 * Elapsed milliseconds from the start of `tempo`'s span to `date`.
 *
 * Which arm is taken — one division, or Simpson's rule over the span — is decided by
 * {@link resolveSpan} rather than by a `transition.to` truthiness test here, and that is the
 * point of the delegation: `resolveTempo` collapses three shapes of declared transition back to
 * a constant, and taking the wrong arm is invisible until a timestamp moves.
 */
export const computeMillisecondsAt = (date: number, tempo: TempoWithEndDate) =>
  millisecondsAt(date, resolveSpan(tempo));

/**
 * The tick span a millisecond span covers at a constant tempo — the exact inverse of
 * {@link msForConstantTempo}, sharing its constants so the two cannot drift apart.
 *
 * This is the one piece of arithmetic here that is genuinely mpmify's: espressivo converts ticks
 * to milliseconds and never the other way, because a renderer never needs to.
 *
 * Defined for negative spans too, which is the point: it is what lets a time *before* the first
 * `<tempo>` be placed on the tick grid at all. A roll that begins before its beat is the ordinary
 * arpeggio, and it has no segment of its own to be measured in.
 */
export const ticksForConstantTempo = (
  milliseconds: number,
  tempo: Pick<InstructionOptions<'tempo'>, 'bpm' | 'beatLength'>,
): number => (milliseconds * Number(tempo.bpm) * tempo.beatLength * PULSES_PER_QUARTER) / 15000.0;

/** How close {@link dateAtMilliseconds} gets, where the iteration it replaces stopped at 1 ms. */
const INVERSE_TOLERANCE_MS = 1e-6;

/**
 * ... and how narrow it lets the bracket get before it stops, which is the exit that actually
 * fires. Simpson's sub-interval count steps with the date (`2 * floor(span / (ppq / 4))`), so
 * what is being inverted has hairline discontinuities at every sixteenth note and the
 * millisecond test alone is not guaranteed to be reachable. A millionth of a tick is a
 * nanosecond at any tempo anyone plays.
 */
const INVERSE_TOLERANCE_TICKS = 1e-6;

/**
 * A backstop, not a working limit: bisection alone halves the bracket every step, so
 * {@link INVERSE_TOLERANCE_TICKS} is reached from any real span within about fifty. Newton
 * normally arrives in four or five.
 */
const MAX_INVERSE_STEPS = 100;

/**
 * The tick date at which `targetMilliseconds` have elapsed since the start of `tempo`'s span —
 * the exact inverse of {@link millisecondsAt}, over the same unbounded domain.
 *
 * This was `approximateDate`, and issue #26 is the record of what it was approximating:
 *
 * - **It could not leave the span.** The guess started at `startDate`, and a target before it —
 *   which is what a note sounding ahead of its predecessor produces, so every arpeggio and every
 *   asynchrony — walked the guess backwards into the region where `millisecondsAt` was undefined.
 *   With a non-integer exponent that is `NaN`, and `Math.abs(NaN - target) > 1` is `false`, so
 *   the loop exited *reporting convergence* on its first step. With an integer one it was worse:
 *   the sign of Simpson's `resultConst` flips below `startDate`, so the elapsed time came back
 *   positive, the step kept pushing the same way, and a target of −200 ms landed 24 000 ticks
 *   from the answer. Both are fixed at the source — {@link millisecondsAt} is total now — and
 *   both ends of it invert in closed form, so the walk never has to leave the span at all.
 *
 * - **The step had the wrong units.** `guess += 0.1 * (targetMs - guessedMs)` adds milliseconds
 *   to a tick count. The constant 0.1 converges for ordinary tempi and diverges below about
 *   4 bpm per beat unit — at 2 bpm a 1 s target returned a tick 57 000 out. The step is now the
 *   Newton one, which is {@link ticksForConstantTempo} of the millisecond shortfall at the tempo
 *   holding where the guess stands: dimensionally right by construction, exact wherever the span
 *   is constant, and quadratic where it is not.
 *
 * - **It could not fail.** There was no convergence check and no bracket, so a thousand steps of
 *   a diverging iteration returned a plausible-looking tick number. `millisecondsAt` is strictly
 *   increasing, so the span's own ends bracket any target inside it; the bracket is kept and a
 *   Newton step that would leave it is replaced by bisection. That is `rtsafe`, and it cannot run
 *   away: every step either converges or at least halves the bracket. The only way out with a
 *   non-answer is a non-finite target, and that comes back as `NaN` rather than as a number.
 *
 * Which arm is taken is decided by {@link resolveSpan} rather than by a truthiness test on
 * `@transition.to` and `@meanTempoAt` here, and that is not a tidying-up: `meanTempoAt="0"`
 * resolves to a constant at `@transition.to`, and reading `0` as falsy inverted it at `@bpm`
 * instead — 1 000 ms came back as the tick where 667 ms had elapsed. A `@transition.to` with no
 * `@meanTempoAt` resolves to a *linear ramp*, and the closed form inverted that at `@bpm` too.
 * Both were wrong against the renderer, which is the only thing that decides whether a fit is
 * right.
 */
export const dateAtMilliseconds = (targetMilliseconds: number, tempo: ResolvedTempo): number => {
  // A caller that does not know the time it is asking about is not owed a tick that looks like
  // an answer. `NaN` is what the arithmetic downstream already refuses to write.
  if (!Number.isFinite(targetMilliseconds)) return NaN;

  const { startDate, endDate } = tempo;

  if (tempo.kind === 'constant') {
    return startDate + ticksForConstantTempo(targetMilliseconds, tempo);
  }

  // Outside the span `millisecondsAt` continues at the boundary tempo, so the inverse is
  // closed-form there too — and it is exactly the extrapolation the ornament frames rely on.
  if (targetMilliseconds <= 0) {
    return (
      startDate +
      ticksForConstantTempo(targetMilliseconds, {
        bpm: tempoAtClamped(tempo, startDate),
        beatLength: tempo.beatLength,
      })
    );
  }

  const spanMilliseconds = millisecondsAt(endDate, tempo);
  if (targetMilliseconds >= spanMilliseconds) {
    return (
      endDate +
      ticksForConstantTempo(targetMilliseconds - spanMilliseconds, {
        bpm: tempoAtClamped(tempo, endDate),
        beatLength: tempo.beatLength,
      })
    );
  }

  // Inside the curve, where there is no closed form. The target lies strictly between 0 and
  // the span's own elapsed time, so `[startDate, endDate]` brackets it.
  let low = startDate;
  let high = endDate;
  let guess =
    startDate +
    ticksForConstantTempo(targetMilliseconds, {
      bpm: tempoAtClamped(tempo, startDate),
      beatLength: tempo.beatLength,
    });
  if (!(guess > low && guess < high)) guess = (low + high) / 2;

  for (let step = 0; step < MAX_INVERSE_STEPS; step++) {
    const elapsed = millisecondsAt(guess, tempo);
    if (Math.abs(elapsed - targetMilliseconds) <= INVERSE_TOLERANCE_MS) return guess;

    if (elapsed < targetMilliseconds) low = guess;
    else high = guess;
    if (high - low <= INVERSE_TOLERANCE_TICKS) return guess;

    const newton =
      guess +
      ticksForConstantTempo(targetMilliseconds - elapsed, {
        bpm: tempoAtClamped(tempo, guess),
        beatLength: tempo.beatLength,
      });
    guess = newton > low && newton < high ? newton : (low + high) / 2;
  }

  return guess;
};

/**
 * The instantaneous tempo, in bpm, that `tempo` calls for at `date`.
 *
 * Outside the span the answer is the tempo at the nearer boundary — see {@link tempoAtClamped}
 * for why the curve is not continued past either end, and {@link millisecondsAt} for why mpmify
 * asks outside the span at all.
 */
export const getTempoAt = (date: number, tempo: TempoWithEndDate): number =>
  tempoAtClamped(resolveSpan(tempo), date);
