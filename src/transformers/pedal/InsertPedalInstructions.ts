import { MPM } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
import { TranslatePhyiscalTimeToTicks } from "../tempo"

export type InsertPedalOptions =
    TransformationOptions
    & {
        pedal?: string, // identify a pedal by its xml:id. If not given, all pedals are considered
        changeDuration: number // the duration of the pedal change, default 0 (immediately)
        depth?: number // [0..1], default 1
    }

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

            if (this.options.changeDuration) {
                mpm.insertInstruction({
                    'xml:id': `${pedal['xml:id']}_start`,
                    type: 'movement',
                    date: tickDate - this.options.changeDuration / 2,
                    position: 0,
                    "transition.to": depth,
                    controller: pedal.type
                }, 'global')
            }

            mpm.insertInstruction({
                'xml:id': `${pedal['xml:id']}_moveDown`,
                type: 'movement',
                date: tickDate + this.options.changeDuration / 2,
                position: depth,
                controller: pedal.type
            }, 'global')

            if (this.options.changeDuration) {
                mpm.insertInstruction({
                    'xml:id': `${pedal['xml:id']}_moveUp`,
                    type: 'movement',
                    date: tickDate + tickDuration - this.options.changeDuration / 2,
                    position: depth,
                    "transition.to": 0,
                    controller: pedal.type
                }, 'global')
            }

            mpm.insertInstruction({
                'xml:id': `${pedal['xml:id']}_end`,
                type: 'movement',
                date: tickDate + tickDuration + this.options.changeDuration / 2,
                position: 0,
                controller: pedal.type
            }, 'global')
        }
    }
}
