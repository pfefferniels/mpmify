import { OrnamentDef, MPM } from "mpm-ts";
import { MSM } from "../../msm";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { fix } from "../../utils/utils";
import { StylizeOrnamentation } from "./StylizeOrnamentation";

interface CompressOrnamentationOptions extends TransformationOptions {
    tickPrecision: number
}

export class CompressOrnamentation extends AbstractTransformer<CompressOrnamentationOptions> {
    name = 'CompressOrnamentation'
    requires = [StylizeOrnamentation]

    constructor() {
        super()

        this.options = {
            tickPrecision: 0
        }
    }

    protected transform(msm: MSM, mpm: MPM) {
        const parts = mpm.doc.performance.parts.keys()
        for (const part of parts) {
            const defs = mpm.getDefinitions<OrnamentDef>('ornamentDef', part)
            for (const def of defs) {
                if (!def.temporalSpread) continue
                
                fix(def.temporalSpread, 'frame.start', this.options.tickPrecision)
                fix(def.temporalSpread, 'frameLength', this.options.tickPrecision)
            }
        }
    }
}
