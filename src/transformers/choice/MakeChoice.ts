import { MPM } from "../../mpm"
import { MSM, MsmNote } from "../../msm"
import { AbstractTransformer, ScopedTransformationOptions } from "../Transformer"

export interface RangeChoice {
    from: number
    to: number
}

export interface NoteChoice {
    noteIDs: string[]
}

export type AnyChoice = RangeChoice | NoteChoice

export type Preference = {
    prefer: string
} | {
    velocity: string
    timing: string
    pedalling: string
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
            // select all ntoes within the range
            affected = msm.allNotes.filter(note => {
                if (!note.source) return false;

                const { from, to } = this.options as RangeChoice
                return note.date >= from && note.date <= to
            })
        }

        // (2) note mode
        else if ('noteIDs' in this.options) {
            affected = msm.allNotes.filter(note => {
                if (!note.source) return false;
                const { noteIDs } = this.options as NoteChoice
                return noteIDs.includes(note['xml:id'])
            })
        }

        // (3) default choice mode
        else {
            affected = msm.allNotes
        }

        const velocityPreference = 'prefer' in this.options ? this.options.prefer : this.options.velocity;
        const timingPreference = 'prefer' in this.options ? this.options.prefer : this.options.timing;
        const pedallingPreference = 'prefer' in this.options ? this.options.prefer : this.options.pedalling;

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
            for (const note of notes) {
                msm.allNotes.splice(msm.allNotes.indexOf(note), 1);
            }
            msm.allNotes.push({ ...prototype });
        }

        if (pedallingPreference) {
            if ('from' in this.options && 'to' in this.options) {
                const { from, to } = this.options as RangeChoice

                // The range is not applied to pedals, and never has been. This compared
                // `pedal.date` against it, but nothing has ever written a symbolic date onto a
                // pedal — the field was declared optional and left unset by every producer — so
                // the comparison was `undefined < number`, false, and every pedal fell through
                // to the source test regardless of the range. Saying that plainly is the same
                // behaviour without the appearance of a bound being honoured. Giving pedals a
                // symbolic position is a change of its own; they carry `midi.onset` only.
                void from; void to;

                for (const pedal of msm.pedals) {
                    if (pedal.source !== pedallingPreference) {
                        msm.pedals.splice(msm.pedals.indexOf(pedal), 1)
                    }
                }
            }
            else {
                msm.pedals = msm.pedals.filter(pedal => pedal.source === pedallingPreference)
            }
        }
    }
}
