import { MPM } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, ScopedTransformationOptions, TransformationOptions, Transformer } from "../Transformer"
import { TranslatePhyiscalTimeToTicks } from "../tempo"

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

export interface MakeChoiceOptions extends ScopedTransformationOptions {
    choices: AnyChoice[]
    defaultChoice?: string
}

export class MakeChoice extends AbstractTransformer<MakeChoiceOptions> {
    name = 'MakeChoice'
    requires = []

    constructor(options?: MakeChoiceOptions) {
        super()

        // set the default options
        this.options = options || {
            choices: [],
            scope: 'global'
        }
    }

    protected transform(msm: MSM, _: MPM) {
        const eliminate = []
        for (const note of msm.notesInPart(this.options.scope)) {
            // check if the note falls into one of the 
            // ranges 
            const choice: AnyChoice | undefined = this.options.choices.find(c => {
                if ('from' in c && 'to' in c) {
                    return note.date >= c.from && note.date <= c.to;
                } else if ('noteids' in c) {
                    return c.noteids.includes(note['xml:id']);
                }
                return false;
            });

            if (choice) {
                if (choice.prefer !== note.source) {
                    eliminate.push(note)
                }
            }
            else if (this.options.defaultChoice && this.options.defaultChoice !== note.source) {
                eliminate.push(note)
            }
        }

        for (const note of eliminate) {
            msm.allNotes.splice(msm.allNotes.indexOf(note), 1);
        }
    }
}
