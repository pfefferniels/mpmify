import { MPM, Rubato } from "mpm-ts"
import { AbstractTransformer, ScopedTransformationOptions, TransformationOptions } from "../Transformer"
import { InsertRubato } from "./InsertRubato"
import { MSM } from "../../msm"
import { v4 } from "uuid"

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
    options: CombineAdjacentRubatoOptions

    constructor(options?: CombineAdjacentRubatoOptions) {
        super()

        // set the default options
        this.options = options || {
            intensityTolerance: 0.2,
            compressionTolerance: 0.1,
            scope: 'global',
        }
    }

    protected transform(msm: MSM, mpm: MPM) {
        const rubatos = mpm.getInstructions<Rubato>('rubato', this.options.scope)
        if (rubatos.length <= 1) return

        let ref = rubatos[0]
        while (ref) {
            for (let date = ref.date + ref.frameLength; date < msm.lastDate(); date += ref.frameLength) {
                const current = rubatos.find(r => r.date === date)

                if (current &&
                    (ref.intensity < 1 && current.intensity < 1 || ref.intensity > 1 && current.intensity > 1)
                    && Math.abs(current.intensity - ref.intensity) < this.options.intensityTolerance
                    && Math.abs((current.lateStart || 0) - (ref.lateStart || 0)) < this.options.compressionTolerance
                    && Math.abs((current.earlyEnd || 1) - (ref.earlyEnd || 1)) < this.options.compressionTolerance
                ) {
                    const count = (date - ref.date) / ref.frameLength
                    ref.loop = true
                    ref.intensity = (ref.intensity * count + current.intensity) / (count + 1)
                    ref.lateStart = ((ref.lateStart || 0) * count + (current.lateStart || 0)) / (count + 1)
                    ref.earlyEnd = ((ref.earlyEnd || 1) * count + (current.earlyEnd || 1)) / (count + 1)
                    mpm.removeInstruction(current)
                    rubatos.splice(rubatos.indexOf(current), 1)
                } else {
                    if (ref.loop) {
                        // in order to stop the loop, we once need to insert a
                        // new, "neutral" rubato
                        mpm.insertInstruction({
                            type: 'rubato',
                            date,
                            frameLength: ref.frameLength,
                            'xml:id': `rubato_${v4()}`,
                        }, this.options.scope)
                    }

                    ref = rubatos.find(r => r.date > date)
                    break;
                }
            }
        }
    }
}

