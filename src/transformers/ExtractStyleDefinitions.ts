import { MPM, Ornament, Part } from "../mpm"
import { MSM } from "../msm"
import { AbstractTransformer, TransformationOptions } from "./Transformer"

export interface ExtractStyleDefinitionsOptions extends TransformationOptions {
    /**
     * Tolerance applied to the temporal domain such as tempo, rubato, asynchrony
     * and ornamentation. Given in BPM.
     */
    temporalTolerance: number

    /**
     * Tolerance applied to volume values such as dynamics, metrical accentuation
     */
    volumeTolerance: number

    /**
     * standard dynamic definitions e.g. for p, mf, f and loud
     * in the case of Welte
     */
    standardDynamics: { name: string, value: number }[]
}

/**
 * This transformer tries to combine multiple instructions
 * into fewer definitions, taking a given tolerance into account.
 * Style definitions will always be written into the global environment.
 */
export class ExtractStyleDefinitions extends AbstractTransformer<ExtractStyleDefinitionsOptions> {
    constructor() {
        super()

        this.options = {
            // consider 1 bpm to be indistinguishable
            temporalTolerance: 1,
            volumeTolerance: 0.5,

            // These are the values used by SUPRA's midi2exp. 
            // Ideally, they should be extracted from the given 
            // MIDI file's metadata.
            standardDynamics: [
                { name: 'p', value: 38 },
                { name: 'mf', value: 60 },
                { name: 'f', value: 85 },
                { name: 'loud', value: 70 }
            ]
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
                        transition = [-1, 1]
                    }
                    else if (ornament.gradient === 'decrescendo') {
                        transition = [1, -1]
                    }

                    const definitionName = mpm.insertDefinition({
                        'type': 'ornament',
                        'frameLength': ornament.frameLength,
                        'frame.start': ornament['frame.start'],
                        'noteoff.shift': ornament['noteoff.shift'],
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
