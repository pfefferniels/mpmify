import { MPM, Ornament, Tempo } from "mpm-ts";
import { MSM } from "../../msm";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { computeMillisecondsAt } from "./tempoCalculations";
import { ApproximateLogarithmicTempo } from "./ApproximateLogarithmicTempo";

interface TempoWithEndDate extends Tempo {
    endDate: number
}

export interface TranslatePhyiscalTimeToTicksOptions extends TransformationOptions {
    /**
     * Defines whether physical modifiers which are already present in the MPM
     * (e.g. because of a previous <ornamentation> or <asynchrony> interpolation)
     * should be translated into symbolic ones too.
     */
    translatePhysicalModifiers: boolean

    /**
     * Defines whether the pedal instruction in the MSM should be 
     * translated to tick time as well.
     * @todo not yet implemented
     */
    translatePedalling?: boolean
}

/**
 * Interpolates the global tempo and inserts it into the MPM
 */
export class TranslatePhyiscalTimeToTicks extends AbstractTransformer<TranslatePhyiscalTimeToTicksOptions> {
    name = 'TranslatePhyiscalTimeToTicks'
    requires = [ApproximateLogarithmicTempo]

    constructor(options?: TranslatePhyiscalTimeToTicksOptions) {
        super()

        // set the default options
        this.options = options || {
            translatePhysicalModifiers: true
        }
    }

    protected transform(msm: MSM, mpm: MPM) {
        this.addTickOnsets(msm, mpm)
        if (this.options.translatePhysicalModifiers) this.translatePhysicalMPMModifiers(mpm, msm)
        this.addTickDurations(msm, mpm)
    }

    private msToTicks(ms: number, tempos: Tempo[], msm: MSM) {
        let currentMs = 0
        for (let i = 0; i < tempos.length; i++) {
            const tempo = tempos[i]
            const nextTempo = tempos[i + 1]
            const endDate = nextTempo && nextTempo.date

            const tempoWithEndDate: TempoWithEndDate = {
                ...tempo,
                endDate
            }

            const endMs = computeMillisecondsAt(endDate, tempoWithEndDate)

            if (ms >= currentMs && ms < (currentMs + endMs)) {
                return approximateDate(ms - currentMs, tempoWithEndDate)
            }

            const note = msm.allNotes.find(n => n.date === endDate)
            if (!note) {
                const endMs = computeMillisecondsAt(endDate, tempoWithEndDate)
                currentMs += endMs
            }
            else {
                currentMs = note["midi.onset"] * 1000
            }
        }
        console.log('no tempo found for', ms, 'amongst', tempos)
    }

    private ticksToMs(ticks: number, tempos: Tempo[], msm: MSM) {
        let currentMs = 0
        for (let i = 0; i < tempos.length; i++) {
            const tempo = tempos[i]
            const nextTempo = tempos[i + 1]
            const endDate = nextTempo && nextTempo.date

            const tempoWithEndDate: TempoWithEndDate = {
                ...tempo,
                endDate
            }

            if (ticks >= tempo.date && ticks < endDate) {
                return currentMs + computeMillisecondsAt(ticks, tempoWithEndDate)
            }

            const note = msm.allNotes.find(n => n.date === endDate)
            if (!note) {
                const endMs = computeMillisecondsAt(endDate, tempoWithEndDate)
                currentMs += endMs
            }
            else {
                currentMs = note["midi.onset"] * 1000
            }
        }
    }

    /**
     * Walks through physical attributes in the
     * given MPM and translates them into tick values.
     * @todo Currently, only ornaments are taken into account.
     */
    translatePhysicalMPMModifiers(mpm: MPM, msm: MSM) {
        for (const [scope,] of mpm.doc.performance.parts) {
            const tempos = mpm.getInstructions<Tempo>('tempo', scope)

            const ornaments = mpm.getInstructions<Ornament>('ornament', scope)
            for (const ornament of ornaments) {
                if (ornament["time.unit"] === 'ticks') {
                    // the job is done already
                    continue
                }

                const ornamentMs = this.ticksToMs(ornament.date, tempos, msm)
                console.log('ornamentMs', ornamentMs)

                const frameStartMs = ornamentMs + ornament["frame.start"]
                const frameEndMs = frameStartMs + ornament.frameLength

                const frameStartTicks = this.msToTicks(frameStartMs, tempos, msm)
                const frameEndTicks = this.msToTicks(frameEndMs, tempos, msm)

                console.log('ornament.date', ornament.date, 'frameStartTicks', frameStartTicks, 'frameEndTicks', frameEndTicks)

                ornament["frame.start"] = frameStartTicks - ornament.date
                ornament['frameLength'] = frameEndTicks - frameStartTicks
                ornament['time.unit'] = 'ticks'
            }
        }
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
    addTickOnsets(msm: MSM, mpm: MPM) {
        for (const [scope,] of mpm.doc.performance.parts) {
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
    addTickDurations(msm: MSM, mpm: MPM, deleteMIDI: boolean = false) {
        for (const [scope,] of mpm.doc.performance.parts) {
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

                const endMs = computeMillisecondsAt(endDate, tempoWithEndDate)

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
}

const physicalToSymbolic = (physicalDate: number, bpm: number, beatLength: number) => {
    return (physicalDate * (bpm * beatLength * 4 / 60)) * 720
}

const isTransition = (tempo: Tempo) => {
    return tempo["transition.to"] && tempo.meanTempoAt
}

const approximateDate = (targetMilliseconds: number, effectiveTempoInstruction: TempoWithEndDate, initialGuess: number = effectiveTempoInstruction.date, tolerance: number = 1): number => {
    // console.log('approximating date for', targetMilliseconds, 'within tempo instruction', effectiveTempoInstruction["xml:id"])
    if (!isTransition(effectiveTempoInstruction)) {
        return (
            +effectiveTempoInstruction.date +
            physicalToSymbolic(targetMilliseconds / 1000, effectiveTempoInstruction.bpm, effectiveTempoInstruction.beatLength)
        )
    }

    // console.log('initial=', initialGuess)

    let guess = initialGuess;
    let guessedMilliseconds = computeMillisecondsAt(guess, effectiveTempoInstruction);
    for (let i = 0; i < 1000 && Math.abs(guessedMilliseconds - targetMilliseconds) > tolerance; i++) {
        guess += 0.1 * (targetMilliseconds - guessedMilliseconds)
        guessedMilliseconds = computeMillisecondsAt(guess, effectiveTempoInstruction);
    }

    // console.log('after=', guess)


    return Math.round(guess);
}

