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

/**
 * Translates MIDI onset times into tempo-dependent
 * ticks using the newly interpolated tempo curves.
 * Adds the variable `tickDate` on every MSM note/pedal
 * and removes the variable `midi.onset`. 
 * @param msm The MSM to modify.
 * @param mpm The MPM to take the tempo instructions from. 
 *            It must contain a `tempoMap`.
 */
export const addTickOnsets = (msm: MSM, mpm: MPM) => {
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
                n.tickDate = approximateDate(onsetMilliseconds - currentMs, tempoWithEndDate)
            })

            const endMs = computeMillisecondsAt(endDate, tempoWithEndDate)

            msm.pedals
                .filter(p => p.tickDate === undefined) // not yet processed
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
                    p.tickDate = approximateDate(onsetMs - currentMs, tempoWithEndDate)
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
export const addTickDurations = (msm: MSM, mpm: MPM, deleteMIDI = false) => {
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

                    n.tickDuration = approximateDate(relativeOffsetMs, tempoWithEndDate) - n.tickDate

                    if (deleteMIDI) {
                        delete n["midi.duration"]
                        delete n["midi.onset"]
                    }
                })

            msm.pedals
                .filter(p => p.tickDuration === undefined) // not yet processed
                .filter(p => {
                    const offsetMs = (p['midi.onset'] + p['midi.duration']) * 1000
                    return (
                        offsetMs >= currentFrameBeginMs &&
                        offsetMs < currentFrameBeginMs + endMs
                    )
                })
                .forEach(p => {
                    const offsetMs = (p['midi.onset'] + p['midi.duration']) * 1000
                    p.tickDuration = approximateDate(offsetMs - currentFrameBeginMs, tempoWithEndDate) - p.tickDate

                    if (deleteMIDI) {
                        delete p['midi.duration']
                        delete p['midi.onset']
                    }
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

