import { v4 } from "uuid";
import { MPM, Ornament, Tempo } from "mpm-ts";
import { MSM } from "../msm";
import { BeatLengthBasis, calculateBeatLength, filterByBeatLength } from "./BeatLengthBasis";
import { AbstractTransformer, TransformationOptions } from "./Transformer";
import { physicalToSymbolic } from "./basicCalculations";

interface TempoWithEndDate extends Tempo {
    endDate: number
}

const isDefined = (onset?: number) => {
    return onset !== undefined && !isNaN(onset)
}

export interface SimpleTempoTransformerOptions extends TransformationOptions {
    /**
     * The basis on which to calculate the beat lengths on. 
     * @todo It should be possible to define ranges in a piece
     * with different beat lengthes.
     */
    beatLength: BeatLengthBasis

    /**
     * Tolerance of the Dogulas-Peucker algorithm
     */
    epsilon: number

    /**
     * The number of digits to appear after the decimal point of a BPM value
     */
    precision: number

    /**
     * Defines whether physical modifiers which are already present in the MPM
     * (e.g. because of a previous <ornamentation> or <asynchrony> interpolation)
     * should be translated into symbolic ones.
     */
    translatePhysicalModifiers: boolean

    linearTransitions: boolean
}

/**
 * Interpolates the global tempo and inserts it into the MPM
 */
export class SimpleTempoTransformer extends AbstractTransformer<SimpleTempoTransformerOptions> {
    constructor(options?: SimpleTempoTransformerOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            beatLength: 'denominator',
            epsilon: 4,
            precision: 0,
            translatePhysicalModifiers: true,
            linearTransitions: false
        })
    }

    public name() { return 'SimpleTempoTransformer' }

    /**
     * Deletes the silence before the first note is being played 
     * 
     * @param msm MSM to perform the shifting on
     */
    private shiftToFirstOnset(msm: MSM) {
        const firstOnset = Math.min(...msm.allNotes.map(n => n["midi.onset"]).filter(isDefined))
        msm.allNotes.forEach(n => n["midi.onset"] -= firstOnset)
    }

    transform(msm: MSM, mpm: MPM): string {
        console.log(msm.allNotes.map(n => n['midi.onset']))
        if (!msm.timeSignature) {
            console.warn('A time signature must be given to interpolate a tempo map.')
            return super.transform(msm, mpm);
        }

        // const precision = this.options?.precision || 0

        // before starting to calculate the <tempo> instructions,
        // make sure to delete the arbitrary silence before the first note onset
        this.shiftToFirstOnset(msm)

        const chords = Object.entries(msm.asChords())
        const tempos = chords
            .filter(filterByBeatLength(this.options.beatLength, msm.timeSignature))
            .filter(([_, chord]) => {
                if (chord.length === 0) {
                    console.warn('Empty chord found. This is not supposed to happen.')
                }

                return chord.length !== 0
            })
            .map(([date, chord]) => {
                const firstNote = chord[0]
                if (chord.some(note => note["midi.onset"] !== firstNote["midi.onset"])) {
                    console.log(`Not all notes in the chord at ${date}
                    occur at the same physical time. Make sure that a global physical
                    ornamentation map and/or asynchrony map are calculated before
                    applying this transformer.`)
                }
                return firstNote
            })
            .map((currentNote, i, selectedNotes) => {
                const currentOnset = currentNote["midi.onset"]
                // TODO consider beatLength in case of beat length basis = 'everything'
                // and deal with left-out beats.
                const nextNote = selectedNotes[i + 1]
                const nextOnset = nextNote ? nextNote['midi.onset'] : currentOnset + currentNote['midi.duration']

                return {
                    type: 'tempo',
                    date: currentNote.date,
                    'xml:id': `tempo${v4()}`,
                    beatLength: this.options.beatLength === 'everything'
                        ? currentNote.duration
                        : calculateBeatLength(this.options.beatLength, msm.timeSignature) / 720 / 4,
                    bpm: nextOnset !== undefined ? 60 / (nextOnset - currentOnset) : 60
                } as Tempo
            })
        
        if (this.options.linearTransitions) {
            tempos.forEach((tempo, i) => {
                if (i === tempos.length - 1) return 
                tempo['transition.to'] = 0.5
            })
        }

        mpm.insertInstructions(tempos, 'global')

        this.addTickOnsets(msm, mpm)
        if (this.options.translatePhysicalModifiers) this.translatePhysicalMPMModifiers(mpm)

        this.addTickDurations(msm, mpm)

        return super.transform(msm, mpm)
    }

    /**
     * 
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

                const ornamentMs = computeMillisecondsForTransition(ornament.date, tempoWithEndDate)
                const frameStart = ornamentMs + ornament["frame.start"]
                console.log('ornament ms @', ornament.date, '=', ornamentMs, 'frameStart=', frameStart)
                if (frameStart < 0) {
                    // use previous tempo frame
                    continue
                }
                const tickFrameStart = approximateDate(frameStart, tempoWithEndDate)

                const frameEnd = frameStart + ornament.frameLength
                const tickFrameEnd = approximateDate(frameEnd, tempoWithEndDate)

                ornament["frame.start"] = tickFrameStart - ornament.date
                ornament['frameLength'] = tickFrameEnd - tickFrameStart
                ornament['time.unit'] = 'ticks'
            }

            currentMilliseconds += computeMillisecondsForTransition(tempoWithEndDate.endDate, tempoWithEndDate)
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

            // find all ornaments that fit into the tempo frame
            const ornaments = mpm.instructionEffectiveInRange<Ornament>(tempo.date, tempoWithEndDate.endDate, 'ornament')
            for (const ornament of ornaments) {
                const ornamentMs = computeMillisecondsForTransition(ornament.date, tempoWithEndDate)
                const frameStart = ornamentMs + ornament["frame.start"]
                if (frameStart < 0) {
                    // use previous tempo frame
                    continue
                }
                const tickFrameStart = approximateDate(frameStart, tempoWithEndDate)

                const frameEnd = frameStart + ornament.frameLength
                const tickFrameEnd = approximateDate(frameEnd, tempoWithEndDate)

                ornament["frame.start"] = tickFrameStart - ornament.date
                ornament['frameLength'] = tickFrameEnd - tickFrameStart
                ornament['time.unit'] = 'ticks'
            }

            currentMilliseconds += computeMillisecondsForTransition(tempoWithEndDate.endDate, tempoWithEndDate)
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
    addTickDurations(msm: MSM, mpm: MPM) {
        const tempos = mpm.getInstructions<Tempo>('tempo', 'global')

        let currentFrameBeginMilliseconds = 0
        for (let i = 0; i < tempos.length; i++) {
            const tempo = tempos[i]
            const nextTempo = tempos[i + 1]

            const tempoWithEndDate: TempoWithEndDate = {
                ...tempo,
                endDate: nextTempo?.date || tempo.date + tempo.beatLength * 100 * 720
            }

            const endMilliseconds = computeMillisecondsForTransition(tempoWithEndDate.endDate, tempoWithEndDate)

            msm.allNotes
                .filter(n => n["midi.duration"])
                .forEach(n => {
                    const offsetMs = (n['midi.onset'] + n["midi.duration"]) * 1000 - currentFrameBeginMilliseconds
                    if (offsetMs > endMilliseconds) return
                    n.tickDuration = approximateDate(offsetMs, tempoWithEndDate) - n.tickDate
                    delete n["midi.duration"]
                    delete n["midi.onset"]
                })

            currentFrameBeginMilliseconds += endMilliseconds
        }
    }
}

const isTransition = (tempo: Tempo) => {
    return tempo["transition.to"] && tempo.meanTempoAt
}

const computeMillisecondsForTransition = (date: number, tempo: TempoWithEndDate): number => {
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

const getTempoAt = (date: number, tempo: TempoWithEndDate): number => {
    // no tempo
    if (!tempo.bpm) return 100.0;

    // constant tempo
    if (!tempo["transition.to"]) return tempo.bpm

    if (date === tempo.endDate) return tempo["transition.to"]

    const result = (date - tempo.date) / (tempo.endDate - tempo.date);
    const exponent = Math.log(0.5) / Math.log(tempo.meanTempoAt);
    return Math.pow(result, exponent) * (tempo["transition.to"] - tempo.bpm) + tempo.bpm;
}

const approximateDate = (targetMilliseconds: number, effectiveTempoInstruction: TempoWithEndDate, initialGuess: number = effectiveTempoInstruction.date, tolerance: number = 1): number => {
    if (!isTransition(effectiveTempoInstruction)) {
        return effectiveTempoInstruction.date + physicalToSymbolic(targetMilliseconds / 1000, effectiveTempoInstruction.bpm, effectiveTempoInstruction.beatLength)
    }

    let guess = initialGuess;
    let guessedMilliseconds = computeMillisecondsForTransition(guess, effectiveTempoInstruction);
    for (let i = 0; i < 1000 && Math.abs(guessedMilliseconds - targetMilliseconds) > tolerance; i++) {
        guess += 0.1 * (targetMilliseconds - guessedMilliseconds)
        guessedMilliseconds = computeMillisecondsForTransition(guess, effectiveTempoInstruction);
    }

    return Math.round(guess);
}

