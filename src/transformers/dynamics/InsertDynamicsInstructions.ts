import { BeatLengthBasis, splitByBeatLength } from "../BeatLengthBasis"
import { Dynamics, MPM, Part } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
import { v4 } from "uuid"

export interface InsertDynamicsInstructionsOptions extends TransformationOptions {
    /**
     * Defines if the dynamics will be interpolated globally as opposed
     * to referring to parts. Default is 'global'.
     */
    part: Part

    /**
     * Defines the beat length, on which the calculation of dynamics
     * is done.
     */
    beatLength: BeatLengthBasis
}

export class InsertDynamicsInstructions extends AbstractTransformer<InsertDynamicsInstructionsOptions> {
    constructor(options?: InsertDynamicsInstructionsOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            part: 'global',
            beatLength: 'everything'
        })
    }

    public name() { return 'InsertDynamicsInstructions' }

    public transform(msm: MSM, mpm: MPM): string {
        const dynamics = Object
            .entries(msm.asChords(this.options.part))
            .reduce(splitByBeatLength(this.options.beatLength, msm.timeSignature), [])
            .map((chunk) => {
                let volume = 0
                for (const [_, chord] of chunk) {
                    volume += chord.reduce((prev, curr) =>
                        prev + (curr['midi.velocity'] || 0), 0) / chord.length
                }
                volume /= chunk.length

                return {
                    'xml:id': `dynamics_${v4()}`,
                    type: 'dynamics',
                    date: +chunk[0][0],
                    volume
                } as Dynamics
            })

        mpm.insertInstructions(dynamics, this.options?.part)

        return super.transform(msm, mpm)
    }
}
