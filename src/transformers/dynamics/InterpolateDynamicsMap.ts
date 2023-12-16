import { BeatLengthBasis } from "../BeatLengthBasis"
import { Dynamics, MPM, Part } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
import { v4 } from "uuid"

export interface InterpolateDynamicsMapOptions extends TransformationOptions {
    /**
     * Defines if the dynamics will be interpolated globally as opposed
     * to referring to parts. Default is 'global'.
     */
    part: Part

    /**
     * Defines the beat length, on which the calculation of tempo is done.
     * Should be given in time stamps (e.g. 720 ...)
     */
    beatLengthBasis: BeatLengthBasis
}

export class InterpolateDynamicsMap extends AbstractTransformer<InterpolateDynamicsMapOptions> {
    constructor(options?: InterpolateDynamicsMapOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            part: 'global',
            beatLengthBasis: 'everything'
        })
    }

    public name() { return 'InterpolateDynamicsMap' }

    public transform(msm: MSM, mpm: MPM): string {
        type TimedVelocity = {
            date: number,
            volume?: number
        }

        const affectedNotes =
            this.options?.part === 'global' ?
                msm.allNotes :
                msm.allNotes.filter(n => n.part - 1 === this.options?.part)

        let performedVelocities: TimedVelocity[] = []
        if (this.options?.beatLengthBasis === 'everything') {
            performedVelocities =
                affectedNotes.map(n => {
                    return {
                        date: n.date,
                        volume: n['midi.velocity']
                    }
                })
        }
        else {
            console.warn('beat length basis other then "everything" not yet implemented')
            return super.transform(msm, mpm)
        }

        if (!performedVelocities.length) return 'no performed velocities found'

        // find trends
        const dynamics = performedVelocities.reduce((acc, curr) => {
            if (!curr.volume) return acc

            // avoid doublettes: if the volumes are exactly 
            // identical, we do not need to do anything.
            if (acc[acc.length - 1] && curr.volume === acc[acc.length - 1].volume) return acc

            // multiple dynamics inside a chord ...
            if (acc[acc.length - 1] && curr.date === acc[acc.length - 1].date) {
                // ... should have been encoded by the InterpolatePhysicalOrnamentation transformer,
                // therefore they will be ignored here. They might be interpolated as ornamentation
                // containing only a <dynamicsGradient> – or they will be left for articulation
                // interpolation.
                return acc
            }

            // Find trends. Three data points are needed: first (-2), second (-1), current (0).
            // If possible, delete the middle element (second).
            const first = acc[acc.length - 2]
            const second = acc[acc.length - 1]
            if (first && second) {
                if ((first.volume < second.volume && +second.volume < curr.volume) || // crescendo trend
                    (first.volume > second.volume && +second.volume > curr.volume)) { // or decrescendo trend
                    // remove middle element (last in acc array)
                    // and add @transition.to and @protraction
                    // to the preceding instruction.
                    // TODO interpolate @curvature

                    const averageVolume = (+first.volume + curr.volume) / 2
                    const distance = +second.volume - averageVolume
                    const maxDistance = averageVolume - curr.volume
                    const protraction = distance / maxDistance

                    if (first.protraction)
                        first.protraction = +((first.protraction + (+protraction)) / 2).toFixed(2)
                    else
                        first.protraction = +protraction.toFixed(2)

                    first['transition.to'] = curr.volume
                    acc.pop()
                }
            }

            acc.push({
                type: 'dynamics',
                date: curr.date,
                volume: curr.volume,
                'xml:id': 'dynamics_' + v4()
            })
            return acc
        }, new Array<Dynamics>())

        mpm.insertInstructions(dynamics, this.options?.part)

        // TODO: before handing over to the next transformer, 
        // the synthesized dynamics should be substracted from
        // the original dynamics, so that following transformers
        // can deal with the difference between *should* and *is*.
        return super.transform(msm, mpm)
    }
}
