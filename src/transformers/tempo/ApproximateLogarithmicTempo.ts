import { v4 } from "uuid";
import { MPM, Scope, Tempo } from "mpm-ts";
import { MSM, MsmNote } from "../../msm";
import { TempoWithEndDate, getTempoAt } from "./tempoCalculations";
import { AbstractTransformer, generateId, ScopedTransformationOptions } from "../Transformer";

// ── Types ──────────────────────────────────────────────────────────

type TempoDirection = 'acc' | 'rit' | 'auto'

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
    & TempoSegment
    & {
        silentOnsets: SilentOnset[]
        continue?: boolean
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

const W_TIMING = 5;      // timing constraint weight
const W_SHAPE = 500;     // shape regularisation weight
const LAMBDA = 0.01;     // Tikhonov regularisation
const TURNING_PAIR_COUPLING = 0.8;  // im_left + im_right ≈ 1 at turning boundaries
const TURNING_EPS = 0.02;           // enforce strict side of 0.5 for rounded turning
const MIN_TURN_DELTA_BPM = 2;       // ignore tiny direction changes
const MIN_DIRECTION_DELTA_BPM = 0.1; // enforced per-segment monotonicity margin
const MIN_INFERRED_DIRECTION_DELTA_BPM = 1.0; // minimum local trend to lock segment direction

// ── Main class ─────────────────────────────────────────────────────

/**
 * Inserts tempo instructions into the given part based on the
 * given beat length.  Uses Berndt power-function fitting with
 * alternating optimisation of shapes and boundary tempos.
 */
export class ApproximateLogarithmicTempo extends AbstractTransformer<ApproximateLogarithmicTempoOptions> {
    name = 'ApproximateLogarithmicTempo'
    requires = []

    constructor(options?: ApproximateLogarithmicTempoOptions) {
        super()

        this.options = options || {
            scope: 'global',
            from: 0,
            to: 0,
            beatLength: 0.25,
            silentOnsets: []
        }
    }

    /**
     * Preview the fitted tempos without touching MSM/MPM.
     * When `options.continue` is true and an MPM is provided,
     * the chain is reconstructed so boundary tempos are shared
     * (matching the jointly-fitted result from `insert`).
     */
    static preview(options: ApproximateLogarithmicTempoOptions, msm: MSM, mpm?: MPM): TempoWithEndDate[] {
        const notes = msm.notesInPart(options.scope);
        const newSegment: TempoSegment = { from: options.from, to: options.to, beatLength: options.beatLength };

        let segments: TempoSegment[];
        if (options.continue && mpm) {
            const chain = reconstructChain(mpm, options.scope, options.from, options.beatLength);
            segments = [...chain, newSegment];
        } else {
            segments = [newSegment];
        }

        return fitSegments(segments, notes, options.silentOnsets);
    }

    protected transform(msm: MSM, mpm: MPM) {
        if (!msm.timeSignature) {
            console.warn('A time signature must be given to interpolate a tempo map.')
            return
        }

        msm.shiftToFirstOnset()

        const newSegment: TempoSegment = {
            from: this.options.from,
            to: this.options.to,
            beatLength: this.options.beatLength
        };

        let segments: TempoSegment[];
        if (this.options.continue) {
            const chain = reconstructChain(mpm, this.options.scope, this.options.from, this.options.beatLength);
            segments = [...chain, newSegment];
        } else {
            segments = [newSegment];
        }

        const notes = msm.notesInPart(this.options.scope);
        const tempos = fitSegments(segments, notes, this.options.silentOnsets);

        // If fitting produced no result, keep existing tempo instructions unchanged.
        if (tempos.length === 0) {
            return
        }

        // Remove existing tempo instructions across the fitted replacement ranges.
        const replacementRanges = tempos
            .map(t => ({ from: t.date, to: t.endDate, beatLength: t.beatLength }))
            .sort((a, b) => a.from - b.from);

        // Track whether an instruction already exists at the chain end before removal,
        // so we can clean up spurious restoration instructions afterward.
        const chainEnd = segments[segments.length - 1].to;
        const existedAtChainEnd = this.options.continue && segments.length > 1
            && mpm.getInstructions<Tempo>('tempo', this.options.scope).some(t => t.date === chainEnd);

        this.removeAffectedTempoInstructions(mpm, this.options.scope, replacementRanges);

        // Insert fitted tempos
        for (const tempo of tempos) {
            tempo['xml:id'] = generateId('tempo', tempo.date, mpm);
            mpm.insertInstruction(tempo, this.options?.scope, true);
        }

        // When using continue, removeAffectedTempoInstructions may restore a
        // continuation at the chain end for an instruction that was part of the
        // old chain.  This is now superseded by the re-fitted chain, so remove it.
        if (this.options.continue && segments.length > 1 && !existedAtChainEnd) {
            const restored = mpm.getInstructions<Tempo>('tempo', this.options.scope)
                .find(t => t.date === chainEnd);
            if (restored) {
                mpm.removeInstruction(restored);
            }
        }
    }

    removeAffectedTempoInstructions(mpm: MPM, scope: Scope, segments: TempoSegment[]) {
        if (segments.length === 0) return;

        const sortedRanges = segments
            .filter(s => s.to > s.from)
            .sort((a, b) => a.from - b.from);
        if (sortedRanges.length === 0) return;

        // Segments are half-open [from, to): touching is valid, overlap is not.
        for (let i = 1; i < sortedRanges.length; i++) {
            if (sortedRanges[i].from < sortedRanges[i - 1].to) {
                throw new Error(
                    `Tempo segments overlap at index ${i - 1}/${i}: ` +
                    `[${sortedRanges[i - 1].from}, ${sortedRanges[i - 1].to}) and ` +
                    `[${sortedRanges[i].from}, ${sortedRanges[i].to}).`
                );
            }
        }

        const existing = mpm.getInstructions<Tempo>('tempo', scope)
            .slice()
            .sort((a, b) => a.date - b.date);
        if (existing.length === 0) return;

        const isCovered = (date: number) =>
            sortedRanges.some(range => date >= range.from && date < range.to);

        const restoreAtBoundaries: Tempo[] = [];
        for (const range of sortedRanges) {
            const boundary = range.to;

            // If another segment starts here, this boundary is already replaced.
            if (isCovered(boundary)) continue;

            // Existing instruction exactly at boundary already preserves continuation.
            if (existing.some(t => t.date === boundary)) continue;

            const effectiveIndex = findEffectiveTempoIndex(existing, boundary);
            if (effectiveIndex === -1) continue;
            const effectiveTempo = existing[effectiveIndex];

            // Only restore if the effective source instruction will be removed.
            if (!isCovered(effectiveTempo.date)) continue;

            const next = existing[effectiveIndex + 1];
            const tempoWithEndDate: TempoWithEndDate = {
                ...effectiveTempo,
                endDate: next ? next.date : boundary
            };
            const bpmAtBoundary = getTempoAt(boundary, tempoWithEndDate);

            restoreAtBoundaries.push({
                type: 'tempo',
                'xml:id': `tempo_${v4()}`,
                date: boundary,
                beatLength: effectiveTempo.beatLength,
                bpm: bpmAtBoundary
            });
        }

        for (const tempo of existing) {
            if (isCovered(tempo.date)) {
                mpm.removeInstruction(tempo)
            }
        }

        for (const tempo of restoreAtBoundaries) {
            tempo['xml:id'] = generateId('tempo', tempo.date, mpm);
            mpm.insertInstruction(tempo, scope, false);
        }
    }
}

// ── Chain reconstruction ──────────────────────────────────────────

/**
 * Walk backward through MPM tempo instructions to reconstruct the
 * contiguous chain of segments ending at `from` with matching `beatLength`.
 * Stops when beatLength changes or there is a gap in the chain.
 */
function reconstructChain(mpm: MPM, scope: Scope, from: number, beatLength: number): TempoSegment[] {
    const allInstructions = mpm.getInstructions<Tempo>('tempo', scope)
        .filter(t => t.date < from)
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
        const effectiveEnd = (i < allInstructions.length - 1)
            ? allInstructions[i + 1].date
            : from;

        // Stop if not contiguous with the current chain start
        if (effectiveEnd !== currentStart) break;

        chain.unshift({
            from: instr.date,
            to: effectiveEnd,
            beatLength
        });
        currentStart = instr.date;
    }

    return chain;
}

const findEffectiveTempoIndex = (tempos: Tempo[], date: number): number => {
    let found = -1;
    for (let i = 0; i < tempos.length; i++) {
        if (tempos[i].date <= date) found = i;
        else break;
    }
    return found;
}

// ── Pure fitting ───────────────────────────────────────────────────

/**
 * Fit one or more chained tempo segments from onset data.
 * Uses Berndt (2010) alternating optimisation:
 *   Step A — fix τ, optimise shape im per segment (1D)
 *   Step B — fix im, solve for τ jointly (scalar tridiagonal)
 *
 * Data points use midpoint assignment to reduce IOI bias.
 */
function fitSegments(
    segments: TempoSegment[],
    notes: MsmNote[],
    silentOnsets: SilentOnset[]
): TempoWithEndDate[] {
    if (segments.length === 0) return [];

    const chainSegments = normalizeChainedSegments(segments);
    if (chainSegments.length === 0) return [];

    const chain: number[] = [chainSegments[0].from];
    for (const seg of chainSegments) chain.push(seg.to);

    const beatLength = chainSegments[0].beatLength;
    const beatLengthTicks = beatLength * 4 * 720;

    const fullRange: TempoSegment = {
        from: chain[0], to: chain[chain.length - 1], beatLength
    };
    const onsetPairs = extractOnsetPairs(fullRange, notes, silentOnsets);
    if (onsetPairs.length < 2) return [];

    const tempoPoints = computeTempoPoints(onsetPairs, beatLengthTicks);

    if (tempoPoints.length < 1) {
        const elapsed = onsetPairs[onsetPairs.length - 1].onsetMs - onsetPairs[0].onsetMs;
        const distTicks = onsetPairs[onsetPairs.length - 1].date - onsetPairs[0].date;
        const bpm = 60000 * distTicks / (elapsed * beatLengthTicks);
        return chainSegments.map(seg => ({
            type: 'tempo' as const,
            'xml:id': `tempo_${v4()}`,
            bpm, date: seg.from, endDate: seg.to, beatLength
        }));
    }

    const boundaryTimesMs = chain.map(b => interpolatePhysicalTime(onsetPairs, b));

    const nSeg = chainSegments.length;
    const segData = partitionData(chain, tempoPoints);
    const inferredDirections = inferSegmentDirections(segData);

    // Initialise boundary tempos via per-segment linear regression
    const tau = initBoundaryTempos(segData, chain.length);
    const tauInit = tau.slice();
    const segLengthBeats = chainSegments.map(seg => (seg.to - seg.from) / beatLengthTicks);

    // Initialise shapes to linear (im = 0.5)
    const shapes: number[] = new Array(nSeg).fill(0.5);
    enforceDirectionConstraints(tau, segData, inferredDirections);

    // ── Alternating optimisation ──

    const MAX_ITER = 30;
    for (let iter = 0; iter < MAX_ITER; iter++) {
        const prevTau = tau.slice();

        // Step A: fix τ, optimise each shape im independently
        for (let k = 0; k < nSeg; k++) {
            shapes[k] = optimizeShape(
                segData[k], tau[k], tau[k + 1],
                boundaryTimesMs[k + 1] - boundaryTimesMs[k],
                segLengthBeats[k]
            );
        }
        regularizeTurningPairs(shapes, tau);

        // Step B: fix shapes, solve for τ jointly
        solveBoundaryTempos(
            segData, tau, tauInit, shapes,
            segLengthBeats, boundaryTimesMs
        );
        enforceDirectionConstraints(tau, segData, inferredDirections);

        let maxDiff = 0;
        for (let i = 0; i < tau.length; i++) {
            maxDiff = Math.max(maxDiff, Math.abs(tau[i] - prevTau[i]));
        }
        if (maxDiff < 0.01) break;
    }

    enforceDirectionConstraints(tau, segData, inferredDirections);

    // ── Build results ──

    const results: TempoWithEndDate[] = [];
    for (let k = 0; k < nSeg; k++) {
        const hasTransition = Math.abs(tau[k] - tau[k + 1]) > 0.01;

        const t: TempoWithEndDate = {
            type: 'tempo',
            'xml:id': `tempo_${v4()}`,
            bpm: tau[k],
            date: chainSegments[k].from,
            endDate: chainSegments[k].to,
            beatLength,
            ...(hasTransition
                ? {
                    'transition.to': tau[k + 1],
                    // Keep the optimized segment shape, so chain-level smoothing
                    // survives into the exported meanTempoAt parameter.
                    meanTempoAt: clamp(shapes[k], 0.02, 0.98)
                }
                : {})
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
                `Using from=${from} to keep a valid chain.`
            );
        }
        if (source.to <= from) {
            console.warn(
                `Invalid tempo segment at index ${k}: to (${source.to}) must be greater than from (${from}).`
            );
            return [];
        }
        result.push({
            ...source,
            from
        });
    }
    return result;
}

// ── Data extraction ────────────────────────────────────────────────

function extractOnsetPairs(
    range: TempoSegment, notes: MsmNote[], silentOnsets: SilentOnset[]
): OnsetPair[] {
    const pairMap = new Map<number, number>();

    for (const s of silentOnsets) {
        if (s.date >= range.from && s.date <= range.to) {
            pairMap.set(s.date, s.onset * 1000);
        }
    }

    for (const n of notes) {
        if (n.date >= range.from && n.date <= range.to && n["midi.onset"] !== undefined) {
            if (!pairMap.has(n.date)) {
                pairMap.set(n.date, n["midi.onset"] * 1000);
            }
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

function computeTempoPoints(onsets: OnsetPair[], beatLengthTicks: number): TempoPoint[] {
    const points: TempoPoint[] = [];
    for (let i = 0; i < onsets.length - 1; i++) {
        const deltaTicks = onsets[i + 1].date - onsets[i].date;
        const deltaMs = onsets[i + 1].onsetMs - onsets[i].onsetMs;
        if (deltaTicks <= 0 || deltaMs <= 0) continue;
        const bpm = 60000 * deltaTicks / (deltaMs * beatLengthTicks);
        if (bpm < 5 || bpm > 600) continue;
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
 * Initialise boundary tempos via per-segment weighted linear regression.
 * For each segment, fit BPM = a + b·x on normalised data, giving
 * τ_left = a (at x=0) and τ_right = a + b (at x=1).
 * Shared boundaries average the estimates from adjacent segments.
 */
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

        // Weighted linear regression: BPM = a + b·x
        let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
        for (const d of data) {
            sw += d.weight;
            swx += d.weight * d.x;
            swy += d.weight * d.bpm;
            swxx += d.weight * d.x * d.x;
            swxy += d.weight * d.x * d.bpm;
        }
        const det = sw * swxx - swx * swx;
        let a: number, b: number;
        if (Math.abs(det) < 1e-10) {
            a = swy / sw;
            b = 0;
        } else {
            a = (swxx * swy - swx * swxy) / det;
            b = (sw * swxy - swx * swy) / det;
        }

        tau[k] += a;         // value at x = 0
        tau[k + 1] += a + b; // value at x = 1
        counts[k]++;
        counts[k + 1]++;
    }

    for (let i = 0; i < nBoundaries; i++) {
        tau[i] = counts[i] > 0 ? tau[i] / counts[i] : 60;
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

// ── Power-function model ─────────────────────────────────────────

function powerBasis(x: number, im: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const p = Math.log(0.5) / Math.log(Math.max(0.001, Math.min(0.999, im)));
    return Math.pow(x, p);
}

function clamp(value: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, value));
}

function computePowerElapsedMs(
    t1: number, t2: number, im: number, segLengthBeats: number
): number {
    const steps = 200;
    let sum = 0;
    for (let i = 0; i < steps; i++) {
        const x0 = i / steps;
        const x1v = (i + 1) / steps;
        const T0 = t1 + (t2 - t1) * powerBasis(x0, im);
        const T1 = t1 + (t2 - t1) * powerBasis(x1v, im);
        sum += 0.5 * (60000 / T0 + 60000 / T1);
    }
    return sum * segLengthBeats / steps;
}

// ── Step A: shape optimisation (1D per segment) ─────────────────

function shapePenalty(im: number): number {
    if (im < 0.1) return (0.1 - im) * (0.1 - im);
    if (im > 0.9) return (im - 0.9) * (im - 0.9);
    return 0;
}

function optimizeShape(
    data: DataPoint[],
    tau0: number, tau1: number,
    targetElapsedMs: number, segLengthBeats: number
): number {
    if (Math.abs(tau0 - tau1) < 0.01) return 0.5;

    function objective(im: number): number {
        let sse = 0;
        for (const d of data) {
            const phi = powerBasis(d.x, im);
            const Tmodel = tau0 * (1 - phi) + tau1 * phi;
            sse += d.weight * (Tmodel - d.bpm) * (Tmodel - d.bpm);
        }
        const elapsed = computePowerElapsedMs(tau0, tau1, im, segLengthBeats);
        const timingErr = elapsed - targetElapsedMs;
        return sse + W_TIMING * timingErr * timingErr + W_SHAPE * shapePenalty(im);
    }

    // Grid search over 51 points in [0.02, 0.98]
    let bestIm = 0.5;
    let bestVal = objective(0.5);
    for (let g = 0; g <= 50; g++) {
        const im = 0.02 + g * 0.96 / 50;
        const val = objective(im);
        if (val < bestVal) { bestVal = val; bestIm = im; }
    }

    // Golden-section refinement in ±0.05 neighbourhood
    let lo = Math.max(0.02, bestIm - 0.05);
    let hi = Math.min(0.98, bestIm + 0.05);
    const gr = (Math.sqrt(5) + 1) / 2;
    for (let iter = 0; iter < 50; iter++) {
        if (hi - lo < 1e-6) break;
        const c = hi - (hi - lo) / gr;
        const d = lo + (hi - lo) / gr;
        if (objective(c) < objective(d)) hi = d; else lo = c;
    }
    return (lo + hi) / 2;
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
        const leftDelta = tau[b] - tau[b - 1];
        const rightDelta = tau[b + 1] - tau[b];
        if (leftDelta * rightDelta >= 0) continue;
        if (Math.min(Math.abs(leftDelta), Math.abs(rightDelta)) < MIN_TURN_DELTA_BPM) continue;

        const left = shapes[b - 1];
        const right = shapes[b];

        const det = 1 + 2 * TURNING_PAIR_COUPLING;
        let regLeft = ((1 + TURNING_PAIR_COUPLING) * left - TURNING_PAIR_COUPLING * right + TURNING_PAIR_COUPLING) / det;
        let regRight = ((1 + TURNING_PAIR_COUPLING) * right - TURNING_PAIR_COUPLING * left + TURNING_PAIR_COUPLING) / det;

        regLeft = clamp(regLeft, 0.02, 0.98);
        regRight = clamp(regRight, 0.02, 0.98);

        regLeft = Math.min(regLeft, 0.5 - TURNING_EPS);
        regRight = Math.max(regRight, 0.5 + TURNING_EPS);

        shapes[b - 1] = regLeft;
        shapes[b] = regRight;
    }
}

function inferSegmentDirections(segData: DataPoint[][]): TempoDirection[] {
    const directions: TempoDirection[] = [];
    for (const data of segData) {
        const delta = estimateSegmentBoundaryDelta(data);
        if (delta === null || Math.abs(delta) < MIN_INFERRED_DIRECTION_DELTA_BPM) {
            directions.push('auto');
        } else {
            directions.push(delta > 0 ? 'acc' : 'rit');
        }
    }
    return directions;
}

function estimateSegmentBoundaryDelta(data: DataPoint[]): number | null {
    if (data.length < 2) return null;

    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
    for (const d of data) {
        sw += d.weight;
        swx += d.weight * d.x;
        swy += d.weight * d.bpm;
        swxx += d.weight * d.x * d.x;
        swxy += d.weight * d.x * d.bpm;
    }

    const det = sw * swxx - swx * swx;
    if (Math.abs(det) < 1e-10) return 0;

    const slope = (sw * swxy - swx * swy) / det;
    // x is normalised to [0,1], so this equals τ_right - τ_left.
    return slope;
}

function enforceDirectionConstraints(
    tau: number[],
    segData: DataPoint[][],
    directions: TempoDirection[]
): void {
    if (directions.length === 0) return;
    if (!directions.some(d => d !== 'auto')) return;

    const boundaryWeights = buildBoundaryWeights(segData, tau.length);
    const maxPasses = Math.max(6, directions.length * 4);
    for (let pass = 0; pass < maxPasses; pass++) {
        let changed = false;

        for (let k = 0; k < directions.length; k++) {
            const direction = directions[k];
            changed = projectDirectionPair(
                tau,
                k,
                k + 1,
                direction,
                boundaryWeights[k],
                boundaryWeights[k + 1]
            ) || changed;
        }

        for (let k = directions.length - 1; k >= 0; k--) {
            const direction = directions[k];
            changed = projectDirectionPair(
                tau,
                k,
                k + 1,
                direction,
                boundaryWeights[k],
                boundaryWeights[k + 1]
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
    wRight: number
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

// ── Step B: boundary tempo optimisation (scalar tridiagonal) ────

/**
 * With shapes fixed, the model T_k(x) = (1−φ_k(x))·τ_k + φ_k(x)·τ_{k+1}
 * is linear in τ, giving a tridiagonal normal-equations system.
 * Includes linearised timing constraints and Tikhonov regularisation.
 */
function solveBoundaryTempos(
    segData: DataPoint[][],
    tau: number[],
    tauInit: number[],
    shapes: number[],
    segLengthBeats: number[],
    boundaryTimesMs: number[]
): void {
    const n = tau.length;
    const nSeg = n - 1;

    const D = new Float64Array(n);
    const Up = new Float64Array(n);
    const Lo = new Float64Array(n);
    const rhs = new Float64Array(n);

    // Tikhonov regularisation: λ ||τ − τ₀||²
    for (let i = 0; i < n; i++) {
        D[i] += LAMBDA;
        rhs[i] += LAMBDA * tauInit[i];
    }

    // Data contributions (weighted least squares)
    for (let k = 0; k < nSeg; k++) {
        const im = shapes[k];
        for (const d of segData[k]) {
            const phi = powerBasis(d.x, im);
            const a = 1 - phi;   // coeff for τ_k
            const c = phi;       // coeff for τ_{k+1}
            const w = d.weight;

            D[k] += w * a * a;
            D[k + 1] += w * c * c;
            Up[k] += w * a * c;
            Lo[k + 1] += w * a * c;
            rhs[k] += w * d.bpm * a;
            rhs[k + 1] += w * d.bpm * c;
        }
    }

    // Linearised timing constraints
    const eps = 0.5;
    for (let k = 0; k < nSeg; k++) {
        const targetMs = boundaryTimesMs[k + 1] - boundaryTimesMs[k];
        const im = shapes[k];

        const I0 = computePowerElapsedMs(tau[k], tau[k + 1], im, segLengthBeats[k]);
        const g1 = (
            computePowerElapsedMs(tau[k] + eps, tau[k + 1], im, segLengthBeats[k]) -
            computePowerElapsedMs(tau[k] - eps, tau[k + 1], im, segLengthBeats[k])
        ) / (2 * eps);
        const g2 = (
            computePowerElapsedMs(tau[k], tau[k + 1] + eps, im, segLengthBeats[k]) -
            computePowerElapsedMs(tau[k], tau[k + 1] - eps, im, segLengthBeats[k])
        ) / (2 * eps);

        const norm = Math.sqrt(g1 * g1 + g2 * g2);
        if (norm < 1e-10) continue;

        const a_hat = g1 / norm;
        const b_hat = g2 / norm;
        const c_hat = (targetMs - I0 + g1 * tau[k] + g2 * tau[k + 1]) / norm;

        D[k] += W_TIMING * a_hat * a_hat;
        D[k + 1] += W_TIMING * b_hat * b_hat;
        Up[k] += W_TIMING * a_hat * b_hat;
        Lo[k + 1] += W_TIMING * a_hat * b_hat;
        rhs[k] += W_TIMING * c_hat * a_hat;
        rhs[k + 1] += W_TIMING * c_hat * b_hat;
    }

    // Thomas algorithm (scalar tridiagonal solve)
    // Forward elimination
    for (let i = 1; i < n; i++) {
        const w = Lo[i] / D[i - 1];
        D[i] -= w * Up[i - 1];
        rhs[i] -= w * rhs[i - 1];
    }

    // Back substitution
    tau[n - 1] = rhs[n - 1] / D[n - 1];
    for (let i = n - 2; i >= 0; i--) {
        tau[i] = (rhs[i] - Up[i] * tau[i + 1]) / D[i];
    }
}
