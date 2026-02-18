import { v4 } from "uuid";
import { MPM, Scope, Tempo } from "mpm-ts";
import { MSM, MsmNote } from "../../msm";
import { TempoWithEndDate } from "./tempoCalculations";
import { AbstractTransformer, generateId, ScopedTransformationOptions } from "../Transformer";

// ── Types ──────────────────────────────────────────────────────────

export type TempoSegment = {
    from: number
    to: number
    beatLength: number
}

export type SilentOnset = {
    date: number
    onset: number
}

export type ApproximateLogarithmicTempoOptions =
    ScopedTransformationOptions
    & {
        segments: TempoSegment[]
        silentOnsets: SilentOnset[]
    }

interface OnsetPair {
    date: number;       // score position in ticks
    onsetMs: number;    // physical time in ms (relative to chain start)
}

interface TempoPoint {
    position: number;   // score position in ticks
    bpm: number;
    weight: number;
}

interface DataPoint {
    x: number;          // normalised position within segment [0, 1]
    bpm: number;
    weight: number;
}

// ── Constants ──────────────────────────────────────────────────────

const W_TIMING = 0.1;
const W_SHAPE = 50000;
const W_BOUNDARY = 20;

// ── Main class ─────────────────────────────────────────────────────

/**
 * Inserts tempo instructions into the given part based on the
 * given beat length.  Uses Berndt's alternating optimisation
 * (deterministic power-function fitting).
 */
export class ApproximateLogarithmicTempo extends AbstractTransformer<ApproximateLogarithmicTempoOptions> {
    name = 'ApproximateLogarithmicTempo'
    requires = []

    constructor(options?: ApproximateLogarithmicTempoOptions) {
        super()

        this.options = options || {
            scope: 'global',
            segments: [],
            silentOnsets: []
        }
    }

    /**
     * Preview the fitted tempos without touching MSM/MPM.
     */
    static preview(options: ApproximateLogarithmicTempoOptions, msm: MSM): TempoWithEndDate[] {
        const notes = msm.notesInPart(options.scope);
        return fitSegments(options.segments, notes, options.silentOnsets);
    }

    protected transform(msm: MSM, mpm: MPM) {
        if (!msm.timeSignature) {
            console.warn('A time signature must be given to interpolate a tempo map.')
            return
        }

        msm.shiftToFirstOnset()

        const notes = msm.notesInPart(this.options.scope);
        const tempos = fitSegments(this.options.segments, notes, this.options.silentOnsets);

        // Remove existing tempo instructions across the full range
        if (this.options.segments.length > 0) {
            const fullRange: TempoSegment = {
                from: this.options.segments[0].from,
                to: this.options.segments[this.options.segments.length - 1].to,
                beatLength: this.options.segments[0].beatLength
            };
            this.removeAffectedTempoInstructions(mpm, this.options.scope, fullRange);
        }

        // Insert fitted tempos
        for (const tempo of tempos) {
            tempo['xml:id'] = generateId('tempo', tempo.date, mpm);
            mpm.insertInstruction(tempo, this.options?.scope, true);
        }
    }

    removeAffectedTempoInstructions(mpm: MPM, scope: Scope, segment: TempoSegment) {
        const tempos = mpm.getInstructions<Tempo>('tempo', scope)
        for (const tempo of tempos) {
            if (tempo.date >= segment.from && tempo.date < segment.to) {
                mpm.removeInstruction(tempo)
            }
        }
    }
}

// ── Pure fitting ───────────────────────────────────────────────────

/**
 * Fit one or more chained tempo segments from onset data.
 * Single segment: independent 2-boundary fit.
 * Multiple segments: joint optimisation with shared boundary tempos.
 */
function fitSegments(
    segments: TempoSegment[],
    notes: MsmNote[],
    silentOnsets: SilentOnset[]
): TempoWithEndDate[] {
    if (segments.length === 0) return [];

    // Build chain of boundary positions from segments
    const chain: number[] = [segments[0].from];
    for (const seg of segments) {
        chain.push(seg.to);
    }

    // Use beatLength from first segment (all segments in a chain share it)
    const beatLength = segments[0].beatLength;
    const beatLengthTicks = beatLength * 4 * 720;

    // Extract onset pairs across the full chain range
    const fullRange: TempoSegment = {
        from: chain[0],
        to: chain[chain.length - 1],
        beatLength
    };
    const onsetPairs = extractOnsetPairs(fullRange, notes, silentOnsets);
    if (onsetPairs.length < 2) return [];

    // Compute tempo points from IOI data
    const tempoPoints = computeTempoPoints(onsetPairs, beatLengthTicks);

    if (tempoPoints.length < 1) {
        // Fall back to constant tempo across the whole range
        const elapsed = onsetPairs[onsetPairs.length - 1].onsetMs - onsetPairs[0].onsetMs;
        const distTicks = onsetPairs[onsetPairs.length - 1].date - onsetPairs[0].date;
        const bpm = 60000 * distTicks / (elapsed * beatLengthTicks);

        return segments.map(seg => ({
            type: 'tempo' as const,
            'xml:id': `tempo_${v4()}`,
            bpm,
            date: seg.from,
            endDate: seg.to,
            beatLength
        }));
    }

    // Interpolate physical times at each boundary for timing constraints
    const boundaryTimesMs = chain.map(b => interpolatePhysicalTime(onsetPairs, b));

    // Initialise boundary tempos from data
    const tau = chain.map(b => estimateBoundaryTempo(tempoPoints, b));

    // Initialise shapes to 0.5 (linear) for each segment
    const nSeg = segments.length;
    const im = new Float64Array(nSeg).fill(0.5);

    // Partition tempo data into per-segment buckets
    const segData = partitionData(chain, tempoPoints);

    // Segment lengths in beats (for trapezoidal integration)
    const segLengthBeats = segments.map(seg =>
        (seg.to - seg.from) / beatLengthTicks
    );

    // ── Berndt alternating optimisation ──

    const MAX_ITER = 20;
    for (let iter = 0; iter < MAX_ITER; iter++) {
        // Step A: Optimise shapes (independent per segment)
        for (let k = 0; k < nSeg; k++) {
            const targetElapsed = boundaryTimesMs[k + 1] - boundaryTimesMs[k];
            im[k] = optimizeCombinedShape(
                tau[k], tau[k + 1], segData[k], segLengthBeats[k], targetElapsed
            );
        }

        // Step B: Optimise boundary tempos (tridiagonal system)
        const prevTau = tau.slice();
        solveBoundaryTempos(im, segData, tau, segLengthBeats, boundaryTimesMs);

        // Check convergence
        let maxDiff = 0;
        for (let i = 0; i < tau.length; i++) {
            maxDiff = Math.max(maxDiff, Math.abs(tau[i] - prevTau[i]));
        }
        if (maxDiff < 0.01) break;
    }

    // Build TempoWithEndDate array
    const results: TempoWithEndDate[] = [];
    for (let k = 0; k < nSeg; k++) {
        const t: TempoWithEndDate = {
            type: 'tempo',
            'xml:id': `tempo_${v4()}`,
            bpm: tau[k],
            date: segments[k].from,
            endDate: segments[k].to,
            beatLength,
            ...(Math.abs(tau[k] - tau[k + 1]) > 0.01
                ? { 'transition.to': tau[k + 1], meanTempoAt: im[k] }
                : {})
        };
        results.push(t);
    }

    return results;
}

// ── Data extraction ────────────────────────────────────────────────

/**
 * Collect all unique (date, ms) pairs from notes + silent onsets
 * within the given range, sorted by date.
 */
function extractOnsetPairs(
    range: TempoSegment,
    notes: MsmNote[],
    silentOnsets: SilentOnset[]
): OnsetPair[] {
    const pairMap = new Map<number, number>();

    // Collect from silent onsets
    for (const s of silentOnsets) {
        if (s.date >= range.from && s.date <= range.to) {
            pairMap.set(s.date, s.onset * 1000);
        }
    }

    // Collect from notes (notes take precedence if same date)
    for (const n of notes) {
        if (n.date >= range.from && n.date <= range.to && n["midi.onset"] !== undefined) {
            if (!pairMap.has(n.date)) {
                pairMap.set(n.date, n["midi.onset"] * 1000);
            }
        }
    }

    const pairs: OnsetPair[] = [];
    for (const [date, ms] of pairMap) {
        pairs.push({ date, onsetMs: ms });
    }
    pairs.sort((a, b) => a.date - b.date);

    // Make times relative to chain start
    if (pairs.length > 0) {
        const baseMs = pairs[0].onsetMs;
        for (const p of pairs) {
            p.onsetMs -= baseMs;
        }
    }

    return pairs;
}

/**
 * IOI-based BPM computation with metrical weighting.
 */
function computeTempoPoints(
    onsets: OnsetPair[],
    beatLengthTicks: number
): TempoPoint[] {
    const points: TempoPoint[] = [];

    for (let i = 0; i < onsets.length - 1; i++) {
        const deltaTicks = onsets[i + 1].date - onsets[i].date;
        const deltaMs = onsets[i + 1].onsetMs - onsets[i].onsetMs;

        if (deltaTicks <= 0 || deltaMs <= 0) continue;

        const bpm = 60000 * deltaTicks / (deltaMs * beatLengthTicks);
        if (bpm < 5 || bpm > 600) continue;

        const weight = Math.min(1, deltaTicks / beatLengthTicks);
        points.push({ position: onsets[i].date, bpm, weight });
    }

    return points;
}

/**
 * Partition tempo points into per-segment buckets.
 */
function partitionData(
    chain: number[],
    tempoPoints: TempoPoint[]
): DataPoint[][] {
    const nSeg = chain.length - 1;
    const segData: DataPoint[][] = Array.from({ length: nSeg }, () => []);

    for (const p of tempoPoints) {
        for (let k = 0; k < nSeg; k++) {
            if (p.position >= chain[k] && p.position < chain[k + 1]) {
                const span = chain[k + 1] - chain[k];
                segData[k].push({
                    x: (p.position - chain[k]) / span,
                    bpm: p.bpm,
                    weight: p.weight,
                });
                break;
            }
        }
        // Include points exactly at the last boundary in the last segment
        if (p.position === chain[chain.length - 1]) {
            segData[nSeg - 1].push({ x: 1, bpm: p.bpm, weight: p.weight });
        }
    }

    return segData;
}

/**
 * Linear interpolation for boundary tempo estimate.
 */
function estimateBoundaryTempo(
    points: TempoPoint[],
    boundary: number
): number {
    let leftPoint: TempoPoint | null = null;
    let rightPoint: TempoPoint | null = null;

    for (const p of points) {
        if (p.position <= boundary) {
            if (!leftPoint || p.position > leftPoint.position) {
                leftPoint = p;
            }
        }
        if (p.position >= boundary) {
            if (!rightPoint || p.position < rightPoint.position) {
                rightPoint = p;
            }
        }
    }

    if (!leftPoint && !rightPoint) return 60;
    if (!leftPoint) return rightPoint!.bpm;
    if (!rightPoint) return leftPoint.bpm;
    if (leftPoint.position === rightPoint.position) return leftPoint.bpm;

    const t = (boundary - leftPoint.position) / (rightPoint.position - leftPoint.position);
    return leftPoint.bpm + t * (rightPoint.bpm - leftPoint.bpm);
}

/**
 * Interpolate physical time at a given score position from onset data.
 */
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

// ── Berndt optimisation primitives ─────────────────────────────────

/**
 * Trapezoidal integration of elapsed time across a segment.
 * T(x) = t1 + (t2-t1)·x^p, elapsed = segLengthBeats · ∫₀¹ 60000/T(x) dx
 */
function computeSegmentElapsedMs(
    t1: number, t2: number, im: number, segLengthBeats: number
): number {
    const clamped = Math.max(0.001, Math.min(0.999, im));
    const p = Math.log(0.5) / Math.log(clamped);
    const steps = 200;
    let sum = 0;
    for (let i = 0; i < steps; i++) {
        const x0 = i / steps;
        const x1v = (i + 1) / steps;
        const T0 = t1 + (t2 - t1) * (x0 <= 0 ? 0 : Math.pow(x0, p));
        const T1 = t1 + (t2 - t1) * (x1v >= 1 ? 1 : Math.pow(x1v, p));
        sum += 0.5 * (60000 / T0 + 60000 / T1);
    }
    return sum * segLengthBeats / steps;
}

/**
 * Soft penalty for extreme shape values.
 * Zero in [0.1, 0.9], quadratic increase outside.
 */
function shapePenalty(im: number): number {
    let p = 0;
    if (im < 0.1) { const d = 0.1 - im; p += d * d; }
    if (im > 0.9) { const d = im - 0.9; p += d * d; }
    return p;
}

/**
 * Combined objective: tempo SSE + timing penalty + shape regularisation.
 */
function combinedShapeObjective(
    t1: number, t2: number, im: number,
    data: DataPoint[],
    segLengthBeats: number,
    targetElapsedMs: number
): number {
    const clamped = Math.max(0.001, Math.min(0.999, im));
    const p = Math.log(0.5) / Math.log(clamped);

    let sse = 0;
    for (const d of data) {
        const phi = d.x <= 0 ? 0 : d.x >= 1 ? 1 : Math.pow(d.x, p);
        const predicted = t1 * (1 - phi) + t2 * phi;
        const diff = predicted - d.bpm;
        sse += d.weight * diff * diff;
    }

    const elapsed = computeSegmentElapsedMs(t1, t2, im, segLengthBeats);
    const timingErr = elapsed - targetElapsedMs;

    return sse + W_TIMING * timingErr * timingErr + W_SHAPE * shapePenalty(im);
}

/**
 * Grid search (50 pts) + golden-section refinement for shape im.
 */
function optimizeCombinedShape(
    t1: number, t2: number,
    data: DataPoint[],
    segLengthBeats: number,
    targetElapsedMs: number
): number {
    if (Math.abs(t1 - t2) < 0.01 && data.length === 0) return 0.5;

    const obj = (im: number) =>
        combinedShapeObjective(t1, t2, im, data, segLengthBeats, targetElapsedMs);

    // Grid search
    const N = 50;
    let bestIm = 0.5;
    let bestF = Infinity;
    for (let i = 0; i <= N; i++) {
        const im = 0.02 + 0.96 * (i / N);
        const f = obj(im);
        if (f < bestF) { bestF = f; bestIm = im; }
    }

    // Golden-section refinement
    const phi = (1 + Math.sqrt(5)) / 2;
    const resphi = 2 - phi;
    let a = Math.max(0.02, bestIm - 0.05);
    let b = Math.min(0.98, bestIm + 0.05);
    let x1 = a + resphi * (b - a);
    let x2 = b - resphi * (b - a);
    let f1 = obj(x1);
    let f2 = obj(x2);

    for (let iter = 0; iter < 50; iter++) {
        if (f1 < f2) {
            b = x2; x2 = x1; f2 = f1;
            x1 = a + resphi * (b - a); f1 = obj(x1);
        } else {
            a = x1; x1 = x2; f1 = f2;
            x2 = b - resphi * (b - a); f2 = obj(x2);
        }
        if (Math.abs(b - a) < 1e-6) break;
    }

    return f1 < f2 ? x1 : x2;
}

/**
 * Solve for optimal boundary tempos given fixed shapes.
 * Builds tridiagonal normal equations and solves via Thomas algorithm.
 * Each τ[i] appears as t2 of segment i-1 and t1 of segment i,
 * enforcing tempo continuity at shared boundaries.
 */
function solveBoundaryTempos(
    shapes: Float64Array,
    segData: DataPoint[][],
    tau: number[],
    segLengthBeats: number[],
    boundaryTimesMs: number[]
): void {
    const n = tau.length;
    const nSeg = n - 1;
    const lambda = 0.01;

    // Tridiagonal matrix components
    const D = new Float64Array(n);
    const U = new Float64Array(n);
    const L = new Float64Array(n);
    const rhs = new Float64Array(n);

    // Regularisation: pull toward current estimates
    const tauInit = tau.slice();
    for (let i = 0; i < n; i++) {
        D[i] = lambda;
        rhs[i] = lambda * tauInit[i];
    }

    // Accumulate contributions from each segment (tempo data)
    for (let k = 0; k < nSeg; k++) {
        const im = Math.max(0.001, Math.min(0.999, shapes[k]));
        const p = Math.log(0.5) / Math.log(im);

        for (const d of segData[k]) {
            const phi = d.x <= 0 ? 0 : d.x >= 1 ? 1 : Math.pow(d.x, p);
            const a = 1 - phi;
            const c = phi;
            const w = d.weight;

            D[k] += w * a * a;
            D[k + 1] += w * c * c;
            U[k] += w * a * c;
            L[k + 1] += w * a * c;

            rhs[k] += w * d.bpm * a;
            rhs[k + 1] += w * d.bpm * c;
        }
    }

    // Linearised timing constraints
    const eps = 0.5;
    for (let k = 0; k < nSeg; k++) {
        const targetMs = boundaryTimesMs[k + 1] - boundaryTimesMs[k];
        const im = Math.max(0.001, Math.min(0.999, shapes[k]));

        const I0 = computeSegmentElapsedMs(tau[k], tau[k + 1], im, segLengthBeats[k]);

        const dI_dt1 = (
            computeSegmentElapsedMs(tau[k] + eps, tau[k + 1], im, segLengthBeats[k]) -
            computeSegmentElapsedMs(tau[k] - eps, tau[k + 1], im, segLengthBeats[k])
        ) / (2 * eps);
        const dI_dt2 = (
            computeSegmentElapsedMs(tau[k], tau[k + 1] + eps, im, segLengthBeats[k]) -
            computeSegmentElapsedMs(tau[k], tau[k + 1] - eps, im, segLengthBeats[k])
        ) / (2 * eps);

        const norm = Math.sqrt(dI_dt1 * dI_dt1 + dI_dt2 * dI_dt2);
        if (norm < 1e-10) continue;

        const a = dI_dt1 / norm;
        const b = dI_dt2 / norm;
        const c = (targetMs - I0 + dI_dt1 * tau[k] + dI_dt2 * tau[k + 1]) / norm;

        D[k] += W_BOUNDARY * a * a;
        D[k + 1] += W_BOUNDARY * b * b;
        U[k] += W_BOUNDARY * a * b;
        L[k + 1] += W_BOUNDARY * a * b;
        rhs[k] += W_BOUNDARY * c * a;
        rhs[k + 1] += W_BOUNDARY * c * b;
    }

    // Thomas algorithm (in-place)
    thomasSolve(L, D, U, rhs);

    // Write back
    for (let i = 0; i < n; i++) {
        tau[i] = rhs[i];
    }
}

/**
 * Thomas algorithm for tridiagonal system.
 * Solves L[i]·x[i-1] + D[i]·x[i] + U[i]·x[i+1] = rhs[i]
 * Solution is written back into rhs.
 */
function thomasSolve(
    lower: Float64Array,
    diag: Float64Array,
    upper: Float64Array,
    rhs: Float64Array
): void {
    const n = diag.length;
    if (n === 0) return;
    if (n === 1) {
        rhs[0] = rhs[0] / diag[0];
        return;
    }

    // Forward elimination
    for (let i = 1; i < n; i++) {
        const m = lower[i] / diag[i - 1];
        diag[i] -= m * upper[i - 1];
        rhs[i] -= m * rhs[i - 1];
    }

    // Back substitution
    rhs[n - 1] = rhs[n - 1] / diag[n - 1];
    for (let i = n - 2; i >= 0; i--) {
        rhs[i] = (rhs[i] - upper[i] * rhs[i + 1]) / diag[i];
    }
}
