import { Instruction, MPM } from "../../mpm"
import { AbstractTransformer, generateId, ScopedTransformationOptions } from "../Transformer"
import { InsertRubato } from "./InsertRubato"
import { MSM } from "../../msm"

export interface CombineAdjacentRubatoOptions extends ScopedTransformationOptions {    // adjacentRubatos: Rubato[]
    /**
     * This parameter is used to determine if the @intensity attributes
     * of two adjacent rubato instructions are mergeable.
     */
    intensityTolerance: number

    /**
     * This parameter is used to determine if the attributes @lateStart
     * and @earlyEnd of two adjacent rubato instructions are mergeable.
     */
    compressionTolerance: number
}

/**
 * Merges adjacent rubato instructions if they have the similiar intensity
 * and compression by adding the @loop parameter to the first rubato instruction
 * of a series and setting @intensity, @lateStart and @earlyEnd to the average
 * of the series.
 */
export class CombineAdjacentRubatos extends AbstractTransformer<CombineAdjacentRubatoOptions> {
    name = 'CombineAdjacentRubatos'
    requires = [InsertRubato]

    constructor(options?: CombineAdjacentRubatoOptions) {
        super(options || {
            intensityTolerance: 0.2,
            compressionTolerance: 0.1,
            scope: 'global',
        })
    }

    protected transform(msm: MSM, mpm: MPM) {
        const rubatos = mpm.getInstructions('rubato', this.options.scope)
        if (rubatos.length <= 1) return

        const lastDate = msm.lastDate()

        // The frame the walk is about to fold a run onto: `undefined` once it has run past the
        // last rubato, which is the loop's own exit. The body works on `ref` rather than on
        // `next` itself, because the assignment at the foot of the loop otherwise makes the type
        // of `date` below depend, through the walk, on its own initializer.
        let next: Instruction<'rubato'> | undefined = rubatos[0]
        while (next) {
            // Reassigned rather than fixed, because folding a frame into `ref` is now
            // `updateInstruction`, which hands back a fresh snapshot and leaves this one stale.
            let ref: Instruction<'rubato'> = next

            // The frame the walk steps by. `@frameLength` is optional on the instruction — a
            // `<rubato>` may inherit it from a `rubatoDef` — and mpmify has no answer for an
            // absent one, so the arithmetic below stays NaN, `date < lastDate` is false, and a
            // frame that says nothing merges with nothing. That is what it did when the field
            // was typed as a number and the attribute was missing.
            const frameLength = ref.frameLength as number

            // Where the run of frames after `ref` stopped. `undefined` means it ran off the
            // end of the piece, which is the case that has no successor and no loop to close:
            // advancing the walk unconditionally is what keeps the outer loop finite. Leaving
            // it to the `for` alone meant that a `ref` whose next frame started at or after the
            // last note never advanced the walk and span forever. See old-bugs.md.
            let stoppedAt: number | undefined = undefined

            for (let date = ref.date + frameLength; date < lastDate; date += frameLength) {
                const current = rubatos.find(r => r.date === date)

                // A frame that carries no @intensity is warped at 1.0, the renderer's default
                // (espressivo `resolveRubato`) — the identity, which is neither the rush nor the
                // delay the direction test below looks for, so such a frame merges with nothing.
                // Reading the attribute raw reached the same outcome by accident: every
                // comparison against `undefined` is false. The other two defaults, already
                // spelled out below, are 0.0 for @lateStart and 1.0 for @earlyEnd.
                const refIntensity = ref.intensity ?? 1
                const currentIntensity = current?.intensity ?? 1

                if (current &&
                    (refIntensity < 1 && currentIntensity < 1 || refIntensity > 1 && currentIntensity > 1)
                    && Math.abs(currentIntensity - refIntensity) < this.options.intensityTolerance
                    && Math.abs((current.lateStart || 0) - (ref.lateStart || 0)) < this.options.compressionTolerance
                    && Math.abs((current.earlyEnd || 1) - (ref.earlyEnd || 1)) < this.options.compressionTolerance
                ) {
                    const count = (date - ref.date) / frameLength
                    ref = mpm.updateInstruction(ref, {
                        loop: true,
                        intensity: (refIntensity * count + currentIntensity) / (count + 1),
                        lateStart: ((ref.lateStart || 0) * count + (current.lateStart || 0)) / (count + 1),
                        earlyEnd: ((ref.earlyEnd || 1) * count + (current.earlyEnd || 1)) / (count + 1),
                    })
                    mpm.removeInstruction(current)
                    rubatos.splice(rubatos.indexOf(current), 1)
                } else {
                    stoppedAt = date
                    break;
                }
            }

            if (stoppedAt === undefined) {
                // The run reached the end of the piece: nothing left to close the loop against.
                break
            }

            if (ref.loop) {
                // in order to stop the loop, we once need to insert a
                // new, "neutral" rubato
                mpm.insertInstruction('rubato', {
                    date: stoppedAt,
                    frameLength,
                    id: generateId('rubato', stoppedAt, mpm),
                }, this.options.scope)
            }

            next = rubatos.find(r => r.date > stoppedAt)
        }
    }
}

