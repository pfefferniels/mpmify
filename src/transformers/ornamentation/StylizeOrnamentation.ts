import { MPM, Ornament, Part } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"

export interface ExtractStyleDefinitionsOptions extends TransformationOptions {
    /**
     * given in ticks
     */
    tolerance: number
}

/**
 * This transformer tries to combine multiple instructions
 * into fewer archetype definitions, taking a given tolerance into account.
 * Style definitions will always be written into the global environment.
 */
export class ExtractStyleDefinitions extends AbstractTransformer<ExtractStyleDefinitionsOptions> {
    constructor() {
        super()

        this.options = {
            tolerance: 10
        }
    }

    public name() { return 'ExtractStyleDefinitions' }

    public transform(msm: MSM, mpm: MPM): string {
        ([0, 1, 'global'] as Part[]).forEach((part => {
            mpm.getInstructions<Ornament>('ornament', part as Part).forEach(ornament => {
                if (ornament['frame.start'] !== undefined && ornament['frameLength'] !== undefined) {
                    // TODO: find a possibly existing definition which is in the
                    // range of tolerance. If found, merge.
                    let transition: [number | undefined, number | undefined] = [undefined, undefined]
                    if (ornament.gradient === 'crescendo') {
                        transition = [-1, 0]
                    }
                    else if (ornament.gradient === 'decrescendo') {
                        transition = [0, -1]
                    }

                    const definitionName = mpm.insertDefinition({
                        'type': 'ornament',
                        'frameLength': ornament.frameLength,
                        'frame.start': ornament['frame.start'],
                        'noteoff.shift': ornament['noteoff.shift'] || true,
                        'time.unit': ornament['time.unit'],
                        'transition.from': transition[0],
                        'transition.to': transition[1]

                    }, part)
                    delete ornament['noteoff.shift']
                    delete ornament['time.unit']
                    delete ornament['gradient']
                    delete ornament["frame.start"]
                    delete ornament["frameLength"]
                    ornament["name.ref"] = definitionName
                }
            })
        }))

        // hand it over to the next transformer
        return super.transform(msm, mpm)
    }
}
