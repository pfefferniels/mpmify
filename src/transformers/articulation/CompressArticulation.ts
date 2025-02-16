import { Articulation, ArticulationDef, MPM, Part, Scope } from "mpm-ts";
import { MSM } from "../../msm";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { fix, toFixed } from "../../utils/utils";

interface CompressArticulationOptions extends TransformationOptions {
    volumePrecision: number 
    relativePrecision: number
}

export class CompressArticulation extends AbstractTransformer<CompressArticulationOptions> {
    name = 'CompressArticulation'

    constructor() {
        super()

        this.options = {
            volumePrecision: 3,
            relativePrecision: 2,
        }
    }

    transform(msm: MSM, mpm: MPM) {
        const parts = mpm.doc.performance.parts.keys()
        for (const part of parts) {
            const defs = mpm.getDefinitions<ArticulationDef>('articulationDef', part)
            for (const def of defs) {
                fix(def, 'relativeVelocity', this.options.volumePrecision)
                fix(def, 'relativeDuration', this.options.relativePrecision)
            }
        }

        return super.transform(msm, mpm)
    }
}
