import { v4 } from 'uuid';
import type { Tempo as ResolvedTempo } from 'espressivo';
import {
  getInstructions,
  Instruction,
  InstructionOptions,
  Mpm,
  removeInstruction,
  requireMap,
  Scope,
} from '../../mpm';
import { Alignment, AlignedNote } from '../../alignment';
import { TempoWithEndDate, getTempoAt, millisecondsAt, resolveSpan } from './tempoCalculations';
import { AbstractTransformer, generateId, ScopedTransformationOptions } from '../Transformer';
import { clamp } from '../../utils/utils';
import { beatLengthInTicks } from '../../ppq';

// ── Types ──────────────────────────────────────────────────────────

type TempoDirection = 'acc' | 'rit' | 'auto';

export type TempoSegment = {
  from: number;
  to: number;
  beatLength: number;
};

/** An anchor the caller places at a score date nothing sounds at — a rest, or a tied-over beat. */
export type SilentOnset = {
  date: number;
  /** When it falls, in milliseconds, on the same timeline as a note's `milliseconds.date`. */
  onset: number;
};

export type ApproximateLogarithmicTempoOptions = ScopedTransformationOptions &
  TempoSegment & {
    silentOnsets: SilentOnset[];
    continue?: boolean;
  };

interface OnsetPair {
  date: number; // score position in ticks
  onsetMs: number; // physical time in ms (relative to chain start)
}

interface SegmentOnset {
  ticks: number; // position within the segment, in ticks from its start
  elapsedMs: number; // observed elapsed time from segment start (ms)
  weight: number; // the onset's share of score time, capped at one beat
}

interface TempoPoint {
  position: number; // score position in ticks
  bpm: number;
  weight: number;
}

interface DataPoint {
  x: number; // normalised position within segment [0, 1]
  bpm: number;
  weight: number;
}

// ── Constants ──────────────────────────────────────────────────────

const MAX_ITER = 30; // outer Gauss–Newton iterations
const TAU_CONVERGENCE_BPM = 0.01; // stop once a joint step moves no boundary further than this

// The rank floor added to the normal equations, in the column-scaled space where every unknown
// the data constrains has unit curvature. It is a *floor*, not a prior with an opinion: it is
// invisible to a constrained unknown and it is the whole answer for one the data says nothing
// about. COLUMN_FLOOR is how small a column norm is still treated as a direction rather than as
// an empty one.
const RANK_FLOOR = 1e-8;
const COLUMN_FLOOR = 1e-12;
const GN_DAMPING_MIN = 1e-9; // Marquardt damping, in the column-scaled space
const GN_DAMPING_MAX = 1e6; // give up on a step once damping this heavy still will not factor
const GN_DAMPING_ESCALATION = 100;
const JACOBIAN_EPS_BPM = 0.5; // central-difference step for ∂(elapsed ms)/∂τ
const JACOBIAN_EPS_SHAPE = 1e-3; // …and for ∂(elapsed ms)/∂im
const LINE_SEARCH_HALVINGS = 10;
const SHAPE_CONVERGENCE = 1e-5; // stop once a joint step moves no shape further than this
const SHAPE_REFRESH_GAIN = 1e-9; // a re-seeded shape has to actually lower the objective

// The range `meanTempoAt` is fitted over, and — because they are the same range — the range it is
// written out over. A shape outside it is not a curve the renderer draws differently enough to be
// worth reaching for, and 0 or 1 exactly collapse the transition to a constant.
const SHAPE_MIN = 0.02;
const SHAPE_MAX = 0.98;
const SHAPE_GRID = 32; // bracketing grid for Step A

// The band an inter-onset interval has to fall in to be believed, and the band a fitted boundary
// tempo is held to. Below 5 BPM a beat lasts over twelve seconds; above 600 it is a flam.
const MIN_TAU_BPM = 5;
const MAX_TAU_BPM = 600;

const TURNING_PAIR_COUPLING = 0.8; // im_left + im_right ≈ 1 at turning boundaries
const TURNING_EPS = 0.02; // enforce strict side of 0.5 for rounded turning
const MIN_TURN_DELTA_BPM = 2; // ignore tiny direction changes
const MIN_DIRECTION_DELTA_BPM = 0.1; // enforced per-segment monotonicity margin
const MIN_INFERRED_DIRECTION_DELTA_BPM = 1.0; // minimum local trend to lock segment direction
const DIRECTION_T_STATISTIC = 2; // …and it has to beat this many standard errors of its own

// ── Main class ─────────────────────────────────────────────────────

/**
 * Inserts tempo instructions into the given part based on the
 * given beat length.  Uses Berndt power-function fitting with
 * alternating optimisation of shapes and boundary tempos.
 */
export class ApproximateLogarithmicTempo extends AbstractTransformer<ApproximateLogarithmicTempoOptions> {
  name = 'ApproximateLogarithmicTempo';
  requires = [];

  constructor(options?: ApproximateLogarithmicTempoOptions) {
    super(
      options || {
        scope: 'global',
        from: 0,
        to: 0,
        beatLength: 0.25,
        silentOnsets: [],
      },
    );
  }

  /**
   * Preview the fitted tempos without touching the alignment or the MPM.
   * When `options.continue` is true and an MPM is provided,
   * the chain is reconstructed so boundary tempos are shared
   * (matching the jointly-fitted result from `insert`).
   */
  static preview(
    options: ApproximateLogarithmicTempoOptions,
    msm: Alignment,
    mpm?: Mpm,
  ): TempoWithEndDate[] {
    const notes = msm.notesInPart(options.scope);
    const newSegment: TempoSegment = {
      from: options.from,
      to: options.to,
      beatLength: options.beatLength,
    };

    let segments: TempoSegment[];
    if (options.continue && mpm) {
      const chain = reconstructChain(mpm, options.scope, options.from, options.beatLength);
      segments = [...chain, newSegment];
    } else {
      segments = [newSegment];
    }

    return fitSegments(segments, notes, options.silentOnsets);
  }

  protected transform(msm: Alignment, mpm: Mpm) {
    if (!msm.timeSignature) {
      console.warn('A time signature must be given to interpolate a tempo map.');
      return;
    }

    msm.shiftToFirstOnset();

    const newSegment: TempoSegment = {
      from: this.options.from,
      to: this.options.to,
      beatLength: this.options.beatLength,
    };

    let segments: TempoSegment[];
    if (this.options.continue) {
      const chain = reconstructChain(
        mpm,
        this.options.scope,
        this.options.from,
        this.options.beatLength,
      );
      segments = [...chain, newSegment];
    } else {
      segments = [newSegment];
    }

    const notes = msm.notesInPart(this.options.scope);
    const tempos = fitSegments(segments, notes, this.options.silentOnsets);

    // If fitting produced no result, keep existing tempo instructions unchanged.
    if (tempos.length === 0) {
      return;
    }

    // Remove existing tempo instructions across the fitted replacement ranges.
    const replacementRanges = tempos
      .map((t) => ({ from: t.date, to: t.endDate, beatLength: t.beatLength }))
      .sort((a, b) => a.from - b.from);

    // Track whether an instruction already exists at the chain end before removal,
    // so we can clean up spurious restoration instructions afterward.
    const chainEnd = segments[segments.length - 1].to;
    const existedAtChainEnd =
      this.options.continue &&
      segments.length > 1 &&
      getInstructions(mpm, 'tempo', this.options.scope).some((t) => t.date === chainEnd);

    this.removeAffectedTempoInstructions(mpm, this.options.scope, replacementRanges);

    // Insert fitted tempos. `endDate` is the segment the curve was fitted over — a working
    // field, not an MPM attribute; it used to be written into the document. See old-bugs.md.
    //
    // `addTempo` appends rather than merging, and here that is the same thing. The
    // replacement ranges are `[from, to)` of the chain's own segments, so they tile
    // [chain start, chain end) exactly; every date written below is one of those `from`s and
    // so was just cleared. The only date the removal restores to is the chain end, which is
    // no segment's start.
    const map = requireMap(mpm, 'tempo', this.options.scope);
    for (const fitted of tempos) {
      const { endDate: _fittingWindow, ...tempo } = fitted;
      map.addTempo({ ...tempo, id: generateId('tempo', tempo.date, mpm) });
    }

    // When using continue, removeAffectedTempoInstructions may restore a
    // continuation at the chain end for an instruction that was part of the
    // old chain.  This is now superseded by the re-fitted chain, so remove it.
    if (this.options.continue && segments.length > 1 && !existedAtChainEnd) {
      const restored = getInstructions(mpm, 'tempo', this.options.scope).find(
        (t) => t.date === chainEnd,
      );
      if (restored) {
        removeInstruction(mpm, restored);
      }
    }

    // Close the chain.  Must come last: the cleanup above looks for an instruction at
    // exactly this date and would take the closing one for a stale restoration.
    this.closeTransition(mpm, tempos[tempos.length - 1]);
  }

  /**
   * Write the instruction that ends the fitted transition.
   *
   * A `transition.to` with no successor is not a curve stretched to the end of the piece —
   * the renderer drops the transition and holds `bpm`, so a fit that nothing happens to
   * follow renders at a flat tempo.  Within a chain each segment is closed by the next; the
   * last one has nothing after it and is closed here.
   *
   * An instruction already at that date already closes the span — the continuation
   * `removeAffectedTempoInstructions` restored, or one that was there all along — and is
   * left alone.
   */
  private closeTransition(mpm: Mpm, last: TempoWithEndDate) {
    const target = last.transitionTo;
    if (target === undefined || last.endDate <= last.date) return;

    const existing = getInstructions(mpm, 'tempo', this.options.scope);
    if (existing.some((tempo) => tempo.date === last.endDate)) return;

    requireMap(mpm, 'tempo', this.options.scope).addTempo({
      id: generateId('tempo', last.endDate, mpm),
      date: last.endDate,
      bpm: target,
      beatLength: last.beatLength,
    });
  }

  removeAffectedTempoInstructions(mpm: Mpm, scope: Scope, segments: TempoSegment[]) {
    if (segments.length === 0) return;

    const sortedRanges = segments.filter((s) => s.to > s.from).sort((a, b) => a.from - b.from);
    if (sortedRanges.length === 0) return;

    // Segments are half-open [from, to): touching is valid, overlap is not.
    for (let i = 1; i < sortedRanges.length; i++) {
      if (sortedRanges[i].from < sortedRanges[i - 1].to) {
        throw new Error(
          `Tempo segments overlap at index ${i - 1}/${i}: ` +
            `[${sortedRanges[i - 1].from}, ${sortedRanges[i - 1].to}) and ` +
            `[${sortedRanges[i].from}, ${sortedRanges[i].to}).`,
        );
      }
    }

    const existing = getInstructions(mpm, 'tempo', scope)
      .slice()
      .sort((a, b) => a.date - b.date);
    if (existing.length === 0) return;

    const isCovered = (date: number) =>
      sortedRanges.some((range) => date >= range.from && date < range.to);

    const restoreAtBoundaries: InstructionOptions<'tempo'>[] = [];
    for (const range of sortedRanges) {
      const boundary = range.to;

      // If another segment starts here, this boundary is already replaced.
      if (isCovered(boundary)) continue;

      // Existing instruction exactly at boundary already preserves continuation.
      if (existing.some((t) => t.date === boundary)) continue;

      const effectiveIndex = findEffectiveTempoIndex(existing, boundary);
      if (effectiveIndex === -1) continue;
      const effectiveTempo = existing[effectiveIndex];

      // Only restore if the effective source instruction will be removed.
      if (!isCovered(effectiveTempo.date)) continue;

      const next = existing[effectiveIndex + 1];
      const tempoWithEndDate: TempoWithEndDate = {
        ...effectiveTempo,
        endDate: next ? next.date : boundary,
      };
      const bpmAtBoundary = getTempoAt(boundary, tempoWithEndDate);

      restoreAtBoundaries.push({
        id: `tempo_${v4()}`,
        date: boundary,
        beatLength: effectiveTempo.beatLength,
        bpm: bpmAtBoundary,
      });
    }

    for (const tempo of existing) {
      if (isCovered(tempo.date)) {
        removeInstruction(mpm, tempo);
      }
    }

    // The map is there: `existing` was non-empty, or this returned above.
    const map = requireMap(mpm, 'tempo', scope);
    for (const tempo of restoreAtBoundaries) {
      map.addTempo({ ...tempo, id: generateId('tempo', tempo.date, mpm) });
    }
  }
}

// ── Chain reconstruction ──────────────────────────────────────────

/**
 * Walk backward through MPM tempo instructions to reconstruct the
 * contiguous chain of segments ending at `from` with matching `beatLength`.
 * Stops when beatLength changes or there is a gap in the chain.
 */
function reconstructChain(
  mpm: Mpm,
  scope: Scope,
  from: number,
  beatLength: number,
): TempoSegment[] {
  const allInstructions = getInstructions(mpm, 'tempo', scope)
    .filter((t) => t.date < from)
    .sort((a, b) => a.date - b.date);

  if (allInstructions.length === 0) return [];

  const chain: TempoSegment[] = [];
  let currentStart = from;

  for (let i = allInstructions.length - 1; i >= 0; i--) {
    const instr = allInstructions[i];

    // Stop if beatLength doesn't match
    if (instr.beatLength !== beatLength) break;

    // Determine the effective end of this instruction:
    // it's the next instruction's date, or `from` for the last one before `from`.
    const effectiveEnd = i < allInstructions.length - 1 ? allInstructions[i + 1].date : from;

    // Stop if not contiguous with the current chain start
    if (effectiveEnd !== currentStart) break;

    chain.unshift({
      from: instr.date,
      to: effectiveEnd,
      beatLength,
    });
    currentStart = instr.date;
  }

  return chain;
}

const findEffectiveTempoIndex = (tempos: Instruction<'tempo'>[], date: number): number => {
  let found = -1;
  for (let i = 0; i < tempos.length; i++) {
    if (tempos[i].date <= date) found = i;
    else break;
  }
  return found;
};

// ── Pure fitting ───────────────────────────────────────────────────

/**
 * Fit one or more chained tempo segments from onset data.
 *
 * ## One objective
 *
 * Berndt's scheme is alternating minimisation: fix the boundary tempos τ and choose each
 * segment's shape `im`, then fix the shapes and solve for τ. That only converges if the two
 * steps descend the *same* function. They used to descend different ones — Step A minimised
 * squared elapsed-millisecond error, Step B minimised squared BPM error against inter-onset
 * intervals, with the timing requirement bolted on as a linearised penalty of fixed weight — and
 * on an accelerando the pair diverged. Traced over the 30 iterations of a 60→120 fit, every
 * figure got monotonically worse: BPM SSE 3.1e2 → 7.9e2, elapsed SSE 3.4e5 → 7.5e5, segment
 * duration error 30 ms → 45 ms. The loop stopped because it ran out of iterations, and the answer
 * it returned was worse than the one it started from (issue #39).
 *
 * The divergence is directional, which is why ritardandi looked fine. Elapsed time is the
 * integral of 1/T, so it is dominated by the segment's *slow* end. On a ritardando the slow end
 * is τ₁, whose coefficient in the model is φ(x) = x^p — and φ grows as `im` shrinks, so the
 * parameter the timing depends on gains leverage as the shape moves and the loop self-corrects.
 * On an accelerando the slow end is τ₀, whose coefficient is 1 − φ, which *loses* leverage as
 * `im` shrinks. So a shape error drags τ₀ down, a low τ₀ makes the model start too slow, and
 * Step A answers by shrinking `im` further. The feedback is positive and it runs away.
 *
 * So there is now one objective, and it is the one that asks the question the fit exists to
 * answer — reproduce the performance:
 *
 *     F(τ, im) = Σ_k Σ_{i ∈ segment k} w_i · ( E_k(d_i; τ_k, τ_{k+1}, im_k) − Δt_i )²
 *
 * where E_k is the elapsed time the *renderer* produces and Δt_i the observed elapsed time from
 * the segment's start. Nothing is allowed to increase it. And once there is one objective there
 * is no reason to keep the two steps either — see the optimisation comment below for why the
 * boundary tempos and the shapes are now solved for together. Two things follow that are worth
 * stating:
 *
 * - `W_TIMING` is gone, and with it the balance the issue asked to rescale. The requirement that
 *   a segment take as long as it took is no longer a separate penalty term competing with the
 *   IOI term for influence: it is the residual at x = 1, one row among the others, weighted like
 *   its neighbours. Its influence therefore scales with the segment's data by construction
 *   rather than by a constant that had to be chosen.
 *
 * - The residuals are in milliseconds, which is the unit the observation is made in and the unit
 *   its noise is roughly constant in. A BPM residual is not: BPM is 1/Δt up to a constant, so a
 *   fixed timing jitter turns into a BPM error scaling as BPM², i.e. a variance scaling as BPM⁴.
 *   Least squares over BPM therefore assumed a noise model the data does not have, and it
 *   assumed it in the direction that matters — under-weighting exactly the slow passages that
 *   dominate elapsed time.
 *
 * ## What the renderer decides
 *
 * `E_k` is `millisecondsAt`, i.e. espressivo's own Simpson quadrature, not a trapezoid rule of
 * this module's. The two disagree: against an exact evaluation of the integral the renderer is
 * within 0.5 ms for `im ≥ 0.3` but drifts to ~8 ms on strongly concave shapes, and a fitter
 * chasing single-digit milliseconds cannot afford to be right about a curve nobody will play.
 * The same reasoning already governs `tempoCalculations`, and it is why the power function
 * itself no longer appears in this file at all.
 *
 * Data points use midpoint assignment to reduce IOI bias — but only for the initial estimate and
 * the direction inference. They no longer enter the fit.
 */
function fitSegments(
  segments: TempoSegment[],
  notes: AlignedNote[],
  silentOnsets: SilentOnset[],
): TempoWithEndDate[] {
  if (segments.length === 0) return [];

  const chainSegments = normalizeChainedSegments(segments);
  if (chainSegments.length === 0) return [];

  const chain: number[] = [chainSegments[0].from];
  for (const seg of chainSegments) chain.push(seg.to);

  const beatLength = chainSegments[0].beatLength;
  const beatLengthTicks = beatLengthInTicks(beatLength);

  const fullRange: TempoSegment = {
    from: chain[0],
    to: chain[chain.length - 1],
    beatLength,
  };
  const onsetPairs = extractOnsetPairs(fullRange, notes, silentOnsets);
  if (onsetPairs.length < 2) return [];

  const tempoPoints = computeTempoPoints(onsetPairs, beatLengthTicks);

  if (tempoPoints.length < 1) {
    const elapsed = onsetPairs[onsetPairs.length - 1].onsetMs - onsetPairs[0].onsetMs;
    const distTicks = onsetPairs[onsetPairs.length - 1].date - onsetPairs[0].date;
    const bpm = (60000 * distTicks) / (elapsed * beatLengthTicks);
    return chainSegments.map((seg) => ({
      id: `tempo_${v4()}`,
      bpm,
      date: seg.from,
      endDate: seg.to,
      beatLength,
    }));
  }

  const boundaryTimesMs = chain.map((b) => interpolatePhysicalTime(onsetPairs, b));

  const nSeg = chainSegments.length;
  const segData = partitionData(chain, tempoPoints);
  const segOnsets = partitionOnsets(chain, onsetPairs, boundaryTimesMs, beatLengthTicks);
  const inferredDirections = inferSegmentDirections(segData);
  const spanTicks = chainSegments.map((seg) => seg.to - seg.from);

  // Initialise boundary tempos via per-segment linear regression; the shapes follow from them
  // in the first step of the optimisation below.
  const tau = initBoundaryTempos(segData, chain.length);
  const tauInit = tau.slice();
  const shapes: number[] = new Array(nSeg).fill(0.5);
  enforceDirectionConstraints(tau, segData, inferredDirections);

  const objective = (candidateTau: number[], candidateShapes: number[]): number => {
    let total = 0;
    for (let k = 0; k < nSeg; k++) {
      total += segmentSse(
        segOnsets[k],
        candidateTau[k],
        candidateTau[k + 1],
        candidateShapes[k],
        spanTicks[k],
        beatLength,
      );
    }
    return total;
  };

  // ── Optimisation ──
  //
  // Not alternating. Berndt's scheme fixes τ to choose the shapes and then fixes the shapes to
  // solve for τ, and block-coordinate descent down a curved valley converges at a rate that can
  // be arbitrarily slow — which is what this objective has. At the initial estimate
  // τ = (50.3, 110.5) for a true 60 → 120, choosing the shape alone drops the error from
  // 1.5e7 to 3.4e5: the shape absorbs almost everything a wrong τ costs, leaving the τ step
  // almost no gradient to work with, and the pair creeps 0.13 BPM per iteration along the floor
  // of the valley. Thirty iterations of that got 4 BPM of the 10 it needed.
  //
  // The valley is an artefact of splitting the variables, so this does not split them. A
  // residual in segment k depends on τ_k, im_k and τ_{k+1} — three *consecutive* entries of
  // (τ₀, im₀, τ₁, im₁, …, τ_M) — so the joint JᵀJ is banded with half-bandwidth two, and one
  // banded Cholesky solves for every tempo and every shape at once in O(M). Along the valley
  // instead of across it, and quadratic near the optimum.
  //
  // Shapes are still seeded by a bracketed 1-D search, which is where global information enters:
  // Gauss–Newton is a local method and the shape is the parameter with a basin to find. The same
  // search runs again if the joint step stalls, and only a shape that lowers the objective is
  // taken.

  for (let k = 0; k < nSeg; k++) {
    shapes[k] = optimizeShape(
      segOnsets[k],
      tau[k],
      tau[k + 1],
      spanTicks[k],
      beatLength,
      undefined,
    );
  }
  projectState(tau, shapes, segData, inferredDirections);

  let bestTau = tau.slice();
  let bestShapes = shapes.slice();
  let bestObjective = objective(tau, shapes);

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const moved = jointGaussNewtonStep(
      segOnsets,
      tau,
      tauInit,
      shapes,
      spanTicks,
      beatLength,
      segData,
      inferredDirections,
      objective,
    );

    const current = objective(tau, shapes);
    if (current < bestObjective) {
      bestObjective = current;
      bestTau = tau.slice();
      bestShapes = shapes.slice();
    }

    if (moved.tau < TAU_CONVERGENCE_BPM && moved.shape < SHAPE_CONVERGENCE) {
      if (
        !refreshShapes(
          segOnsets,
          tau,
          shapes,
          spanTicks,
          beatLength,
          segData,
          inferredDirections,
          objective,
        )
      )
        break;
    }
  }

  // ── Build results ──

  const results: TempoWithEndDate[] = [];
  for (let k = 0; k < nSeg; k++) {
    const hasTransition = Math.abs(bestTau[k] - bestTau[k + 1]) > 0.01;

    const t: TempoWithEndDate = {
      id: `tempo_${v4()}`,
      bpm: bestTau[k],
      date: chainSegments[k].from,
      endDate: chainSegments[k].to,
      beatLength,
      ...(hasTransition
        ? {
            transitionTo: bestTau[k + 1],
            // Keep the optimized segment shape, so chain-level smoothing
            // survives into the exported meanTempoAt parameter.
            meanTempoAt: bestShapes[k],
          }
        : {}),
    };
    results.push(t);
  }

  return results;
}

function normalizeChainedSegments(segments: TempoSegment[]): TempoSegment[] {
  if (segments.length === 0) return [];

  const result: TempoSegment[] = [];
  for (let k = 0; k < segments.length; k++) {
    const source = segments[k];
    const from = k === 0 ? source.from : result[k - 1].to;
    if (k > 0 && source.from !== from) {
      console.warn(
        `Tempo segment chain is not contiguous at index ${k}: expected from=${from}, got ${source.from}. ` +
          `Using from=${from} to keep a valid chain.`,
      );
    }
    if (source.to <= from) {
      console.warn(
        `Invalid tempo segment at index ${k}: to (${source.to}) must be greater than from (${from}).`,
      );
      return [];
    }
    result.push({
      ...source,
      from,
    });
  }
  return result;
}

// ── Data extraction ────────────────────────────────────────────────

/**
 * The observed (score position, physical time) pairs over `range`.
 *
 * A chord is one onset, and which millisecond it happened at is a question about the chord and
 * not about whichever of its notes the alignment happens to list first. The notes of a chord are not
 * played together — spread and asynchrony are the point of a performance model — so taking the
 * first was taking an arbitrary member of a spread that can be tens of milliseconds wide. The
 * median is the answer that does not move when one voice is early, and on a two-note chord it is
 * the mean, which is the same thing.
 *
 * A silent onset still wins over any note at the same date: it is an explicit anchor the caller
 * placed, and the fit should believe it.
 */
function extractOnsetPairs(
  range: TempoSegment,
  notes: AlignedNote[],
  silentOnsets: SilentOnset[],
): OnsetPair[] {
  const sounding = new Map<number, number[]>();

  for (const n of notes) {
    if (n.date >= range.from && n.date <= range.to && n['milliseconds.date'] !== undefined) {
      const at = sounding.get(n.date);
      if (at) at.push(n['milliseconds.date']);
      else sounding.set(n.date, [n['milliseconds.date']]);
    }
  }

  const pairMap = new Map<number, number>();
  for (const [date, onsets] of sounding) pairMap.set(date, median(onsets));

  for (const s of silentOnsets) {
    if (s.date >= range.from && s.date <= range.to) {
      pairMap.set(s.date, s.onset);
    }
  }

  const pairs: OnsetPair[] = [];
  for (const [date, ms] of pairMap) pairs.push({ date, onsetMs: ms });
  pairs.sort((a, b) => a.date - b.date);

  if (pairs.length > 0) {
    const baseMs = pairs[0].onsetMs;
    for (const p of pairs) p.onsetMs -= baseMs;
  }

  return pairs;
}

function median(values: number[]): number {
  if (values.length === 1) return values[0];
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * IOI tempo estimates, one per pair of consecutive onsets, assigned to the interval's midpoint.
 *
 * These no longer enter the fit — they seed the boundary tempos and decide each segment's
 * direction, and nothing else. That is why the 5–600 BPM band is still here and still silent: it
 * keeps a grace note or a mis-aligned onset out of the *initial estimate*, which is the one place
 * a single wild interval could still send the search into the wrong basin. The fit itself is
 * already robust to one — every residual is measured from the segment's own start, so a displaced
 * onset spoils its own row and no other, where an IOI would have spoiled two.
 */
function computeTempoPoints(onsets: OnsetPair[], beatLengthTicks: number): TempoPoint[] {
  const points: TempoPoint[] = [];
  for (let i = 0; i < onsets.length - 1; i++) {
    const deltaTicks = onsets[i + 1].date - onsets[i].date;
    const deltaMs = onsets[i + 1].onsetMs - onsets[i].onsetMs;
    if (deltaTicks <= 0 || deltaMs <= 0) continue;
    const bpm = (60000 * deltaTicks) / (deltaMs * beatLengthTicks);
    if (bpm < MIN_TAU_BPM || bpm > MAX_TAU_BPM) continue;
    const weight = Math.min(1, deltaTicks / beatLengthTicks);
    // Assign to interval midpoint: the IOI BPM (harmonic mean)
    // approximates the instantaneous tempo at the midpoint.
    points.push({ position: (onsets[i].date + onsets[i + 1].date) / 2, bpm, weight });
  }
  return points;
}

function partitionData(chain: number[], tempoPoints: TempoPoint[]): DataPoint[][] {
  const nSeg = chain.length - 1;
  const segData: DataPoint[][] = Array.from({ length: nSeg }, () => []);
  for (const p of tempoPoints) {
    for (let k = 0; k < nSeg; k++) {
      if (p.position >= chain[k] && p.position < chain[k + 1]) {
        const span = chain[k + 1] - chain[k];
        segData[k].push({ x: (p.position - chain[k]) / span, bpm: p.bpm, weight: p.weight });
        break;
      }
    }
    if (p.position === chain[chain.length - 1]) {
      segData[nSeg - 1].push({ x: 1, bpm: p.bpm, weight: p.weight });
    }
  }
  return segData;
}

/**
 * Split the observed onsets across the chain, each one carrying the elapsed time from the start
 * of the segment it lands in, and the share of score time it speaks for.
 *
 * Measuring elapsed time from the *segment's own* observed boundary rather than from the start of
 * the chain is what keeps the problem tridiagonal: a residual then depends on two boundary tempos
 * and one shape, never on anything upstream, so the normal equations stay banded and Thomas still
 * solves them in O(n). It also stops timing error accumulating along a chain — each segment is
 * asked to take the time it took, not to make up for its predecessors.
 *
 * The weight is the onset's Voronoi share of score time, capped at one beat. It carries over what
 * the IOI weighting did — a sixteenth counts a quarter of a beat, four of them count one — so a
 * dense passage does not outvote a sparse one merely by having more notes in it, and the
 * subdivision level, where expressive displacement lives, does not outweigh the beat. Under that
 * weighting the objective is a Riemann sum of squared timing error against score time.
 *
 * A segment whose end falls between two onsets gets one synthetic anchor there, holding the
 * interpolated boundary time — this is the old timing constraint, now expressed as one more row
 * of the same least-squares problem instead of a penalty with a weight of its own. It is added
 * only where the boundary lies inside the observed range: past the last onset the interpolation
 * is a clamp, and an anchor built on it would assert that the rest of the segment takes no time.
 */
function partitionOnsets(
  chain: number[],
  onsetPairs: OnsetPair[],
  boundaryTimesMs: number[],
  beatLengthTicks: number,
): SegmentOnset[][] {
  const nSeg = chain.length - 1;
  const result: SegmentOnset[][] = Array.from({ length: nSeg }, () => []);
  const weights = onsetShares(onsetPairs, beatLengthTicks);
  const lastObserved = onsetPairs[onsetPairs.length - 1].date;

  for (let i = 0; i < onsetPairs.length; i++) {
    const onset = onsetPairs[i];
    for (let k = 0; k < nSeg; k++) {
      if (onset.date >= chain[k] && onset.date <= chain[k + 1]) {
        result[k].push({
          ticks: onset.date - chain[k],
          elapsedMs: onset.onsetMs - boundaryTimesMs[k],
          weight: weights[i],
        });
        break;
      }
    }
  }

  for (let k = 0; k < nSeg; k++) {
    const endTicks = chain[k + 1] - chain[k];
    if (chain[k + 1] > lastObserved) continue;
    if (result[k].some((o) => o.ticks === endTicks)) continue;
    result[k].push({
      ticks: endTicks,
      elapsedMs: boundaryTimesMs[k + 1] - boundaryTimesMs[k],
      weight: 1,
    });
  }

  return result;
}

/** Each onset's share of score time — half of each neighbouring gap — capped at one beat. */
function onsetShares(onsetPairs: OnsetPair[], beatLengthTicks: number): number[] {
  const n = onsetPairs.length;
  const shares = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const before = i > 0 ? onsetPairs[i].date - onsetPairs[i - 1].date : 0;
    const after = i < n - 1 ? onsetPairs[i + 1].date - onsetPairs[i].date : 0;
    // The outermost onsets have one neighbour, so their share is that whole gap rather than
    // half of it: they are the ends of the span, not points inside it.
    const share = i === 0 ? after : i === n - 1 ? before : (before + after) / 2;
    shares[i] = Math.min(1, share / beatLengthTicks);
  }
  return shares;
}

/**
 * The weighted least-squares line `bpm = intercept + slope·x` through `data`, and how well the
 * slope is determined.
 *
 * Degenerate where the weighted x-variance vanishes — one distinct x, or one point carrying all
 * the weight — and the honest answer there is the weighted mean with no slope, which is what the
 * `det` guard returns. Written once because both callers want the same fit and differ only in
 * which half of it they read: `initBoundaryTempos` wants the endpoints, and
 * `inferSegmentDirections` wants the slope, which over a normalised x is the same number as the
 * endpoint difference — together with its standard error, because a slope is only evidence of a
 * direction if it is larger than its own uncertainty.
 */
function weightedLinearFit(data: DataPoint[]): {
  intercept: number;
  slope: number;
  slopeStdError: number;
} {
  let sw = 0,
    swx = 0,
    swy = 0,
    swxx = 0,
    swxy = 0;
  for (const d of data) {
    sw += d.weight;
    swx += d.weight * d.x;
    swy += d.weight * d.bpm;
    swxx += d.weight * d.x * d.x;
    swxy += d.weight * d.x * d.bpm;
  }

  const det = sw * swxx - swx * swx;
  if (Math.abs(det) < 1e-10) return { intercept: swy / sw, slope: 0, slopeStdError: Infinity };

  const intercept = (swxx * swy - swx * swxy) / det;
  const slope = (sw * swxy - swx * swy) / det;

  // Var(slope) = σ² · sw/det, with σ² estimated from the weighted residuals. Two points
  // determine a line exactly, leaving nothing to estimate σ² from, so the slope carries no
  // evidence at all and the error is infinite rather than zero.
  const dof = data.length - 2;
  if (dof <= 0) return { intercept, slope, slopeStdError: Infinity };

  let rss = 0;
  for (const d of data) {
    const residual = d.bpm - (intercept + slope * d.x);
    rss += d.weight * residual * residual;
  }
  return { intercept, slope, slopeStdError: Math.sqrt(((rss / dof) * sw) / det) };
}

function initBoundaryTempos(segData: DataPoint[][], nBoundaries: number): number[] {
  const nSeg = nBoundaries - 1;
  const tau = new Array(nBoundaries).fill(0);
  const counts = new Array(nBoundaries).fill(0);

  for (let k = 0; k < nSeg; k++) {
    const data = segData[k];
    if (data.length === 0) continue;

    if (data.length === 1) {
      // Single point: constant tempo
      tau[k] += data[0].bpm;
      tau[k + 1] += data[0].bpm;
      counts[k]++;
      counts[k + 1]++;
      continue;
    }

    const { intercept: a, slope: b } = weightedLinearFit(data);

    tau[k] += a; // value at x = 0
    tau[k + 1] += a + b; // value at x = 1
    counts[k]++;
    counts[k + 1]++;
  }

  for (let i = 0; i < nBoundaries; i++) {
    tau[i] = counts[i] > 0 ? clamp(tau[i] / counts[i], MIN_TAU_BPM, MAX_TAU_BPM) : 60;
  }
  return tau;
}

function interpolatePhysicalTime(onsets: OnsetPair[], date: number): number {
  if (onsets.length === 0) return 0;
  if (date <= onsets[0].date) return onsets[0].onsetMs;
  if (date >= onsets[onsets.length - 1].date) return onsets[onsets.length - 1].onsetMs;
  for (let i = 0; i < onsets.length - 1; i++) {
    if (date >= onsets[i].date && date <= onsets[i + 1].date) {
      const span = onsets[i + 1].date - onsets[i].date;
      if (span === 0) return onsets[i].onsetMs;
      const frac = (date - onsets[i].date) / span;
      return onsets[i].onsetMs + frac * (onsets[i + 1].onsetMs - onsets[i].onsetMs);
    }
  }
  return onsets[onsets.length - 1].onsetMs;
}

// ── Forward model ────────────────────────────────────────────────
//
// The curve this file fits is the renderer's, evaluated by the renderer. There is no power
// function here any more, and that is the point: a fit measured against a quadrature nobody
// plays is precise about the wrong number. See the header of `tempoCalculations`.

/** One candidate segment, resolved the way the renderer resolves it. */
function segmentCurve(
  tau0: number,
  tau1: number,
  im: number,
  spanTicks: number,
  beatLength: number,
): ResolvedTempo {
  return resolveSpan({
    date: 0,
    endDate: spanTicks,
    beatLength,
    bpm: tau0,
    transitionTo: tau1,
    meanTempoAt: im,
  });
}

/** The elapsed time the renderer produces at each onset of a segment, in order. */
function segmentElapsed(
  onsets: SegmentOnset[],
  tau0: number,
  tau1: number,
  im: number,
  spanTicks: number,
  beatLength: number,
): Float64Array {
  const curve = segmentCurve(tau0, tau1, im, spanTicks, beatLength);
  const out = new Float64Array(onsets.length);
  for (let i = 0; i < onsets.length; i++) out[i] = millisecondsAt(onsets[i].ticks, curve);
  return out;
}

/** One segment's contribution to the objective. */
function segmentSse(
  onsets: SegmentOnset[],
  tau0: number,
  tau1: number,
  im: number,
  spanTicks: number,
  beatLength: number,
): number {
  if (onsets.length === 0) return 0;
  const curve = segmentCurve(tau0, tau1, im, spanTicks, beatLength);
  let sse = 0;
  for (const onset of onsets) {
    const diff = millisecondsAt(onset.ticks, curve) - onset.elapsedMs;
    sse += onset.weight * diff * diff;
  }
  return sse;
}

// ── Step A: shape optimisation ───────────────────────────────────

/**
 * Optimise the shape parameter im for a single segment, with its boundary tempos held fixed.
 *
 * Deterministic: a grid coarse enough to be cheap and fine enough to bracket the minimum, then
 * golden-section refinement inside that bracket. What it replaces was 500 steps of simulated
 * annealing on the first pass and golden section afterwards — an arrangement its own docstring
 * described as eliminating "SA jitter from the alternating loop so boundary tempos converge
 * cleanly", which is a fair description of a search that was fighting itself.
 *
 * Annealing was insurance against a multi-modal landscape, and with the objective settled the
 * landscape does not need it. Every residual is *strictly monotone* in im: p = ln½/ln(im)
 * increases with im, φ(x) = x^p decreases in p on (0,1), so the modelled elapsed time moves one
 * way in im at every interior position and the other way for the opposite direction of travel.
 * A sum of squares of co-monotone residuals has its minimum where their weighted average changes
 * sign, and a bracketing grid finds it.
 *
 * The search runs over exactly the range that can be written out, so the value fitted is the
 * value the document gets; it used to be clamped afterwards, which could quietly move the shape
 * away from the one that was measured.
 *
 * @param hint  Shape from the previous alternating iteration, tried as an extra candidate.
 */
function optimizeShape(
  segOnsets: SegmentOnset[],
  tau0: number,
  tau1: number,
  spanTicks: number,
  beatLength: number,
  hint: number | undefined,
): number {
  if (Math.abs(tau0 - tau1) < 0.01) return 0.5;

  // An onset at the segment's own start has zero elapsed time under every shape.
  const effective = segOnsets.filter((o) => o.ticks > 0);
  if (effective.length === 0) return 0.5;

  const objective = (im: number) => segmentSse(effective, tau0, tau1, im, spanTicks, beatLength);

  const step = (SHAPE_MAX - SHAPE_MIN) / SHAPE_GRID;
  let bestIm = SHAPE_MIN;
  let bestVal = objective(SHAPE_MIN);
  let bestIndex = 0;
  for (let g = 1; g <= SHAPE_GRID; g++) {
    const im = SHAPE_MIN + g * step;
    const val = objective(im);
    if (val < bestVal) {
      bestVal = val;
      bestIm = im;
      bestIndex = g;
    }
  }

  let lo = SHAPE_MIN + Math.max(0, bestIndex - 1) * step;
  let hi = SHAPE_MIN + Math.min(SHAPE_GRID, bestIndex + 1) * step;

  if (hint !== undefined && hint > SHAPE_MIN && hint < SHAPE_MAX) {
    const hintVal = objective(hint);
    if (hintVal < bestVal) {
      bestVal = hintVal;
      bestIm = hint;
      lo = Math.max(SHAPE_MIN, hint - step);
      hi = Math.min(SHAPE_MAX, hint + step);
    }
  }

  const gr = (Math.sqrt(5) + 1) / 2;
  for (let iter = 0; iter < 60; iter++) {
    if (hi - lo < 1e-6) break;
    const c = hi - (hi - lo) / gr;
    const d = lo + (hi - lo) / gr;
    if (objective(c) < objective(d)) hi = d;
    else lo = c;
  }

  const refined = (lo + hi) / 2;
  return objective(refined) < bestVal ? refined : bestIm;
}

/**
 * Which segments sit either side of a turning boundary, and so have their shape decided by the
 * rounding prior rather than by the data.
 *
 * The joint step needs to know. `regularizeTurningPairs` moves those shapes *after* a step is
 * proposed, and a Gauss–Newton direction that does not know it will be overruled spends its shape
 * component on a move that is about to be undone — the candidate then misses on both counts and
 * the line search rejects every step size, leaving the fit stationary at boundary tempos chosen
 * for shapes it no longer has. On a linear 100 → 70 → 110 valley that was the entire error: the
 * tempos came back to within 0.02 BPM of the truth and the onsets were 32 ms out, because the
 * only thing wrong was two shapes nudged to 0.48 and 0.52 that nothing was allowed to answer.
 * Held out of the step, those shapes stay where the prior put them and every tempo adapts around
 * them. The data still gets its say, through {@link refreshShapes}, which re-proposes them at the
 * current tempos and keeps the proposal only if it lowers the objective.
 */
function turningPairShapes(tau: number[], nSeg: number): boolean[] {
  const pinned = new Array<boolean>(nSeg).fill(false);
  for (let b = 1; b < nSeg; b++) {
    if (!isTurningBoundary(tau, b)) continue;
    pinned[b - 1] = true;
    pinned[b] = true;
  }
  return pinned;
}

function isTurningBoundary(tau: number[], b: number): boolean {
  const leftDelta = tau[b] - tau[b - 1];
  const rightDelta = tau[b + 1] - tau[b];
  if (leftDelta * rightDelta >= 0) return false;
  return Math.min(Math.abs(leftDelta), Math.abs(rightDelta)) >= MIN_TURN_DELTA_BPM;
}

/**
 * At sign-change boundaries (rit→acc or acc→rit), enforce a rounded gesture.
 *
 * We apply a proximal step for:
 *   (x-imL)^2 + (y-imR)^2 + λ (x + y - 1)^2
 * then project to:
 *   x < 0.5, y > 0.5
 *
 * This yields an anti-symmetric pair around 0.5 and avoids cusp-like joints.
 */
function regularizeTurningPairs(shapes: number[], tau: number[]): void {
  const nSeg = shapes.length;
  if (nSeg < 2) return;

  for (let b = 1; b < nSeg; b++) {
    if (!isTurningBoundary(tau, b)) continue;

    const left = shapes[b - 1];
    const right = shapes[b];

    const det = 1 + 2 * TURNING_PAIR_COUPLING;
    let regLeft =
      ((1 + TURNING_PAIR_COUPLING) * left - TURNING_PAIR_COUPLING * right + TURNING_PAIR_COUPLING) /
      det;
    let regRight =
      ((1 + TURNING_PAIR_COUPLING) * right - TURNING_PAIR_COUPLING * left + TURNING_PAIR_COUPLING) /
      det;

    regLeft = clamp(regLeft, SHAPE_MIN, SHAPE_MAX);
    regRight = clamp(regRight, SHAPE_MIN, SHAPE_MAX);

    regLeft = Math.min(regLeft, 0.5 - TURNING_EPS);
    regRight = Math.max(regRight, 0.5 + TURNING_EPS);

    shapes[b - 1] = regLeft;
    shapes[b] = regRight;
  }
}

/**
 * Which segments have a direction confident enough to hold them to.
 *
 * The evidence is the initial regression through a segment's IOI tempi, and it is now asked to
 * clear two bars rather than one: the trend has to be musically visible (a BPM or more across
 * the segment) *and* larger than twice its own standard error. The size test alone is not a test
 * of confidence — three IOIs scattered over 40 BPM produce a large slope routinely, and the
 * direction it points is noise. Locking on that put a permanent constraint on the fit, applied
 * again after the alternating loop had finished, on the strength of an estimate nobody had asked
 * for an error bar.
 *
 * A segment with fewer than three points has no residual degrees of freedom, so its standard
 * error is infinite and its direction stays `auto` — two points always make a perfect line, and
 * a perfect line is not evidence.
 */
function inferSegmentDirections(segData: DataPoint[][]): TempoDirection[] {
  const directions: TempoDirection[] = [];
  for (const data of segData) {
    if (data.length < 2) {
      directions.push('auto');
      continue;
    }

    // x is normalised to [0,1], so the slope equals τ_right − τ_left.
    const { slope, slopeStdError } = weightedLinearFit(data);
    const confident =
      Math.abs(slope) >= MIN_INFERRED_DIRECTION_DELTA_BPM &&
      Math.abs(slope) >= DIRECTION_T_STATISTIC * slopeStdError;

    directions.push(confident ? (slope > 0 ? 'acc' : 'rit') : 'auto');
  }
  return directions;
}

function enforceDirectionConstraints(
  tau: number[],
  segData: DataPoint[][],
  directions: TempoDirection[],
): void {
  if (directions.length === 0) return;
  if (!directions.some((d) => d !== 'auto')) return;

  const boundaryWeights = buildBoundaryWeights(segData, tau.length);
  const maxPasses = Math.max(6, directions.length * 4);
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;

    for (let k = 0; k < directions.length; k++) {
      const direction = directions[k];
      changed =
        projectDirectionPair(
          tau,
          k,
          k + 1,
          direction,
          boundaryWeights[k],
          boundaryWeights[k + 1],
        ) || changed;
    }

    for (let k = directions.length - 1; k >= 0; k--) {
      const direction = directions[k];
      changed =
        projectDirectionPair(
          tau,
          k,
          k + 1,
          direction,
          boundaryWeights[k],
          boundaryWeights[k + 1],
        ) || changed;
    }

    if (!changed) break;
  }
}

function buildBoundaryWeights(segData: DataPoint[][], nBoundaries: number): number[] {
  const weights = new Array(nBoundaries).fill(1e-3);
  for (let k = 0; k < segData.length; k++) {
    let segWeight = 0;
    for (const d of segData[k]) segWeight += d.weight;
    const w = Math.max(1e-3, segWeight);
    weights[k] += w;
    weights[k + 1] += w;
  }
  return weights;
}

function projectDirectionPair(
  tau: number[],
  leftIdx: number,
  rightIdx: number,
  direction: TempoDirection,
  wLeft: number,
  wRight: number,
): boolean {
  if (direction === 'auto') return false;

  const left = tau[leftIdx];
  const right = tau[rightIdx];
  const delta = right - left;
  const denom = Math.max(1e-9, wLeft + wRight);

  if (direction === 'acc') {
    const violation = MIN_DIRECTION_DELTA_BPM - delta;
    if (violation <= 0) return false;
    tau[leftIdx] -= violation * (wRight / denom);
    tau[rightIdx] += violation * (wLeft / denom);
    return true;
  }

  const violation = delta + MIN_DIRECTION_DELTA_BPM;
  if (violation <= 0) return false;
  tau[leftIdx] += violation * (wRight / denom);
  tau[rightIdx] -= violation * (wLeft / denom);
  return true;
}

// ── The joint step ──────────────────────────────────────────────

/**
 * Put a candidate state back inside the set the fit is allowed to answer from.
 *
 * Bounds first, then the direction constraints, then the turning-pair coupling — applied once,
 * identically, to every candidate the line search tries, so what the search compares is the
 * objective on states the fit could actually return. The direction projection used to run outside
 * the solve entirely, including once more after the loop had finished, where nothing measured
 * what it cost.
 */
function projectState(
  tau: number[],
  shapes: number[],
  segData: DataPoint[][],
  directions: TempoDirection[],
): void {
  for (let i = 0; i < tau.length; i++) tau[i] = clamp(tau[i], MIN_TAU_BPM, MAX_TAU_BPM);
  for (let k = 0; k < shapes.length; k++) shapes[k] = clamp(shapes[k], SHAPE_MIN, SHAPE_MAX);
  enforceDirectionConstraints(tau, segData, directions);
  for (let i = 0; i < tau.length; i++) tau[i] = clamp(tau[i], MIN_TAU_BPM, MAX_TAU_BPM);
  regularizeTurningPairs(shapes, tau);
}

/**
 * One projected, damped Gauss–Newton step over every boundary tempo and every shape at once.
 *
 * ## Why it is banded
 *
 * Each residual is the elapsed time from its *own* segment's observed start, so it depends on
 * τ_k, im_k and τ_{k+1} and on nothing upstream. Ordering the unknowns as
 * (τ₀, im₀, τ₁, im₁, …, τ_M) puts those three at consecutive indices, so every row of the
 * Jacobian has three adjacent non-zeros and JᵀJ has half-bandwidth two. A banded Cholesky solves
 * it in O(M). Anchoring each segment at its own observed boundary rather than at the start of the
 * chain is what buys this — and it also stops timing error accumulating along a chain, since each
 * segment is asked to take the time it took rather than to make up for its predecessors.
 *
 * ## The three regularisers
 *
 * - **Marquardt damping**, applied in the column-scaled space and raised only when a step fails.
 * - **A rank floor** pulling to the initial regression estimate for a tempo and to a linear ramp
 *   for a shape. It answers a boundary or a shape no data speaks for, and it does nothing
 *   whatsoever to one the data constrains. See the note at the assembly for why the scaling it is
 *   expressed in is the part that matters.
 * - **A backtracking line search over the projected candidate**, so the accepted step is feasible
 *   *and* strictly lowers the objective. This is what makes the loop a descent method: it cannot
 *   return something worse than it started with, which is exactly what the alternating version
 *   did — 30 iterations of monotonically increasing error, stopped only by running out of
 *   iterations (issue #39).
 *
 * The Jacobian is taken by central differences on the renderer rather than in closed form,
 * because the renderer is the model: its Simpson rule picks its own sub-interval count from the
 * span, and differentiating a hand copy of it would reintroduce exactly the drift
 * `tempoCalculations` was rewritten to remove. Seven evaluations per segment covers it.
 *
 * @returns how far the tempos and the shapes moved — zero when no step improved the objective.
 */
function jointGaussNewtonStep(
  segOnsets: SegmentOnset[][],
  tau: number[],
  tauInit: number[],
  shapes: number[],
  spanTicks: number[],
  beatLength: number,
  segData: DataPoint[][],
  directions: TempoDirection[],
  objective: (tau: number[], shapes: number[]) => number,
): { tau: number; shape: number } {
  const nSeg = shapes.length;
  const m = 2 * nSeg + 1;
  const pinned = turningPairShapes(tau, nSeg);

  // Symmetric band storage: band[d][i] is the entry at (i, i + d).
  const band = [new Float64Array(m), new Float64Array(m), new Float64Array(m)];
  const gradient = new Float64Array(m);

  for (let k = 0; k < nSeg; k++) {
    const onsets = segOnsets[k];
    if (onsets.length === 0) continue;

    const span = spanTicks[k];
    const t0 = tau[k],
      t1 = tau[k + 1],
      im = shapes[k];
    const epsTau0 = Math.max(JACOBIAN_EPS_BPM, Math.abs(t0) * 1e-3);
    const epsTau1 = Math.max(JACOBIAN_EPS_BPM, Math.abs(t1) * 1e-3);
    const imUp = Math.min(SHAPE_MAX, im + JACOBIAN_EPS_SHAPE);
    const imDown = Math.max(SHAPE_MIN, im - JACOBIAN_EPS_SHAPE);

    const here = segmentElapsed(onsets, t0, t1, im, span, beatLength);
    const empty = new Float64Array(onsets.length);
    const partials: [Float64Array, Float64Array, number][] = [
      [
        segmentElapsed(onsets, t0 + epsTau0, t1, im, span, beatLength),
        segmentElapsed(onsets, t0 - epsTau0, t1, im, span, beatLength),
        2 * epsTau0,
      ],
      // A shape the rounding prior owns has no column: the step must not spend itself on a
      // move that `projectState` is about to undo.
      pinned[k]
        ? [empty, empty, 0]
        : [
            segmentElapsed(onsets, t0, t1, imUp, span, beatLength),
            segmentElapsed(onsets, t0, t1, imDown, span, beatLength),
            imUp - imDown,
          ],
      [
        segmentElapsed(onsets, t0, t1 + epsTau1, im, span, beatLength),
        segmentElapsed(onsets, t0, t1 - epsTau1, im, span, beatLength),
        2 * epsTau1,
      ],
    ];

    const jacobian = new Float64Array(3);
    for (let i = 0; i < onsets.length; i++) {
      const w = onsets[i].weight;
      if (w <= 0) continue;
      const residual = here[i] - onsets[i].elapsedMs;
      for (let a = 0; a < 3; a++) {
        const [up, down, denom] = partials[a];
        jacobian[a] = denom > 0 ? (up[i] - down[i]) / denom : 0;
      }
      // τ_k, im_k and τ_{k+1} sit at 2k, 2k+1 and 2k+2 — three consecutive unknowns.
      for (let a = 0; a < 3; a++) {
        gradient[2 * k + a] -= w * jacobian[a] * residual;
        for (let b = a; b < 3; b++) {
          band[b - a][2 * k + a] += w * jacobian[a] * jacobian[b];
        }
      }
    }
  }

  let scale = 0;
  for (let i = 0; i < m; i++) scale = Math.max(scale, band[0][i]);
  if (!(scale > 0)) return { tau: 0, shape: 0 };

  // Column scaling — Marquardt's, and not optional here. BPM and a shape parameter in [0,1] are
  // not commensurable, and the columns of J say so: on a sixteen-beat accelerando the shape's
  // curvature is 4.1e8 and the arrival tempo's is 9.0e3, a ratio of 46 000. Any floor or damping
  // expressed as a fraction of the *largest* curvature is therefore several per cent of the
  // smallest — enough to cancel most of the data's own gradient there and leave the fit
  // stationary five BPM and 0.15 of a shape short of a curve it can represent exactly. Dividing
  // each row and column by its own norm first puts every unknown the data constrains at unit
  // curvature, and a floor of 1e-8 then means 1e-8 to all of them alike.
  const norm = new Float64Array(m);
  for (let i = 0; i < m; i++) norm[i] = Math.sqrt(Math.max(band[0][i], COLUMN_FLOOR * scale));

  for (let d = 0; d < band.length; d++) {
    for (let i = 0; i + d < m; i++) band[d][i] /= norm[i] * norm[i + d];
  }
  for (let i = 0; i < m; i++) {
    const segment = (i - 1) / 2;
    const current = i % 2 === 0 ? tau[i / 2] : shapes[segment];
    // A shape the rounding prior owns is its own reference, so the floor leaves it alone
    // rather than dragging it back to linear through a column the data no longer fills.
    const reference = i % 2 === 0 ? tauInit[i / 2] : pinned[segment] ? current : 0.5;
    gradient[i] = gradient[i] / norm[i] - RANK_FLOOR * norm[i] * (current - reference);
  }

  const scaledDiagonal = Float64Array.from(band[0]);
  for (let i = 0; i < m; i++) scaledDiagonal[i] += RANK_FLOOR;

  const before = objective(tau, shapes);
  const candidateTau = new Array<number>(tau.length);
  const candidateShapes = new Array<number>(nSeg);

  for (let damping = GN_DAMPING_MIN; damping <= GN_DAMPING_MAX; damping *= GN_DAMPING_ESCALATION) {
    for (let i = 0; i < m; i++) band[0][i] = scaledDiagonal[i] + damping;
    const scaledDelta = solveBanded(band, gradient);
    if (!scaledDelta) continue;
    const delta = scaledDelta.map((v, i) => v / norm[i]);

    for (let trial = 0, stepSize = 1; trial <= LINE_SEARCH_HALVINGS; trial++, stepSize /= 2) {
      for (let i = 0; i < tau.length; i++) candidateTau[i] = tau[i] + stepSize * delta[2 * i];
      for (let k = 0; k < nSeg; k++) candidateShapes[k] = shapes[k] + stepSize * delta[2 * k + 1];
      projectState(candidateTau, candidateShapes, segData, directions);

      if (objective(candidateTau, candidateShapes) < before) {
        let tauMoved = 0,
          shapeMoved = 0;
        for (let i = 0; i < tau.length; i++) {
          tauMoved = Math.max(tauMoved, Math.abs(candidateTau[i] - tau[i]));
          tau[i] = candidateTau[i];
        }
        for (let k = 0; k < nSeg; k++) {
          shapeMoved = Math.max(shapeMoved, Math.abs(candidateShapes[k] - shapes[k]));
          shapes[k] = candidateShapes[k];
        }
        return { tau: tauMoved, shape: shapeMoved };
      }
    }
  }

  return { tau: 0, shape: 0 };
}

/**
 * Re-seed each segment's shape from the global bracketed search, keeping only what helps.
 *
 * Gauss–Newton is local. This is the one place global information about the shape re-enters, and
 * it runs where it is worth running: when the joint step has stopped moving. A shape is taken
 * only if it lowers the objective on its own, so the call either finds real progress — and says
 * so, to keep the loop going — or leaves the fit exactly where it was.
 */
function refreshShapes(
  segOnsets: SegmentOnset[][],
  tau: number[],
  shapes: number[],
  spanTicks: number[],
  beatLength: number,
  segData: DataPoint[][],
  directions: TempoDirection[],
  objective: (tau: number[], shapes: number[]) => number,
): boolean {
  const before = objective(tau, shapes);
  const candidateTau = tau.slice();
  const candidateShapes = shapes.slice();

  for (let k = 0; k < shapes.length; k++) {
    candidateShapes[k] = optimizeShape(
      segOnsets[k],
      tau[k],
      tau[k + 1],
      spanTicks[k],
      beatLength,
      shapes[k],
    );
  }
  projectState(candidateTau, candidateShapes, segData, directions);

  if (!(objective(candidateTau, candidateShapes) < before - SHAPE_REFRESH_GAIN)) return false;

  for (let i = 0; i < tau.length; i++) tau[i] = candidateTau[i];
  for (let k = 0; k < shapes.length; k++) shapes[k] = candidateShapes[k];
  return true;
}

/**
 * Cholesky solve of a symmetric band system with half-bandwidth two, stored as
 * `band[d][i] = A(i, i + d)`.
 *
 * Returns `null` where the factorisation meets a non-positive pivot, which says the damped system
 * is not positive definite and the caller should damp harder — the alternative, pushing a
 * plausible-looking vector back out of an unstable elimination, is how a solve reports a step
 * nobody can use as though it were an answer. Band storage is left untouched so the retry can
 * reuse it.
 */
function solveBanded(band: Float64Array[], rhs: Float64Array): Float64Array | null {
  const n = rhs.length;
  const p = band.length - 1;
  // R is upper triangular with RᵀR = A, in the same band storage.
  const r = band.map(() => new Float64Array(n));

  for (let i = 0; i < n; i++) {
    for (let j = i; j <= Math.min(i + p, n - 1); j++) {
      let sum = band[j - i][i];
      for (let k = Math.max(0, i - p); k < i; k++) {
        if (j - k <= p) sum -= r[i - k][k] * r[j - k][k];
      }
      if (j === i) {
        if (!(sum > 0)) return null;
        r[0][i] = Math.sqrt(sum);
      } else {
        r[j - i][i] = sum / r[0][i];
      }
    }
  }

  // Rᵀ y = rhs
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = rhs[i];
    for (let k = Math.max(0, i - p); k < i; k++) sum -= r[i - k][k] * y[k];
    y[i] = sum / r[0][i];
  }

  // R x = y
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let j = i + 1; j <= Math.min(i + p, n - 1); j++) sum -= r[j - i][i] * x[j];
    x[i] = sum / r[0][i];
  }
  return x;
}
