import { Mpm } from "../../mpm"
import { Alignment } from "../../alignment"
import { AbstractTransformer, ScopedTransformationOptions } from "../Transformer"

export type ModifyOptions = ScopedTransformationOptions
    & ({ noteIDs: string[] } | { from: number, to: number })
    & {
        aspect: 'velocity' | 'onset' | 'duration' | 'pedal'
        /** how much to add, in the aspect's own unit: velocity steps for `velocity`, milliseconds for `onset` and `duration`. */
        change: number
    }


export class Modify extends AbstractTransformer<ModifyOptions> {
    name = 'Modify'
    requires = []

    constructor(options?: ModifyOptions) {
        super(options || {
            scope: 'global',
            aspect: 'velocity',
            change: 0,
            from: 0,
            to: 0
        })
    }

    protected transform(msm: Alignment, _mpm: Mpm) {
        const { aspect, change } = this.options

        const notes = ('noteIDs' in this.options)
            ? this.options.noteIDs.map(id => msm.getByID(id))
            : msm.notesInRange(this.options.from, this.options.to, this.options.scope)

        for (const note of notes) {
            if (!note) continue

            switch (aspect) {
                case 'velocity':
                    note.velocity = Math.max(0, note.velocity + change)
                    break
                case 'onset':
                    // Moving a note moves its release with it. The end is absolute, so shifting
                    // only the start would shorten or lengthen the note instead of displacing it.
                    note['milliseconds.date'] += change
                    note['milliseconds.date.end'] += change
                    break
                case 'duration':
                    note['milliseconds.date.end'] += change
                    break
                default:
                    console.warn(`Unknown aspect: ${aspect}`)
            }
        }
    }
}
