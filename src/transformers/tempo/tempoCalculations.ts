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
 * produces `NaN` — which `view.ts` refuses to write. That is the intended outcome. The renderer's
 * answer is the one that decides whether a fit is right, so matching it is correctness and not
 * precision.
 *
 * What is genuinely mpmify's stays here: {@link ticksForConstantTempo} (espressivo has no
 * inverse), and the two fitting helpers the desks drive, which now measure with the renderer's
 * quadrature instead of their own.
 */
import { TempoMap, resolveTempo, tempoAt, type Tempo as ResolvedTempo } from 'espressivo'
import { Tempo } from "../../mpm";
import { beatLengthInTicks, PULSES_PER_QUARTER } from "../../ppq";

export interface WithEndDate {
    endDate: number
}

export type TempoWithEndDate = Tempo & WithEndDate

// ── the bridge to espressivo ──────────────────────────────────────

/**
 * One of mpmify's `<tempo>` records, resolved the way the renderer resolves it.
 *
 * Everything downstream of this call is espressivo's: the choice between the constant and the
 * transitioning arm, the power-curve exponent, and the defaults for the attributes that are
 * absent. Three of those normalisations are the ones the hand-written version got wrong (see the
 * module header), and they are made here, once, rather than at each evaluation.
 *
 * Exported because it is worth calling once per segment and then evaluating many times —
 * {@link approximateDate} runs up to a thousand iterations over one instruction. `tempoAt` and
 * {@link millisecondsAt} take the result.
 *
 * `@bpm` and `@transition.to` go across as text because that is what espressivo resolves from:
 * a style-relative name (`"Allegro"`) is as legal an `@bpm` as a number, and with no style in
 * scope it becomes meico's default of 100 rather than the `NaN` arithmetic on the string used to
 * give. `String(x)` round-trips a double exactly, so a numeric one is unchanged.
 */
export const resolveSpan = (tempo: TempoWithEndDate): ResolvedTempo => resolveTempo(
    {
        startDate: tempo.date,
        endDate: tempo.endDate,
        beatLength: tempo.beatLength,
    },
    String(tempo.bpm),
    tempo['transition.to'] === undefined ? null : String(tempo['transition.to']),
    tempo.meanTempoAt === undefined ? null : String(tempo.meanTempoAt),
    // No style: mpmify writes numeric `@bpm` throughout, and a `<tempoDef>` it did not write is
    // not in scope here anyway. An unresolvable name therefore lands on meico's 100.0.
    null,
)

/**
 * Elapsed milliseconds from the start of an already-resolved span to `date`.
 *
 * ## Past the end of the span
 *
 * espressivo never evaluates a `<tempo>` beyond its own `endDate` — the next instruction takes
 * over there — so `tempoAt` past the end keeps raising the progress term above 1 and the curve
 * runs away from both of its endpoints. mpmify *does* ask: {@link approximateDate} inverts this
 * function by walking a guess, and {@link ticksForConstantTempo}'s callers ask about times that
 * reach past the last instruction on purpose.
 *
 * So beyond the span the answer is a continuation at the tempo the transition arrives at, which
 * is both the honest reading — the next instruction starts there, or the piece goes on at that
 * tempo — and the same extrapolation `TranslatePhysicalTimeToTicks` already makes at the end of
 * the piece. This is mpmify's own semantics layered on espressivo's arithmetic, not a second
 * copy of it: everything inside the span is `computeDiffTiming`, and the continuation is the
 * constant-tempo formula that {@link ticksForConstantTempo} inverts.
 *
 * A constant tempo is unaffected either way — its formula is already linear in `date`, so the
 * split changes nothing. Only transitions reach the second branch.
 */
export const millisecondsAt = (date: number, tempo: ResolvedTempo): number => {
    if (date <= tempo.endDate || tempo.kind === 'constant') {
        return TempoMap.computeDiffTiming(date, PULSES_PER_QUARTER, tempo)
    }

    const toEnd = TempoMap.computeDiffTiming(tempo.endDate, PULSES_PER_QUARTER, tempo)
    const arrivedAt = tempoAt(tempo, tempo.endDate)
    return toEnd + (15000.0 * (date - tempo.endDate)) / (arrivedAt * tempo.beatLength * PULSES_PER_QUARTER)
}

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
        // A unit span, so `tempoAt`'s progress term is `x` itself and nothing is lost to the
        // division. `beatLength` does not enter the tempo curve at all.
        const curve = resolveSpan({
            type: 'tempo',
            'xml:id': '',
            date: 0,
            endDate: 1,
            beatLength: 0.25,
            bpm: from.bpm,
            'transition.to': to.bpm,
            meanTempoAt: im,
        })
        let error = 0
        for (const pt of normalized) {
            const predicted = tempoAt(curve, pt.x)
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
    segLengthBeats: number
): number {
    if (segLengthBeats <= 0) return 0

    const endDate = segLengthBeats * PULSES_PER_QUARTER
    return millisecondsAt(endDate, resolveSpan({
        type: 'tempo',
        'xml:id': '',
        date: 0,
        endDate,
        beatLength: 0.25,
        bpm: startBpm,
        'transition.to': endBpm,
        meanTempoAt,
    }))
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
    const segLengthBeats = Math.abs(endTick - startTick) / beatLengthInTicks(beatLength)
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
    millisecondsAt(date, resolveSpan(tempo))

/**
 * The tick span a millisecond span covers at a constant tempo — the inverse of the constant-tempo
 * arm of {@link computeMillisecondsAt} over the same stretch, sharing its constants so the two
 * cannot drift apart.
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
    tempo: Pick<Tempo, 'bpm' | 'beatLength'>
): number => (milliseconds * Number(tempo.bpm) * tempo.beatLength * PULSES_PER_QUARTER) / 15000.0

/**
 * The instantaneous tempo, in bpm, that `tempo` calls for at `date`.
 *
 * Past the end of the span the answer is the tempo the transition arrives at — see
 * {@link millisecondsAt} for why mpmify asks at all and why the curve is not continued.
 */
export const getTempoAt = (date: number, tempo: TempoWithEndDate): number => {
    const resolved = resolveSpan(tempo)
    return tempoAt(resolved, Math.min(date, resolved.endDate))
}
