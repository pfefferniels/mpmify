import { ArticulationDef, MPM } from "mpm-ts";
import { MSM } from "../../msm";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { fix } from "../../utils/utils";
import { StylizeArticulation } from "./StylizeArticulation";

interface CompressArticulationOptions extends TransformationOptions {
    volumePrecision: number 
    relativePrecision: number
}

export class CompressArticulation extends AbstractTransformer<CompressArticulationOptions> {
    name = 'CompressArticulation'
    requires = [StylizeArticulation]

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
    }
}
