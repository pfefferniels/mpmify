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
 * that sits on it (`currentMs = note["midi.onset"] * 1000`) rather than on the tempo's own
 * prediction. That keeps a segment's error from accumulating into the next one — and it is why
 * the tick domain cannot be recovered by inverting a rendered performance, which has no
 * recording to anchor to. Anyone tempted to replace this with `performMsmToData` should read
 * that sentence twice.
 */
import { MPM, Tempo } from "../../mpm";
import { MSM } from "../../msm";
import { computeMillisecondsAt, TempoWithEndDate } from "./tempoCalculations";
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
 * Translates MIDI onset times into tempo-dependent
 * ticks using the newly interpolated tempo curves.
 * Adds the variable `tickDate` on every MSM note/pedal
 * and removes the variable `midi.onset`. 
 * @param msm The MSM to modify.
 * @param mpm The MPM to take the tempo instructions from. 
 *            It must contain a `tempoMap`.
 */
const addTickOnsets = (msm: MSM, mpm: MPM, times: TickTimes) => {
    for (const scope of mpm.scopes()) {
        const tempos = mpm.getInstructions<Tempo>('tempo', scope)

        let currentMs = 0
        for (let i = 0; i < tempos.length; i++) {
            const tempo = tempos[i]
            const nextTempo = tempos[i + 1]
            const endDate = nextTempo ? nextTempo.date : msm.end

            const tempoWithEndDate: TempoWithEndDate = {
                ...tempo,
                endDate
            }

            msm.notesInPart(scope).forEach(n => {
                // are out of the scope of the current tempo instruction? 
                if (nextTempo && n.date >= nextTempo.date) return
                if (n.date < tempo.date) return

                const onsetMilliseconds = n["midi.onset"] * 1000

                // replace MIDI time with tick time.
                at(times.notes, n["xml:id"]).tickDate = approximateDate(onsetMilliseconds - currentMs, tempoWithEndDate)
            })

            const endMs = computeMillisecondsAt(endDate, tempoWithEndDate)

            msm.pedals
                .filter(p => at(times.pedals, p["xml:id"]).tickDate === undefined) // not yet processed
                .filter(p => {
                    // filter pedals that are within the current tempo frame
                    const onsetMs = p['midi.onset'] * 1000
                    return (
                        onsetMs >= currentMs &&
                        onsetMs < (currentMs + endMs)
                    )
                })
                .forEach(p => {
                    const onsetMs = p['midi.onset'] * 1000
                    at(times.pedals, p["xml:id"]).tickDate = approximateDate(onsetMs - currentMs, tempoWithEndDate)
                })

            const note = msm.notesInPart(scope).find(n => n.date === endDate)
            if (!note) {
                currentMs += endMs
            }
            else {
                currentMs = note["midi.onset"] * 1000
            }
        }
    }
}

/**
 * Translates MIDI durations into tick durations
 * using the new <tempo> instructions.
 * 
 * @param msm 
 * @param mpm 
 */
const addTickDurations = (msm: MSM, mpm: MPM, times: TickTimes) => {
    for (const scope of mpm.scopes()) {
        const tempos = mpm.getInstructions<Tempo>('tempo', scope)

        let currentFrameBeginMs = 0
        for (let i = 0; i < tempos.length; i++) {
            const tempo = tempos[i]
            const nextTempo = tempos[i + 1]
            const endDate = nextTempo ? nextTempo.date : msm.end

            const tempoWithEndDate: TempoWithEndDate = {
                ...tempo,
                endDate
            }

            let endMs = computeMillisecondsAt(endDate, tempoWithEndDate)
            const empirical = msm.notesInPart(scope).find(n => n.date === endDate)
            if (empirical) {
                endMs = empirical["midi.onset"] * 1000 - currentFrameBeginMs
            }

            msm.notesInPart(scope)
                .filter(n => n["midi.duration"])
                .forEach(n => {
                    const offsetMs = (n['midi.onset'] + n["midi.duration"]) * 1000
                    if (offsetMs < currentFrameBeginMs) return

                    const relativeOffsetMs = offsetMs - currentFrameBeginMs
                    if (relativeOffsetMs > endMs) return

                    at(times.notes, n["xml:id"]).tickDuration =
                        approximateDate(relativeOffsetMs, tempoWithEndDate) - at(times.notes, n["xml:id"]).tickDate!
                })

            msm.pedals
                .filter(p => at(times.pedals, p["xml:id"]).tickDuration === undefined) // not yet processed
                .filter(p => {
                    const offsetMs = (p['midi.onset'] + p['midi.duration']) * 1000
                    return (
                        offsetMs >= currentFrameBeginMs &&
                        offsetMs < currentFrameBeginMs + endMs
                    )
                })
                .forEach(p => {
                    const offsetMs = (p['midi.onset'] + p['midi.duration']) * 1000
                    at(times.pedals, p["xml:id"]).tickDuration =
                        approximateDate(offsetMs - currentFrameBeginMs, tempoWithEndDate) - at(times.pedals, p["xml:id"]).tickDate!
                })

            const note = msm.notesInPart(scope).find(n => n.date === endDate)
            if (!note) {
                currentFrameBeginMs += endMs
            }
            else {
                currentFrameBeginMs = note["midi.onset"] * 1000
            }
        }
    }
}

const physicalToSymbolic = (physicalDate: number, bpm: number, beatLength: number) => {
    return (physicalDate * (bpm * beatLength * 4 / 60)) * 720
}

const isTransition = (tempo: Tempo) => {
    return tempo["transition.to"] && tempo.meanTempoAt
}

export const approximateDate = (targetMilliseconds: number, effectiveTempoInstruction: TempoWithEndDate, initialGuess: number = effectiveTempoInstruction.date, tolerance: number = 1): number => {
    if (!isTransition(effectiveTempoInstruction)) {
        return (
            +effectiveTempoInstruction.date +
            physicalToSymbolic(targetMilliseconds / 1000, effectiveTempoInstruction.bpm, effectiveTempoInstruction.beatLength)
        )
    }

    let guess = initialGuess;
    let guessedMilliseconds = computeMillisecondsAt(guess, effectiveTempoInstruction);
    for (let i = 0; i < 1000 && Math.abs(guessedMilliseconds - targetMilliseconds) > tolerance; i++) {
        guess += 0.1 * (targetMilliseconds - guessedMilliseconds)
        guessedMilliseconds = computeMillisecondsAt(guess, effectiveTempoInstruction);
    }

    return Math.round(guess);
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
