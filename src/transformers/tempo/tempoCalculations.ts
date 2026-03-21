import { Tempo } from "mpm-ts";

export interface WithEndDate {
    endDate: number
}

export type TempoWithEndDate = Tempo & WithEndDate

// ── Curve shape fitting ───────────────────────────────────────────

/**
 * Fits the `meanTempoAt` parameter (0–1) for a power-function tempo
 * curve by minimising the squared error against a sampled trail of
 * (seconds, bpm) points drawn by the user.
 */
export function fitMeanTempoAt(
    from: { seconds: number, bpm: number },
    to: { seconds: number, bpm: number },
    trail: { seconds: number, bpm: number }[]
): number {
    const duration = to.seconds - from.seconds
    const bpmRange = to.bpm - from.bpm

    if (Math.abs(duration) < 1e-9 || Math.abs(bpmRange) < 1e-9 || trail.length < 2) return 0.5

    const normalized = trail
        .map(pt => ({
            x: (pt.seconds - from.seconds) / duration,
            bpm: pt.bpm
        }))
        .filter(pt => pt.x > 0.01 && pt.x < 0.99)

    if (normalized.length === 0) return 0.5

    let bestIm = 0.5
    let bestError = Infinity

    for (let i = 2; i <= 98; i++) {
        const im = i / 100
        const p = Math.log(0.5) / Math.log(im)
        let error = 0
        for (const pt of normalized) {
            const predicted = from.bpm + Math.pow(pt.x, p) * bpmRange
            error += (predicted - pt.bpm) ** 2
        }
        if (error < bestError) {
            bestError = error
            bestIm = im
        }
    }

    return bestIm
}

// ── Elapsed-time calculation ──────────────────────────────────────

/**
 * Computes elapsed milliseconds for a tempo segment of `segLengthBeats`
 * beats, transitioning from `startBpm` to `endBpm` with the given
 * `meanTempoAt` curve shape.
 */
export function computeElapsedMs(
    startBpm: number,
    endBpm: number,
    meanTempoAt: number,
    segLengthBeats: number
): number {
    if (segLengthBeats <= 0) return 0

    if (Math.abs(startBpm - endBpm) < 0.01) {
        return segLengthBeats * 60000 / startBpm
    }

    const p = Math.log(0.5) / Math.log(Math.max(0.001, Math.min(0.999, meanTempoAt)))
    const steps = 200
    let sum = 0

    for (let i = 0; i < steps; i++) {
        const x0 = i / steps
        const x1 = (i + 1) / steps
        const T0 = startBpm + (endBpm - startBpm) * (x0 === 0 ? 0 : Math.pow(x0, p))
        const T1 = startBpm + (endBpm - startBpm) * Math.pow(x1, p)
        sum += 0.5 * (60000 / T0 + 60000 / T1)
    }

    return sum * segLengthBeats / steps
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
    targetMs: number
): { startBpm: number, endBpm: number, meanTempoAt: number, bpmScaled: boolean } {
    const segLengthBeats = Math.abs(endTick - startTick) / (beatLength * 2880)
    if (segLengthBeats <= 0 || targetMs <= 0) {
        return { startBpm, endBpm, meanTempoAt, bpmScaled: false }
    }

    if (Math.abs(startBpm - endBpm) < 0.5) {
        const neededBpm = segLengthBeats * 60000 / targetMs
        const avgBpm = (startBpm + endBpm) / 2
        const scaled = Math.abs(neededBpm - avgBpm) > 0.5
        return { startBpm: neededBpm, endBpm: neededBpm, meanTempoAt: 0.5, bpmScaled: scaled }
    }

    const msAt02 = computeElapsedMs(startBpm, endBpm, 0.02, segLengthBeats)
    const msAt98 = computeElapsedMs(startBpm, endBpm, 0.98, segLengthBeats)
    const msMin = Math.min(msAt02, msAt98)
    const msMax = Math.max(msAt02, msAt98)

    if (targetMs >= msMin && targetMs <= msMax) {
        const increasing = msAt98 > msAt02
        let lo = 0.02, hi = 0.98

        for (let iter = 0; iter < 50; iter++) {
            const mid = (lo + hi) / 2
            const msMid = computeElapsedMs(startBpm, endBpm, mid, segLengthBeats)
            if (Math.abs(msMid - targetMs) < 0.1) {
                return { startBpm, endBpm, meanTempoAt: mid, bpmScaled: false }
            }
            if ((msMid < targetMs) === increasing) {
                lo = mid
            } else {
                hi = mid
            }
        }

        return { startBpm, endBpm, meanTempoAt: (lo + hi) / 2, bpmScaled: false }
    }

    const currentMs = computeElapsedMs(startBpm, endBpm, meanTempoAt, segLengthBeats)
    const scale = currentMs / targetMs
    return {
        startBpm: startBpm * scale,
        endBpm: endBpm * scale,
        meanTempoAt,
        bpmScaled: true
    }
}

export const computeMillisecondsAt = (date: number, tempo: TempoWithEndDate) => {
    if (!tempo["transition.to"]) {
        return computeMillisecondsForConstantTempo(date, tempo)
    }

    return computeMillisecondsForTransition(date, tempo)
}

export const computeMillisecondsForConstantTempo = (date: number, tempo: TempoWithEndDate) => {
    return ((15000.0 * (date - tempo.date)) / (tempo.bpm * tempo.beatLength * 720));
}

export const computeMillisecondsForTransition = (date: number, tempo: TempoWithEndDate): number => {
    const N = 2 * Math.floor((date - tempo.date) / (720 / 4));
    const adjustedN = (N === 0) ? 2 : N;

    const n = adjustedN / 2;
    const x = (date - tempo.date) / adjustedN;

    const resultConst = (date - tempo.date) * 5000 / (adjustedN * tempo.beatLength * 720);
    let resultSum = 1 / tempo.bpm + 1 / getTempoAt(date, tempo);

    for (let k = 1; k < n; k++) {
        resultSum += 2 / getTempoAt(tempo.date + 2 * k * x, tempo);
    }

    for (let k = 1; k <= n; k++) {
        resultSum += 4 / getTempoAt(tempo.date + (2 * k - 1) * x, tempo);
    }

    return resultConst * resultSum;
}

export const getTempoAt = (date: number, tempo: TempoWithEndDate): number => {
    // no tempo
    if (!tempo.bpm) return 100.0;

    // constant tempo
    if (!tempo["transition.to"]) return tempo.bpm

    if (date >= tempo.endDate) return tempo["transition.to"]

    const result = (date - tempo.date) / (tempo.endDate - tempo.date);
    const exponent = Math.log(0.5) / Math.log(tempo.meanTempoAt || 0.5);
    return Math.pow(result, exponent) * (tempo["transition.to"] - tempo.bpm) + tempo.bpm;
}

