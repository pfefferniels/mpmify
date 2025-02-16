import { MPM, Rubato, Scope } from "mpm-ts"
import { MSM, MsmNote } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
import { v4 } from "uuid"
import { clamp, DefinedProperty } from "../../utils/utils"

const avarageTickDate = (notes: DefinedProperty<MsmNote, 'tickDate'>[]) => {
    return notes.reduce((prev, curr) => prev + curr.tickDate, 0) / notes.length
}

/**
 * This function calculates the effect of the rubato
 * on the MSM notes
 */
const calculateRubatoOnDate = (date: number, rubato: Rubato) => {
    // compute the position of the map element within the rubato frame
    const localDate = (date - rubato.date) % rubato.frameLength;
    const lateStart = Math.max(Math.min(rubato.lateStart || 0, 0.9), 0)
    const earlyEnd = Math.max(Math.min(rubato.earlyEnd || 1, 1), 0.1)
    const d = (Math.pow(localDate / rubato.frameLength, rubato.intensity) * (earlyEnd - lateStart) + lateStart) * rubato.frameLength;
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

export type Frame = {
    date: number
    length: number
}

export interface InterpolateRubatoOptions extends TransformationOptions {
    frames: Frame[]

    /**
     * The part on which the transformer is to be applied to.
     */
    part: Scope
}

/**
 * Interpolates <rubato> elements.
 */
export class InterpolateRubato extends AbstractTransformer<InterpolateRubatoOptions> {
    name = 'InterpolateRubato'

    constructor(options?: InterpolateRubatoOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            part: 'global',
            frames: []
        })
    }

    public transform(msm: MSM, mpm: MPM) {
        const rubatos: Rubato[] = []
        for (const frame of this.options.frames) {
            const chords = [...msm.asChords(this.options.part).entries()]
                .filter(([date, _]) => date >= frame.date && date <= frame.date + frame.length)

            console.log('dealing with frame', frame, 'and adjusting', chords)
            if (chords.length < 2) continue

            // The rubato transformation can only be placed
            // after a tempo interpolation. Make sure that 
            // all notes have a tick date and a tick duration.
            if (chords.some(([_, notes]) =>
                notes.some(note => note.tickDate === undefined || note.tickDuration === undefined))
            ) {
                console.log('Some note of the provided MSM does not have a tick date or a tick duration. Not continuing.')
                continue
            }

            const startDate = avarageTickDate(chords[0][1] as DefinedProperty<MsmNote, 'tickDate'>[])
            let lateStart =
                clamp(
                    0,
                    (startDate - frame.date) / frame.length,
                    0.9
                )
            if (lateStart === 0) lateStart = undefined

            let earlyEnd: number | undefined
            const endDate = avarageTickDate(chords[chords.length - 1][1] as DefinedProperty<MsmNote, 'tickDate'>[])
            earlyEnd =
                clamp(
                    0.1,
                    (endDate - frame.date) / frame.length,
                    1
                )
            if (earlyEnd === 1) earlyEnd = undefined

            chords.splice(chords.length - 1, 1)
            chords.splice(0, 1)

            let intensity: number | undefined
            if (chords.length > 0) {
                const intensities = chords.map(([date, notes]) => {
                    const realDate = notes.reduce((prev, curr) => prev + curr.tickDate, 0) / notes.length

                    // scale both vertical and horizontal to [0,1]
                    const relativeDate = (date - frame.date) / frame.length
                    const relativeDateShifted = (realDate - frame.date) / frame.length

                    if (relativeDateShifted === 0 || relativeDate === 0) {
                        return 1
                    }

                    console.log(relativeDate, relativeDateShifted, Math.log(relativeDateShifted), Math.log(relativeDate))

                    return Math.log(relativeDateShifted) / Math.log(relativeDate)
                })

                // Then take its avarage.
                // TODO: Should be replace be a better method.
                intensity = intensities.reduce((p, c) => p + c, 0) / intensities.length
            }
            if (intensity === 1) intensity = undefined

            rubatos.push({
                type: 'rubato',
                'xml:id': `rubato_${v4()}`,
                date: frame.date,
                frameLength: frame.length,
                intensity,
                loop: false,
                lateStart,
                earlyEnd
            })
        }

        mpm.insertInstructions(rubatos, this.options.part)

        this.removeRubatoDistortion(msm, mpm)
    }

    /**
     * This method removes any rubato distortions from the
     * duration of notes.
     * 
     * @todo remove the distortion from pedals as well.
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
            if (!onsetRubato) continue

            const onsetInTicks = onsetRubato
                ? calculateRubatoOnDate(note.date, onsetRubato)
                : note.date


            const onsetDiff = onsetInTicks - note.date
            console.log('note', note, 'should be at date', onsetInTicks, 'instead of', note.date, 'so we shift it by', onsetDiff)
            if (note.tickDate) {
                note.tickDate -= onsetDiff
            }
            note.tickDuration -= onsetDiff

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
