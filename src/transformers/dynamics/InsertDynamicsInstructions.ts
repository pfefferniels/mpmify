import type { AddDynamicsOptions } from "espressivo"
import { Instruction, MPM, Scope } from "../../mpm"
import { MSM } from "../../msm"
import { AbstractTransformer, generateId, ScopedTransformationOptions } from "../Transformer"
import { approximateDynamics, DynamicsPoints } from "./Approximation"
import { WithEndDate } from "../tempo/tempoCalculations"

/**
 * A fitted `<dynamics>` plus the window it was fitted over.
 *
 * `endDate` is not an MPM attribute and is not in `AddDynamicsOptions`; it travels with the fit
 * only as far as {@link InsertDynamicsInstructions.transform}, which takes it back off before the
 * record reaches the document.
 */
export type DynamicsWithEndDate = AddDynamicsOptions & WithEndDate

export interface InsertDynamicsInstructionsOptions extends ScopedTransformationOptions {
    from: number
    to: number,
    phantomVelocities: Map<number, number>
}

export class InsertDynamicsInstructions extends AbstractTransformer<InsertDynamicsInstructionsOptions> {
    name = 'InsertDynamicsInstructions'
    requires = []

    constructor(options?: InsertDynamicsInstructionsOptions) {
        super(options || {
            scope: 'global',
            from: 0,
            to: 0,
            phantomVelocities: new Map()
        })
    }

    protected transform(msm: MSM, mpm: MPM) {
        const points = this.asPoints(msm, this.options.scope)
        const { from, to } = this.options

        const relevantPoints = points.filter(p => p.date >= from && p.date <= to)
        const fitted = approximateDynamics(relevantPoints)
        if (!fitted) return

        // `endDate` is the window the curve was fitted over — a working field, not an MPM
        // attribute. It used to be written into the document; a reader gets the span from the
        // next <dynamics> instead. See old-bugs.md.
        //
        // This destructuring is now the *only* thing keeping it out: the serializer used to write
        // from a table of attribute spellings, which had no row for `endDate`, and espressivo
        // writes what its options type names instead. Taking it off here is load-bearing, not
        // belt-and-braces.
        const { endDate: fittingWindow, ...fit } = fitted
        const instruction = { ...fit, id: generateId('dynamics', fit.date, mpm) }

        // The view the document ended up with, not the record handed in: an instruction already
        // at that date is merged into rather than replaced, so this is what the curve to be
        // closed actually says.
        const inserted = mpm.insertInstruction('dynamics', instruction, this.options?.scope)
        this.closeTransition(mpm, inserted, fittingWindow)
    }

    /**
     * Write the instruction that ends the fitted transition.
     *
     * A `transition.to` with no successor is not a curve stretched to the end of the piece —
     * the renderer drops the transition and holds `volume`, so a fit that nothing happens to
     * follow describes nothing at all. Closing the span at the last point the curve was fitted
     * over is what makes the transition render, and it makes the rendered span the fitted one —
     * the span mismatch old-bugs.md §1 left open. That mattered doubly while this transformer
     * also measured the residual; now that the residual is derived from the document, closing
     * the span is what the renderer needs rather than what a later fitter needs.
     *
     * An instruction already at that date already closes the span — in a chain each segment is
     * closed by the next — and is left alone.
     */
    private closeTransition(mpm: MPM, instruction: Instruction<'dynamics'>, endDate: number) {
        const target = instruction.transitionTo
        if (target === undefined || endDate <= instruction.date) return

        const existing = mpm.getInstructions('dynamics', this.options.scope)
        if (existing.some(dynamics => dynamics.date === endDate)) return

        mpm.insertInstruction('dynamics', {
            id: generateId('dynamics', endDate, mpm),
            date: endDate,
            volume: target
        }, this.options.scope)
    }

    private asPoints(msm: MSM, part: Scope): DynamicsPoints[] {
        const points: DynamicsPoints[] = []
        const chords = msm.asChords(part)
        for (const [date, notes] of chords) {
            const notesWithVolume = notes
                .filter(n => n["midi.velocity"] !== undefined)
            const velocity = notesWithVolume
                .reduce((sum, curr) => sum + curr["midi.velocity"], 0) / notesWithVolume.length

            const phantomVelocity = this.options.phantomVelocities.get(date)

            points.push({
                date,
                velocity: phantomVelocity || velocity
            })
        }

        return points
    }

}
