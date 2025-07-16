import { MPM, Rubato } from "mpm-ts"
import { MSM, MsmNote } from "../../msm"
import { AbstractTransformer, generateId, ScopedTransformationOptions } from "../Transformer"
import { clamp, DefinedProperty } from "../../utils/utils"
import { TranslateToTicks } from "../tempo"
import { determineIntensity } from "../ornamentation"

const avarageTickDate = (notes: DefinedProperty<MsmNote, 'tickDate'>[]) => {
    return notes.reduce((prev, curr) => prev + curr.tickDate, 0) / notes.length
}

/**
 * This function calculates the effect of the rubato
 * on the MSM notes
 */
export const calculateRubatoOnDate = (date: number, rubato: Rubato) => {
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

export interface InsertRubatoOptions extends ScopedTransformationOptions {
    date: number
    length: number
}

/**
 * Interpolates <rubato> elements.
 */
export class InsertRubato extends AbstractTransformer<InsertRubatoOptions> {
    name = 'InsertRubato'
    requires = [TranslateToTicks]

    constructor(options?: InsertRubatoOptions) {
        super()

        // set the default options
        this.options = options || {
            scope: 'global',
            date: 0,
            length: 720
        }
    }

    protected transform(msm: MSM, mpm: MPM) {
        const frame = { date: this.options.date, length: this.options.length }
        const chords = [...msm.asChords(this.options.scope).entries()]
            .filter(([date, _]) => date >= frame.date && date <= frame.date + frame.length)

        console.log('dealing with frame', frame, 'and adjusting', chords)
        if (chords.length < 2) return

        // The rubato transformation can only be placed
        // after a tempo interpolation. Make sure that 
        // all notes have a tick date and a tick duration.
        if (chords.some(([_, notes]) =>
            notes.some(note => note.tickDate === undefined || note.tickDuration === undefined))
        ) {
            console.log('Some note of the provided MSM does not have a tick date or a tick duration. Not continuing.')
            return
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

        const scaledDates = chords
            .map(([, notes]) => {
                const realDate = notes.reduce((prev, curr) => prev + curr.tickDate, 0) / notes.length
                return (realDate - startDate) / (endDate - startDate)
            })

        const intensity = determineIntensity(scaledDates)

        const rubato: Rubato = {
            type: 'rubato',
            'xml:id': generateId('rubato', frame.date, mpm),
            date: frame.date,
            frameLength: frame.length,
            intensity,
            loop: false,
            lateStart,
            earlyEnd
        }

        mpm.insertInstruction(rubato, this.options.scope)
        this.removeRubatoDistortionFrom([rubato], msm, mpm)
    }

    /**
     * This method removes any rubato distortions from the
     * duration of notes.
     * 
     * @todo remove the distortion from pedals as well.
     * @param msm 
     * @param mpm 
     */
    removeRubatoDistortionFrom(selectedRubatos: Rubato[], msm: MSM, mpm: MPM) {
        const affectedNotes =
            this.options.scope === 'global' ?
                msm.allNotes :
                msm.allNotes.filter(n => n.part - 1 === this.options.scope)

        for (const note of affectedNotes) {
            if (!note.tickDuration) continue

            const onsetRubato = mpm.instructionsEffectiveAtDate<Rubato>(note.date, 'rubato', this.options.scope)[0];
            if (!onsetRubato || !selectedRubatos.includes(onsetRubato)) continue

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

            const rubatos = mpm.instructionsEffectiveAtDate<Rubato>(offset, 'rubato', this.options.scope)
            const effectiveRubato = rubatos[0]
            if (!effectiveRubato || !selectedRubatos.includes(effectiveRubato)) continue

            const rubatoStart = offset - ((offset - effectiveRubato.date) % effectiveRubato.frameLength)
            const remainder = offset - rubatoStart
            note['tickDuration'] -= remainder

            const remainderWithoutRubato = removeRubatoFromDate(effectiveRubato.date + remainder, effectiveRubato)!
            note['tickDuration'] += remainderWithoutRubato
        }
    }
}
