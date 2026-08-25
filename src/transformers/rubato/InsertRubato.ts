import { MPM, Rubato } from "../../mpm"
import { MSM, MsmNote } from "../../msm"
import { AbstractTransformer, generateId, ScopedTransformationOptions } from "../Transformer"
import { clamp, DefinedProperty } from "../../utils/utils"
import { TranslatePhysicalTimeToTicks } from "../tempo"
import { determineIntensity } from "../ornamentation"
import { removeRubatoDistortion } from "./rubatoMath"

// Re-exported: `calculateRubatoOnDate` has been part of the package surface since before it
// moved, and mpm-desk's rubato desk imports it from "mpmify".
export { calculateRubatoOnDate } from "./rubatoMath"

const avarageTickDate = (notes: DefinedProperty<MsmNote, 'tickDate'>[]) => {
    return notes.reduce((prev, curr) => prev + curr.tickDate, 0) / notes.length
}

export interface InsertRubatoOptions extends ScopedTransformationOptions {
    date: number
    length: number
}

/**
 * Interpolates <rubato> elements.
 */
export class InsertRubato extends AbstractTransformer<InsertRubatoOptions> {
    name = 'InsertRubato'
    requires = [TranslatePhysicalTimeToTicks]

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
            .filter(([date, _]) => date >= frame.date && date < frame.date + frame.length)

        if (chords.length === 0) return

        // The rubato transformation can only be placed
        // after a tempo interpolation. Make sure that 
        // all notes have a tick date and a tick duration.
        if (chords.some(([_, notes]) =>
            notes.some(note => note.tickDate === undefined || note.tickDuration === undefined))
        ) {
            console.warn('InsertRubato: some note has no tick date or duration — run a tempo interpolation first.')
            return
        }

        // if there are notes on the first date, we can use their 
        // average tick date to determine a late start. Otherwise, 
        // there is no late start.
        const startDate = chords[0][0] === this.options.date
            ? avarageTickDate(chords[0][1] as DefinedProperty<MsmNote, 'tickDate'>[])
            : this.options.date
        let lateStart =
            clamp(
                0,
                (startDate - frame.date) / frame.length,
                0.9
            )
        if (lateStart === 0) lateStart = undefined

        const endDate = this.options.date + this.options.length

        const scaledDates = chords
            .map(([, notes]) => {
                const realDate = notes.reduce((prev, curr) => prev + curr.tickDate, 0) / notes.length
                return (realDate - startDate) / (endDate - startDate)
            })

        if (!scaledDates.includes(0)) {
            scaledDates.unshift(0)
        }
        if (!scaledDates.includes(1)) {
            scaledDates.push(1)
        }

        const intensity = determineIntensity(scaledDates)

        const rubato: Rubato = {
            type: 'rubato',
            'xml:id': generateId('rubato', frame.date, mpm),
            date: frame.date,
            frameLength: frame.length,
            intensity,
            loop: false,
            lateStart,
        }

        // The inserted view, not the record: `removeRubatoDistortionFrom` recognises "its own"
        // rubato by identity against what `instructionsEffectiveAtDate` hands back, which is
        // the view over the element.
        const inserted = mpm.insertInstruction(rubato, this.options.scope)
        this.removeRubatoDistortionFrom([inserted], msm, mpm)
    }

    /**
     * Takes the distortion of `selectedRubatos` back off the notes they cover.
     *
     * The identity test is the point: `instructionsEffectiveAtDate` answers with the view over
     * the element, and `selectedRubatos` holds the views this run inserted, so a rubato some
     * earlier run wrote is left alone.
     */
    removeRubatoDistortionFrom(selectedRubatos: Rubato[], msm: MSM, mpm: MPM) {
        removeRubatoDistortion(msm, mpm, this.options.scope, r => selectedRubatos.includes(r))
    }
}
