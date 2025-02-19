import { Tempo, MPM } from "mpm-ts";
import { MSM } from "../../msm";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { fix } from "../../utils/utils";
import { InsertTempoInstructions } from "./InsertTempoInstructions";

interface CompressTempoOptions extends TransformationOptions {
    bpmPrecision: number
    meanTempoAtPrecision: number
}

export class CompressTempo extends AbstractTransformer<CompressTempoOptions> {
    name = 'CompressTempo'
    requires = [InsertTempoInstructions]

    constructor() {
        super()

        this.options = {
            bpmPrecision: 2,
            meanTempoAtPrecision: 2
        }
    }

    protected transform(msm: MSM, mpm: MPM) {
        const parts = mpm.doc.performance.parts.keys()
        for (const part of parts) {
            const tempos = mpm.getInstructions<Tempo>('tempo', part)
            for (const tempo of tempos) {
                fix(tempo, 'bpm', this.options.bpmPrecision)
                fix(tempo, 'transition.to', this.options.bpmPrecision)
                fix(tempo, 'meanTempoAt', this.options.meanTempoAtPrecision)
            }
        }
    }
}
