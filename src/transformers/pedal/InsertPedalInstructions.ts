import { MPM } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions, Transformer } from "../Transformer"
import { TranslatePhyiscalTimeToTicks } from "../tempo"

export interface InsertPedalOptions extends TransformationOptions {
    changeDuration: number
}

export class InsertPedal extends AbstractTransformer<InsertPedalOptions> {
    name = 'InsertPedal'
    requires = [TranslatePhyiscalTimeToTicks]

    constructor(options?: InsertPedalOptions) {
        super()

        // set the default options
        this.options = options || {
            changeDuration: 0
        }
    }

    public transform(msm: MSM, mpm: MPM) {
        const validPedals = msm.pedals.filter(pedal => pedal.tickDate !== undefined && pedal.tickDuration !== undefined)

        mpm.removeInstructions('movement', 'global')

        for (const pedal of validPedals) {
            const tickDate = pedal.tickDate
            const tickDuration = pedal.tickDuration

            mpm.insertInstruction({
                'xml:id': `${pedal['xml:id']}_start`,
                type: 'movement',
                date: tickDate - this.options.changeDuration / 2, 
                position: 0,
                "transition.to": 1,
                controller: pedal.type
            }, 'global')

            mpm.insertInstruction({
                'xml:id': `${pedal['xml:id']}_moveDown`,
                type: 'movement',
                date: tickDate + this.options.changeDuration / 2,
                position: 1,
                controller: pedal.type
            }, 'global')

            mpm.insertInstruction({
                'xml:id': `${pedal['xml:id']}_moveUp`,
                type: 'movement',
                date: tickDate + tickDuration - this.options.changeDuration / 2,
                position: 1,
                "transition.to": 0,
                controller: pedal.type
            }, 'global')

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
