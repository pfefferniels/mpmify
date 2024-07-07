import { MPM, Part, Rubato } from "mpm-ts"
import { MSM } from "../../msm"
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

export type Frame = {
    date: number
    length: number
}

export interface InterpolateRubatoOptions extends TransformationOptions {
    frames: Frame[]

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
            part: 'global',
            frames: []
        })
    }

    public name() { return 'InterpolateRubato' }

    public transform(msm: MSM, mpm: MPM): string {
        const rubatos: Rubato[] = []
        for (const frame of this.options.frames) {
            const chords = [...msm.asChords(this.options.part).entries()]
                .filter(([date, _]) => date >= frame.date && date < frame.date + frame.length)


            // The rubato transformation can only be placed
            // after a tempo interpolation. Make sure that 
            // all notes have a tick date and a tick duration.
            if (chords.some(([_, notes]) =>
                notes.some(note => note.tickDate === undefined || note.tickDuration === undefined))
            ) {
                console.log('Some note of the provided MSM does not have a tick date or a tick duration. Not continuing.')
                return super.transform(msm, mpm)
            }

            const intensities = chords.map(([date, notes]) => {
                const realDate = notes.reduce((prev, curr) => prev + curr.tickDate, 0) / notes.length

                // scale both vertical and horizontal to [0,1]
                const relativeDate = (date - frame.date) / frame.length
                const relativeDateShifted = (realDate - frame.date) / frame.length

                if (relativeDateShifted === 0 || relativeDate === 0) {
                    return 0.5
                }

                return Math.log(relativeDateShifted) / Math.log(relativeDate)
            })

            // Then take its avarage.
            // TODO: Should be replace be a better method.
            const avgIntensity = intensities.reduce((p, c) => p + c, 0) / intensities.length

            rubatos.push({
                'type': 'rubato',
                'xml:id': `rubato${v4()}`,
                'date': frame.date,
                'frameLength': frame.length,
                'intensity': +avgIntensity.toFixed(2),
                'loop': false
            })
        }

        mpm.insertInstructions(rubatos, this.options.part)

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
