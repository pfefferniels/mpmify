import { MPM } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions, Transformer } from "../Transformer"

export interface InterpolateTimingImprecisionOptions extends TransformationOptions {
    predefinedImprecision: number
}

/**
 * Interpolates the remaining difference between score and performance 
 * and creates an <imprecision.timing> map. It may take into account 
 * a pre-existent imprecision range, in case of Welte-Mignon piano rolls
 * e.g. around 10ms. This value will be subtracted from the timing 
 * imprecision.
 */
export class InterpolateTimingImprecision extends AbstractTransformer<InterpolateTimingImprecisionOptions> {
    name = 'InterpolateTimingImprecision'
    requires = []

    constructor() {
        super()
    }

    public transform(msm: MSM, mpm: MPM) {
        const timingImprecision = {
            'distribution.uniform': {
                '@': {
                    'date': 0.0,
                    'limit.lower': -10 + (this.options?.predefinedImprecision || 0) / 2,
                    'limit.upper':  10 - (this.options?.predefinedImprecision || 0) / 2
                }
            }
        }

        // mpm.insertInstructions(..., 'global')
    }
}
