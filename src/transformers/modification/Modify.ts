import { MPM } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, ScopedTransformationOptions } from "../Transformer"

export type ModifyOptions = ScopedTransformationOptions
    & ({ noteIDs: string[] } | { from: number, to: number })
    & {
        aspect: 'velocity' | 'onset' | 'duration' | 'pedal'
        change: number
    }


export class Modify extends AbstractTransformer<ModifyOptions> {
    name = 'Modify'
    requires = []

    constructor(options?: ModifyOptions) {
        super()

        // set the default options
        this.options = options || {
            scope: 'global',
            aspect: 'velocity',
            change: 0,
            from: 0,
            to: 0
        }
    }

    protected transform(msm: MSM, mpm: MPM) {
        const { aspect, change } = this.options

        const notes = ('noteIDs' in this.options)
            ? this.options.noteIDs.map(id => msm.getByID(id))
            : msm.notesInRange(this.options.from, this.options.to, this.options.scope)

        for (const note of notes) {
            if (!note) continue

            switch (aspect) {
                case 'velocity':
                    note['midi.velocity'] = Math.max(0, note['midi.velocity'] + change)
                    break
                case 'onset':
                    note['midi.onset'] += change
                    break
                case 'duration':
                    note['midi.duration'] += change
                    break
                default:
                    console.warn(`Unknown aspect: ${aspect}`)
            }
        }
    }
}
