import { MPM, Ornament, Tempo } from "mpm-ts";
import { MSM } from "../../msm";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { computeMillisecondsAt } from "./tempoCalculations";

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
    constructor(options?: TranslatePhyiscalTimeToTicksOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            translatePhysicalModifiers: true
        })
    }

    public name() { return 'TranslatePhyiscalTimeToTicks' }

    transform(msm: MSM, mpm: MPM): string {
        this.addTickOnsets(msm, mpm)
        if (this.options.translatePhysicalModifiers) this.translatePhysicalMPMModifiers(mpm)
        this.addTickDurations(msm, mpm)

        return super.transform(msm, mpm)
    }

    /**
     * Walks through physical attributes in the
     * given MPM and translates them into tick values.
     * @todo Currently, only ornaments are taken into account.
     */
    translatePhysicalMPMModifiers(mpm: MPM) {
        const tempos = mpm.getInstructions<Tempo>('tempo', 'global')

        let currentMilliseconds = 0
        for (let i = 0; i < tempos.length; i++) {
            const tempo = tempos[i]
            const nextTempo = tempos[i + 1]

            console.log('within tempo instruction @', tempo.date, 'current start time=', currentMilliseconds)

            const tempoWithEndDate: TempoWithEndDate = {
                ...tempo,
                endDate: nextTempo?.date || tempo.date + tempo.beatLength * 4 * 720
            }

            // find all ornaments that fit into the tempo frame
            const ornaments = mpm.instructionEffectiveInRange<Ornament>(tempo.date, tempoWithEndDate.endDate + 1, 'ornament')
            for (const ornament of ornaments) {
                if (ornament["time.unit"] === 'ticks') {
                    // the job is done already
                    continue
                }

                const ornamentMs = computeMillisecondsAt(ornament.date, tempoWithEndDate)
                const frameStart = ornamentMs + ornament["frame.start"]
                console.log('ornament ms @', ornament.date, '=', ornamentMs, 'frameStart=', frameStart)
                if (frameStart < 0) {
                    // use previous tempo frame
                    continue
                }
                const tickFrameStart = approximateDate(frameStart, tempoWithEndDate)

                const frameEnd = frameStart + ornament.frameLength
                const tickFrameEnd = approximateDate(frameEnd, tempoWithEndDate)
                console.log('frame: ', tickFrameStart, tickFrameEnd)

                ornament["frame.start"] = tickFrameStart - ornament.date
                ornament['frameLength'] = tickFrameEnd - tickFrameStart
                ornament['time.unit'] = 'ticks'

                console.log('new ornament', ornament)
            }

            currentMilliseconds += computeMillisecondsAt(tempoWithEndDate.endDate, tempoWithEndDate)
        }
    }

    /**
     * Translates MIDI onset times into tempo-dependent
     * ticks using the newly interpolated tempo curves.
     * Adds the variable `tickDate` on every MSM note 
     * and removes the variable `midi.onset`. 
     * @param msm The MSM to modify.
     * @param mpm The MPM to take the tempo instructions from. 
     *            It must contain a `tempoMap`.
     */
    addTickOnsets(msm: MSM, mpm: MPM) {
        const tempos = mpm.getInstructions<Tempo>('tempo', 'global')

        let currentMilliseconds = 0
        for (let i = 0; i < tempos.length; i++) {
            const tempo = tempos[i]
            const nextTempo = tempos[i + 1]

            console.log('within tempo instruction @', tempo.date, 'current start time=', currentMilliseconds)

            const tempoWithEndDate: TempoWithEndDate = {
                ...tempo,
                endDate: nextTempo?.date || tempo.date + tempo.beatLength * 4 * 720
            }

            msm.allNotes.forEach(n => {
                // are out of the scope of the current tempo instruction? 
                if (nextTempo && n.date >= nextTempo.date) return
                if (n.date < tempo.date) return

                const onsetMilliseconds = n["midi.onset"] * 1000

                // replace MIDI time with tick time.
                n.tickDate = approximateDate(onsetMilliseconds - currentMilliseconds, tempoWithEndDate)
            })

            currentMilliseconds += computeMillisecondsAt(tempoWithEndDate.endDate, tempoWithEndDate)
        }
    }

    /**
     * Translates MIDI durations into tick durations
     * using the new <tempo> instructions.
     * @todo Currently only consideres constant tempos.
     * Approximation of tempo curves still a todo.
     * @param msm 
     * @param mpm 
     */
    addTickDurations(msm: MSM, mpm: MPM, deleteMIDI: boolean = false) {
        const tempos = mpm.getInstructions<Tempo>('tempo', 'global')

        let currentFrameBeginMs = 0
        for (let i = 0; i < tempos.length; i++) {
            const tempo = tempos[i]
            const nextTempo = tempos[i + 1]

            const tempoWithEndDate: TempoWithEndDate = {
                ...tempo,
                endDate: nextTempo?.date || tempo.date + tempo.beatLength * 100 * 720
            }

            const endMs = computeMillisecondsAt(tempoWithEndDate.endDate, tempoWithEndDate)

            msm.allNotes
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

            currentFrameBeginMs += endMs
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
    console.log('approximating date for', targetMilliseconds, 'within tempo instruction', effectiveTempoInstruction["xml:id"])
    if (!isTransition(effectiveTempoInstruction)) {
        return (
            +effectiveTempoInstruction.date +
            physicalToSymbolic(targetMilliseconds / 1000, effectiveTempoInstruction.bpm, effectiveTempoInstruction.beatLength)
        )
    }

    console.log('initial=', initialGuess)

    let guess = initialGuess;
    let guessedMilliseconds = computeMillisecondsAt(guess, effectiveTempoInstruction);
    for (let i = 0; i < 1000 && Math.abs(guessedMilliseconds - targetMilliseconds) > tolerance; i++) {
        guess += 0.1 * (targetMilliseconds - guessedMilliseconds)
        guessedMilliseconds = computeMillisecondsAt(guess, effectiveTempoInstruction);
    }

    console.log('after=', guess)


    return Math.round(guess);
}

