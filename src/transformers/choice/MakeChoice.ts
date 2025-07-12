import { MPM } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, ScopedTransformationOptions } from "../Transformer"

interface Choice {
    prefer: string 
}

export interface RangeChoice extends Choice {
    from: number 
    to: number 
}

export interface NoteChoice extends Choice {
    noteids: string[]
}

export type AnyChoice = RangeChoice | NoteChoice

export type MakeChoiceOptions = ScopedTransformationOptions
    & ((RangeChoice | NoteChoice) & { prefer: string }) // option 1: a single choice
    | { prefer: string } // option 2: a default choice

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
        const eliminate = []
        
        // (1) range mode
        if ('from' in this.options && 'to' in this.options) {
            eliminate.push(msm.allNotes.filter(note => {
                const { from, to } = this.options as RangeChoice
                return note.date >= from && note.date <= to &&
                    note.source !== this.options.prefer
            }))
        }

        // (2) note mode
        else if ('noteids' in this.options) {
            eliminate.push(msm.allNotes.filter(note => {
                const { noteids } = this.options as NoteChoice
                return noteids.includes(note['xml:id']) && note.source !== this.options.prefer
            }))
        }

        // (3) default choice mode
        else {
            eliminate.push(msm.allNotes.filter(note => note.source !== this.options.prefer));
        }

        for (const note of eliminate) {
            msm.allNotes.splice(msm.allNotes.indexOf(note), 1);
        }
    }
}
