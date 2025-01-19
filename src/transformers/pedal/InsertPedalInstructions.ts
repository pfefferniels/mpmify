import { MPM } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"

export interface InsertPedalOptions extends TransformationOptions {
    changeDuration: number
}

export class InsertPedal extends AbstractTransformer<InsertPedalOptions> {
    constructor(options?: InsertPedalOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            changeDuration: 0
        })
    }

    public name() { return 'InsertPedal' }

    public transform(msm: MSM, mpm: MPM): string {
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

        // hand it over to the next transformer
        return super.transform(msm, mpm)
    }
}
