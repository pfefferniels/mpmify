import { MPM, Rubato } from "../../mpm"
import { MSM, MsmNote } from "../../msm"
import { AbstractTransformer, generateId, ScopedTransformationOptions } from "../Transformer"
import { clamp } from "../../utils/utils"
import { TranslatePhysicalTimeToTicks } from "../tempo"
import { determineIntensity } from "../ornamentation"
import { deriveResidual, Residual } from "../../residual"

// Re-exported: `calculateRubatoOnDate` has been part of the package surface since before it
// moved, and mpm-desk's rubato desk imports it from "mpmify".
export { calculateRubatoOnDate } from "./rubatoMath"

const avarageTickDate = (notes: MsmNote[], residual: Residual) => {
    return notes.reduce((prev, curr) => prev + residual.of(curr)!.tickDate!, 0) / notes.length
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
        // Where the notes fell under the tempo, with rubato held out — this is what fits it.
        // Holding it out also means a second call over a looping frame reads the same raw
        // positions the first one did, rather than positions the first call has compensated.
        const residual = deriveResidual(msm, mpm, { without: ['rubato'] })

        const frame = { date: this.options.date, length: this.options.length }
        const chords = [...msm.asChords(this.options.scope).entries()]
            .filter(([date, _]) => date >= frame.date && date < frame.date + frame.length)

        if (chords.length === 0) return

        // The rubato transformation can only be placed
        // after a tempo interpolation. Make sure that 
        // all notes have a tick date and a tick duration.
        if (chords.some(([_, notes]) =>
            notes.some(note => residual.of(note)?.tickDate === undefined
                || residual.of(note)?.tickDuration === undefined))
        ) {
            console.warn('InsertRubato: some note has no tick date or duration — run a tempo interpolation first.')
            return
        }

        // if there are notes on the first date, we can use their 
        // average tick date to determine a late start. Otherwise, 
        // there is no late start.
        const startDate = chords[0][0] === this.options.date
            ? avarageTickDate(chords[0][1], residual)
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
                const realDate = avarageTickDate(notes, residual)
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

        mpm.insertInstruction(rubato, this.options.scope)
    }

}
