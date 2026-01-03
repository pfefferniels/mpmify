import { MPM } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
import { TranslatePhyiscalTimeToTicks } from "../tempo"

export type InsertPedalOptions =
    TransformationOptions
    & {
        pedal?: string, // identify a pedal by its xml:id. If not given, all pedals are considered
        start: number // relative to the original time, in ticks
        duration: number // in ticks
        direction: 'up' | 'down',
        depth?: number // [0..1], default 1
    }

/**
 * This transformer is a shortcut. The developed "path" for encoding pedal changes
 * would be to first insert accurate movements into the MSM (if necessary), and then
 * to approximate the shape using a transformer similiar to `InsertDynamics`. However,
 * this shortcut is useful for all cases in which the original source material
 * cannot represent accurate pedal movements (such as reproducing piano rolls)
 * and where these abrupt pedal changes are to be interpreted.
 */
export class InsertPedal extends AbstractTransformer<InsertPedalOptions> {
    name = 'InsertPedal'
    requires = [TranslatePhyiscalTimeToTicks]

    constructor(options?: InsertPedalOptions) {
        super()
        this.options = options
    }

    protected transform(msm: MSM, mpm: MPM) {
        const validPedals = msm.pedals
            .filter(pedal => {
                const tickDate = pedal.tickDate
                const tickDuration = pedal.tickDuration

                if (tickDate === undefined || tickDuration === undefined) {
                    return false
                }

                if (this.options.pedal) {
                    return pedal["xml:id"] === this.options.pedal
                }

                return true
            })
        const depth = this.options.depth || 1

        for (const pedal of validPedals) {
            const tickDate = pedal.tickDate
            const tickDuration = pedal.tickDuration

            if (this.options.direction === 'down') {
                mpm.insertInstruction({
                    'xml:id': `${pedal['xml:id']}_start`,
                    type: 'movement',
                    date: tickDate + this.options.start,
                    position: 0,
                    "transition.to": depth,
                    controller: pedal.type
                }, 'global')

                mpm.insertInstruction({
                    'xml:id': `${pedal['xml:id']}_moveDown`,
                    type: 'movement',
                    date: tickDate + this.options.start + this.options.duration,
                    position: depth,
                    controller: pedal.type
                }, 'global')
            }
            else {
                const endDate = tickDate + tickDuration

                mpm.insertInstruction({
                    'xml:id': `${pedal['xml:id']}_moveUp`,
                    type: 'movement',
                    date: endDate + this.options.start,
                    position: depth,
                    "transition.to": 0,
                    controller: pedal.type
                }, 'global')

                mpm.insertInstruction({
                    'xml:id': `${pedal['xml:id']}_end`,
                    type: 'movement',
                    date: endDate + this.options.start + this.options.duration,
                    position: 0,
                    controller: pedal.type
                }, 'global')
            }
        }
    }
}
