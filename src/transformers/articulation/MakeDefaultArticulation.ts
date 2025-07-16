import { Articulation, ArticulationDef, MPM } from "mpm-ts";
import { MSM, MsmNote } from "../../msm";
import { AbstractTransformer, ScopedTransformationOptions, Transformer } from "../Transformer";
import { v4 } from "uuid";
import { TranslateToTicks } from "../tempo";

interface MakeDefaultArticulationOptions extends ScopedTransformationOptions {
}

/**
 * This transformer sets the default articulation for all notes.
 */
export class MakeDefaultArticulation extends AbstractTransformer<MakeDefaultArticulationOptions> {
    name = 'MakeDefaultArticulation'
    requires = [TranslateToTicks]

    constructor(options?: MakeDefaultArticulationOptions) {
        super()

        // set the default options
        this.options = options || {
            scope: 'global'
        }
    }

    protected transform(msm: MSM, mpm: MPM) {
        // collect notes that have no articulation
        const notes: MsmNote[] = [...msm.allNotes]
        for (const articulation of mpm.getInstructions<Articulation>('articulation', this.options.scope)) {
            if (articulation.noteid) {
                for (const noteId of articulation.noteid.split(' ')) {
                    const toDelete = notes.findIndex(n => n['xml:id'] === noteId.slice(1))
                    if (toDelete !== -1) {
                        notes.splice(toDelete, 1)
                    }
                }
            }
            else {
                const notes = msm.notesAtDate(articulation.date, this.options.scope)
                for (const note of notes) {
                    notes.splice(notes.indexOf(note), 1)
                }
            }
        }

        if (notes.length === 0) return

        const relativeDurations = notes
            .map(note => note.tickDuration / note.duration)
            .filter(n => !isNaN(n))

        const mean = relativeDurations.reduce((acc, curr) => acc + curr, 0) / relativeDurations.length

        const def: ArticulationDef = {
            name: 'default articulation',
            relativeDuration: mean,
            type: 'articulationDef',
        }
        mpm.insertDefinition(def, this.options.scope)

        for (const note of notes) {
            note.tickDuration /= def.relativeDuration
        }

        mpm.insertStyle({
            type: 'style',
            'xml:id': v4(),
            date: 0,
            'name.ref': 'performance_style',
            defaultArticulation: def.name,
        }, 'articulation', this.options.scope)
    }
}