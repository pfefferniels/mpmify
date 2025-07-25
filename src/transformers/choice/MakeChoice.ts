import { MPM } from "mpm-ts"
import { MSM, MsmNote } from "../../msm"
import { AbstractTransformer, ScopedTransformationOptions } from "../Transformer"

export interface RangeChoice {
    from: number
    to: number
}

export interface NoteChoice {
    noteids: string[]
}

export type AnyChoice = RangeChoice | NoteChoice

export type Preference = {
    prefer: string
} | {
    velocity: string
    timing: string
}

export type MakeChoiceOptions = ScopedTransformationOptions
    & ((RangeChoice | NoteChoice) & Preference) // single choice
    | Preference // default choice

export class MakeChoice extends AbstractTransformer<MakeChoiceOptions> {
    name = 'MakeChoice'
    requires = []

    constructor(options?: MakeChoiceOptions) {
        super()

        // set the default options
        this.options = options || {
            prefer: '',
            scope: 'global'
        }
    }

    protected transform(msm: MSM, _: MPM) {
        let affected: MsmNote[] = []

        // (1) range mode
        if ('from' in this.options && 'to' in this.options) {
            // within the range, eliminate everything which is
            // in the preferred source
            affected = msm.allNotes.filter(note => {
                if (!note.source) return false;

                const { from, to } = this.options as RangeChoice
                return note.date >= from && note.date <= to
            })
        }

        // (2) note mode
        else if ('noteids' in this.options) {
            affected = msm.allNotes.filter(note => {
                if (!note.source) return false;
                const { noteids } = this.options as NoteChoice
                return noteids.includes(note['xml:id'])
            })
        }

        // (3) default choice mode
        else {
            affected = msm.allNotes
        }

        const velocityPreference = 'prefer' in this.options ? this.options.prefer : this.options.velocity;
        const timingPreference = 'prefer' in this.options ? this.options.prefer : this.options.timing;

        const equivalents = Map.groupBy(affected, note => `${note.date}-${note.duration}-${note["midi.pitch"]}`)
        for (const [_, notes] of equivalents) {
            const prototype = notes.find(note => note.source === timingPreference)
            if (!prototype) continue;

            if (velocityPreference !== timingPreference) {
                const velocitySource = notes.find(note => note.source === velocityPreference);
                if (velocitySource) {
                    prototype['midi.velocity'] = velocitySource['midi.velocity']
                }
            }

            // keep only the prototype note and remove all source variants
            console.log('Removing variants', notes, 'keeping', prototype);
            for (const note of notes) {
                msm.allNotes.splice(msm.allNotes.indexOf(note), 1);
            }
            msm.allNotes.push({ ...prototype });
        }
    }
}
