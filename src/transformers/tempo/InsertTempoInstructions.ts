import { v4 } from "uuid";
import { MPM, Part, Tempo } from "mpm-ts";
import { MSM } from "../../msm";
import { BeatLengthBasis, calculateBeatLength, filterByBeatLength } from "../BeatLengthBasis";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { isDefined } from "../../utils/isDefined";

export interface InsertTempoInstructionsOptions extends TransformationOptions {
    /**
     * Defines on which part to apply to transformer to.
     * @default 'global'
     */
    part: Part

    /**
     * The basis on which to calculate the beat lengths on. 
     * @todo It should be possible to define ranges in a piece
     * with different beat lengthes.
     * @default 'denominator'
     */
    beatLength: BeatLengthBasis
}

/**
 * Inserts tempo instructions into the given part based on the
 * given beat length.
 */
export class InsertTempoInstructions extends AbstractTransformer<InsertTempoInstructionsOptions> {
    constructor(options?: InsertTempoInstructionsOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            part: 'global',
            beatLength: 'denominator',
        })
    }

    public name() { return 'InsertTempoInstructions' }

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
                const nextNote = selectedNotes[i + 1]

                let ratio = 1
                let nextOnset, beatLength
                if (nextNote) {
                    nextOnset = nextNote['midi.onset']
                    if (this.options.beatLength === 'everything') {
                        beatLength = currentNote['duration'] / 720 / 4
                    }
                    else {
                        const givenBeatLength = calculateBeatLength(this.options.beatLength, msm.timeSignature)

                        if (nextNote.date !== currentNote.date + givenBeatLength) {
                            const newBeatLength = nextNote.date - currentNote.date
                            ratio = givenBeatLength / newBeatLength
                        }

                        beatLength = givenBeatLength / 720 / 4
                    }
                }
                else {
                    nextOnset = currentOnset + currentNote['midi.duration']
                    beatLength = currentNote['duration'] / 720 / 4
                }

                const bpm = nextOnset !== undefined ? 60 / (ratio * (nextOnset - currentOnset)) : 60

                return {
                    type: 'tempo',
                    date: currentNote.date,
                    'xml:id': `tempo_${v4()}`,
                    beatLength,
                    bpm
                } as Tempo
            })
            .filter(tempo => !isNaN(tempo.bpm))

        mpm.insertInstructions(tempos, this.options?.part || 'global')

        return super.transform(msm, mpm)
    }
}

