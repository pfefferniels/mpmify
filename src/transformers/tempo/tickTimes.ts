/**
 * Where a recorded onset falls on the score grid.
 *
 * This is the tempo half of the reduction: it reads the `<tempo>` instructions already in the
 * MPM and converts each note's recorded millisecond onset into `tickDate`, and its recorded
 * duration into `tickDuration` — the only domain `<rubato>` and `<articulation>` can speak.
 *
 * It lives here, apart from the transformer that used to own it, because two callers need it
 * and neither should import the other: `TranslatePhysicalTimeToTicks`, which writes the values
 * onto the score, and `deriveResidual`, which computes them on a scratch copy to answer what
 * the MPM as it stands leaves unexplained.
 *
 * **The conversion is a function of the MPM *and* the recording, not of the MPM alone.** At every
 * tempo boundary the running millisecond cursor is re-anchored on the recorded onset of the note
 * that sits on it rather than on the tempo's own prediction. That keeps a segment's error from
 * accumulating into the next one — and it is why the tick domain cannot be recovered by inverting
 * a rendered performance, which has no recording to anchor to. Anyone tempted to replace this
 * with `performMsmToData` should read that sentence twice.
 *
 * The walk itself now lives in `placedTempos.ts`, which states that rule once for the four
 * callers that used to each carry their own copy of it.
 */
import { MPM } from "../../mpm";
import { MSM } from "../../msm";
import { millisecondsAt, resolveSpan, ticksForConstantTempo, TempoWithEndDate } from "./tempoCalculations";
import { coversDate, placeTempos } from "./placedTempos";
import { removeRubatoDistortion } from "../rubato/rubatoMath";

/** Where one note or pedal fell on the score grid. Absent fields mean "no tempo covered it". */
export interface TickTime {
    tickDate?: number
    tickDuration?: number
}

/**
 * The derived positions, notes and pedals kept apart because their ids are only unique within
 * their own map.
 */
export interface TickTimes {
    readonly notes: Map<string, TickTime>
    readonly pedals: Map<string, TickTime>
}

export const emptyTickTimes = (): TickTimes => ({ notes: new Map(), pedals: new Map() })

/**
 * The entry for an id, created on first ask.
 *
 * Returning a mutable record rather than a value is deliberate: it lets the walks below keep
 * reading and writing positions as `at(...).tickDate = x`, which is what they did when the
 * positions lived on the note, so the arithmetic and the control flow are unchanged from the
 * version this was measured against.
 */
const at = (table: Map<string, TickTime>, id: string): TickTime => {
    const existing = table.get(id)
    if (existing) return existing
    const fresh: TickTime = {}
    table.set(id, fresh)
    return fresh
}

/**
 * Translates MIDI onset times into tempo-dependent ticks using the newly interpolated tempo
 * curves, writing `tickDate` for every note and pedal a segment covers.
 */
const addTickOnsets = (msm: MSM, mpm: MPM, times: TickTimes) => {
    for (const scope of mpm.scopes()) {
        for (const segment of placeTempos(msm, mpm, scope)) {
            const { tempo, startMs, modelledMs } = segment

            msm.notesInPart(scope)
                .filter(n => coversDate(segment, n.date))
                .forEach(n => {
                    const onsetMilliseconds = n["midi.onset"] * 1000
                    at(times.notes, n["xml:id"]).tickDate =
                        approximateDate(onsetMilliseconds - startMs, tempo)
                })

            // The pedal window is bounded by the *modelled* length while the cursor advances by
            // the measured one — see `PlacedTempo.measuredMs`. Pre-existing, preserved.
            msm.pedals
                .filter(p => at(times.pedals, p["xml:id"]).tickDate === undefined) // not yet processed
                .filter(p => {
                    const onsetMs = p['midi.onset'] * 1000
                    return onsetMs >= startMs && onsetMs < startMs + modelledMs
                })
                .forEach(p => {
                    const onsetMs = p['midi.onset'] * 1000
                    at(times.pedals, p["xml:id"]).tickDate = approximateDate(onsetMs - startMs, tempo)
                })
        }
    }
}

/**
 * Translates MIDI durations into tick durations using the new `<tempo>` instructions.
 *
 * Measured from the onsets `addTickOnsets` has already placed, so it must run after it.
 */
const addTickDurations = (msm: MSM, mpm: MPM, times: TickTimes) => {
    for (const scope of mpm.scopes()) {
        for (const segment of placeTempos(msm, mpm, scope)) {
            const { tempo, startMs, measuredMs } = segment

            msm.notesInPart(scope)
                .filter(n => n["midi.duration"])
                .forEach(n => {
                    const offsetMs = (n['midi.onset'] + n["midi.duration"]) * 1000
                    if (offsetMs < startMs) return

                    const relativeOffsetMs = offsetMs - startMs
                    if (relativeOffsetMs > measuredMs) return

                    at(times.notes, n["xml:id"]).tickDuration =
                        approximateDate(relativeOffsetMs, tempo) - at(times.notes, n["xml:id"]).tickDate!
                })

            msm.pedals
                .filter(p => at(times.pedals, p["xml:id"]).tickDuration === undefined) // not yet processed
                .filter(p => {
                    const offsetMs = (p['midi.onset'] + p['midi.duration']) * 1000
                    return offsetMs >= startMs && offsetMs < startMs + measuredMs
                })
                .forEach(p => {
                    const offsetMs = (p['midi.onset'] + p['midi.duration']) * 1000
                    at(times.pedals, p["xml:id"]).tickDuration =
                        approximateDate(offsetMs - startMs, tempo) - at(times.pedals, p["xml:id"]).tickDate!
                })
        }
    }
}

/**
 * The tick date at which `targetMilliseconds` have elapsed since the start of the instruction.
 *
 * A constant tempo inverts in closed form; a transition has none, so it is walked by a damped
 * fixed-point iteration on the guess. The span is resolved once, before the loop, rather than at
 * each of its up-to-a-thousand steps.
 */
export const approximateDate = (
    targetMilliseconds: number,
    effectiveTempoInstruction: TempoWithEndDate,
    initialGuess: number = effectiveTempoInstruction.date,
    tolerance: number = 1
): number => {
    if (!isTransition(effectiveTempoInstruction)) {
        return (
            +effectiveTempoInstruction.date +
            ticksForConstantTempo(targetMilliseconds, effectiveTempoInstruction)
        )
    }

    const resolved = resolveSpan(effectiveTempoInstruction)

    let guess = initialGuess;
    let guessedMilliseconds = millisecondsAt(guess, resolved);
    for (let i = 0; i < 1000 && Math.abs(guessedMilliseconds - targetMilliseconds) > tolerance; i++) {
        guess += 0.1 * (targetMilliseconds - guessedMilliseconds)
        guessedMilliseconds = millisecondsAt(guess, resolved);
    }

    return Math.round(guess);
}

/**
 * Whether the instruction ramps.
 *
 * Deliberately *not* `resolveSpan(...).kind === 'transitioning'`: this test decides whether the
 * closed-form inverse above applies, and the closed form is exact for any instruction whose
 * `@meanTempoAt` is absent — which resolution reads as a linear ramp rather than as a constant.
 * The two questions differ, so they are asked separately.
 */
const isTransition = (tempo: TempoWithEndDate) => {
    return tempo["transition.to"] && tempo.meanTempoAt
}

/**
 * Where every note and pedal fell on the score grid, under the MPM as it stands.
 *
 * The order is the whole of what this adds over the three steps it calls, and it is not free to
 * change: durations are measured from the onsets, and the rubato warp comes off positions that
 * already exist. A `<rubato>` the document holds has explained its share of the deviation, so it
 * is taken back off — leaving what nothing has explained yet, which is what a fitter wants.
 */
export const computeTickTimes = (msm: MSM, mpm: MPM): TickTimes => {
    const times = emptyTickTimes()

    addTickOnsets(msm, mpm, times)
    addTickDurations(msm, mpm, times)

    // Scopes with no rubato are skipped rather than walked. If a global and a part rubato ever
    // covered the same note the removal would compound, which is not what a part map overriding
    // a global one should mean; mpmify writes rubatos in one scope, so it does not arise.
    for (const scope of mpm.scopes()) {
        if (mpm.getInstructions('rubato', scope).length === 0) continue
        removeRubatoDistortion(msm, mpm, scope, times)
    }

    return times
}
