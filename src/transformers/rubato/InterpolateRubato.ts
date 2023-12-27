import { MPM, Part, Rubato } from "mpm-ts"
import { MSM, MsmNote } from "../../msm"
import { BeatLengthBasis, calculateBeatLength } from "../BeatLengthBasis"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
import { v4 } from "uuid"

/**
 * This function calculates the effect of the rubato
 * on the MSM notes
 */
const calculateRubatoOnDate = (date: number, rubato: Rubato) => {
    const localDate = (date - rubato.date) % rubato.frameLength;      // compute the position of the map element within the rubato frame
    const d = Math.pow(localDate / rubato.frameLength, rubato.intensity) * rubato.frameLength;
    return date + d - localDate
}

/**
 * This function does the opposite of `calculateRubatoDate`:
 * It removes the "rubato effect" from a given date.
 * TODO: find a numerical, non-iterative solution.
 */
const removeRubatoFromDate = (newDate: number, rubato: Rubato) => {
    const target = rubato.date + ((newDate - rubato.date) % rubato.frameLength);
    let lowerBound = rubato.date;
    let upperBound = rubato.date + rubato.frameLength;

    console.log('target=', target, 'lower bound=', lowerBound, 'upper bound=', upperBound)

    while (upperBound - lowerBound > 1e-6) {
        const middle = (upperBound + lowerBound) / 2;
        const middleNewDate = calculateRubatoOnDate(middle, rubato);

        if (Math.abs(target - middleNewDate) < 1) {
            return middle - rubato.date;
        } else if (middleNewDate < target) {
            lowerBound = middle;
        } else {
            upperBound = middle;
        }
    }

    return lowerBound - rubato.date;
};

export interface InterpolateRubatoOptions extends TransformationOptions {
    /**
     * Tolerance in ticks to deviate from score onset time. Default value is 5.
     */
    tolerance: number

    /**
     * On which beat length to base the calculation of tempo rubato. If
     * set to 'everything', it will try to compensate the remaining onset 
     * times from a previous tempo calculation.
     */
    beatLength: BeatLengthBasis

    /**
     * The part on which the transformer is to be applied to.
     */
    part: Part
}

/**
 * Interpolates <rubato> elements.
 */
export class InterpolateRubato extends AbstractTransformer<InterpolateRubatoOptions> {
    constructor(options?: InterpolateRubatoOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            tolerance: 5,
            part: 'global',
            beatLength: 'everything'
        })
    }

    public name() { return 'InterpolateRubato' }

    public transform(msm: MSM, mpm: MPM): string {
        const tolerance = this.options?.tolerance || 20

        // The rubato transformation can only be placed
        // after a tempo interpolation. Make sure that 
        // all notes have a tick date and a tick duration.
        if (msm.allNotes.some(note => note.tickDate === undefined || note.tickDuration === undefined)) {
            console.log('Some note of the provided MSM does not have a tick date or a tick duration. Not continuing.')
            return super.transform(msm, mpm)
        }

        const chords = Object.entries(msm.asChords(this.options?.part))

        type RubatoChunk = {
            events: {
                date: number,
                shift: number
            }[]
            frameLength: number
        }

        // slice the chords into chunks
        let chunks: RubatoChunk[] = []

        if (this.options?.beatLength === 'everything') {
            // in the default case, try compensate the "left-overs" 
            // of the previous tempo interpolation with rubato elements.
            let currentPos = 0
            while (currentPos < chords.length - 1) {
                // from the current position onwards, find the next chord where
                // the difference between score onset and performed onset is 
                // in an acceptable range.
                const nextNull = chords.slice(currentPos + 1).find(([_, chord]) => {
                    // at this point, all notes inside a chord should be aligned
                    // to the same onset, so we simply take the first note of the
                    // chord.
                    const note = chord[0]
                    return (note.tickDate - note.date) < tolerance
                })

                if (nextNull) {
                    const nextPos = chords.indexOf(nextNull, currentPos + 1)

                    // filter out single events
                    if (nextPos === currentPos + 1) {
                        currentPos = nextPos
                        continue
                    }

                    chunks.push({
                        events: chords.slice(currentPos, nextPos).map(([date, chord]) => {
                            return {
                                date: +date,
                                shift: chord[0].tickDate - chord[0].date
                            }
                        }),
                        frameLength: +chords[nextPos][0] - +chords[currentPos][0]
                    })
                    currentPos = nextPos
                }
                else {
                    // use everything from here to the end and stop slicing
                    chunks.push({
                        events: chords.slice(currentPos).map(([date, chord]) => ({
                            date: +date,
                            shift: chord[0].tickDate - chord[0].date
                        })),
                        frameLength: +chords[currentPos][0] + chords[currentPos][1][0].duration
                    })
                    break
                }
            }
        }
        else {
            if (!msm.timeSignature) {
                console.log('no time signature specified in MSM.')

                // hand it over to the next transformer
                return super.transform(msm, mpm)
            }
            const beatLength = calculateBeatLength(this.options?.beatLength || 'bar', msm.timeSignature!);
            console.log('beat length=', beatLength)

            for (let date = 0; date <= msm.lastDate(); date += beatLength) {
                // filter those chords which are inside the current frame
                const internalChords = chords
                    .filter(([chordDate, _]) => {
                        return (+chordDate) >= date && (+chordDate) < (date + beatLength)
                    })

                // for a successfull rubato interpolation, at least two 
                // chords are required.
                if (internalChords.length <= 1) continue

                chunks.push({
                    events: internalChords
                        .map(([date, chord]) => {
                            return {
                                date: +date,
                                shift: chord[0].tickDate - chord[0].date
                            }
                        }),
                    frameLength: beatLength
                })
            }
        }

        console.log(JSON.stringify(chunks, null, 4));

        const instructions: Rubato[] = chunks
            .map(chunk => {
                // every chunk becomes a rubato instruction

                // calculate the intensity for every given point inside the chunk
                let intensities = chunk.events.slice(1).map(({ date, shift }) => {
                    // scale both vertical and horizontal to [0,1]
                    const relativeDate = (date - chunk.events[0].date) / chunk.frameLength
                    const relativeDateShifted = (date + shift - chunk.events[0].date) / chunk.frameLength

                    return Math.log(relativeDateShifted) / Math.log(relativeDate)
                })

                // Then take its avarage.
                // TODO: Should be replace be a better method.
                const avgIntensity = intensities.reduce((p, c) => p + c, 0) / intensities.length

                return {
                    'type': 'rubato',
                    'xml:id': `rubato${v4()}`,
                    'date': chunk.events[0].date,
                    'frameLength': chunk.frameLength,
                    'intensity': +avgIntensity.toFixed(2),
                    'loop': false
                }
            })
            .reduce((all, curr) => {
                // find repeating rubato instructions and merge them

                const last = all[all.length - 1]
                if (last && curr.frameLength === last.frameLength && curr.intensity === last.intensity) {
                    last.loop = true
                    return all
                }

                // make sure that we use only valid intensities
                if (isFinite((curr as Rubato).intensity)) {
                    all.push(curr as Rubato)
                }
                return all
            }, new Array<Rubato>())

        mpm.insertInstructions(instructions, this.options?.part !== undefined ? this.options.part : 'global')

        this.removeRubatoDistortion(msm, mpm)

        // hand it over to the next transformer
        return super.transform(msm, mpm)
    }

    /**
     * This method removes any rubato distortions from the
     * duration of notes.
     * 
     * @param msm 
     * @param mpm 
     */
    removeRubatoDistortion(msm: MSM, mpm: MPM) {
        const affectedNotes =
            this.options?.part === 'global' ?
                msm.allNotes :
                msm.allNotes.filter(n => n.part - 1 === this.options?.part)

        for (const note of affectedNotes) {
            if (!note.tickDuration) continue

            const onsetRubato = mpm.instructionsEffectiveAtDate<Rubato>(note.date, 'rubato', this.options?.part !== undefined ? this.options.part : 'global')[0]
            const onsetInTicks = onsetRubato
                ? calculateRubatoOnDate(note.date, onsetRubato)
                : note.date

            const onsetDiff = onsetInTicks - note.date
            note.tickDuration += onsetDiff

            const offset = note.date + note.tickDuration

            const rubatos = mpm.instructionsEffectiveAtDate<Rubato>(offset, 'rubato', this.options?.part !== undefined ? this.options.part : 'global')
            const effectiveRubato = rubatos[0]
            if (!effectiveRubato) continue

            const rubatoStart = offset - ((offset - effectiveRubato.date) % effectiveRubato.frameLength)
            const remainder = offset - rubatoStart
            note['tickDuration'] -= remainder

            const remainderWithoutRubato = removeRubatoFromDate(effectiveRubato.date + remainder, effectiveRubato)!
            note['tickDuration'] += remainderWithoutRubato
        }
    }
}
