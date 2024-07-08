import { MPM } from "mpm-ts";
import { MSM } from "../../msm";
import { AbstractTransformer, TransformationOptions } from "../Transformer";

interface StylizeArticulationOptions extends TransformationOptions {
    /**
     * Tolerance to be applied when inside a chord the durations have slightly different lengths.
     */
    relativeDurationTolerance: number

    /**
     * Precision of the relative duration. Given as number of digits after decimal point.
     */
    relativeDurationPrecision: number
}

export class StylizeArticulation extends AbstractTransformer<StylizeArticulationOptions> {
    name(): string {
        return 'StylizeArticulation'
    }

    transform(msm: MSM, mpm: MPM) {
        // TODO
        
        // const inToleranceRange = (x: number, target: number): boolean => x >= (target - relativeDurationTolerance) && x <= (target + relativeDurationTolerance)

        // if it takes the full length, we don't need to insert any instruction
        // if (relativeDuration === 1.0) continue

        // is it possible to just attach this note to an existing
        // articulation instruction at the same date?
        // const lastArticulation = chordArticulations.at(-1)
        // if (lastArticulation && inToleranceRange(relativeDuration, lastArticulation.relativeDuration)) {
        //     lastArticulation.noteid += ` #${note['xml:id']}`
        //     continue
        // }

        return super.transform(msm, mpm)
    }
}
