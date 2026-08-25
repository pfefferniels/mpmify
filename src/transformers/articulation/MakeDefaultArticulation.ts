import { Articulation, ArticulationDef, DEFAULT_STYLE_NAME, MPM } from "../../mpm";
import { MSM, MsmNote } from "../../msm";
import { AbstractTransformer, ScopedTransformationOptions } from "../Transformer";
import { v4 } from "uuid";
import { TranslatePhysicalTimeToTicks } from "../tempo";
import { deriveResidual } from "../../residual";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface MakeDefaultArticulationOptions extends ScopedTransformationOptions {
}

/**
 * This transformer sets the default articulation for all notes.
 */
export class MakeDefaultArticulation extends AbstractTransformer<MakeDefaultArticulationOptions> {
    name = 'MakeDefaultArticulation'
    requires = [TranslatePhysicalTimeToTicks]

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
                // An <articulation> without @noteid applies to every note at its date. The
                // inner array used to shadow the outer one, so this spliced from the list it
                // had just built and left the notes in `notes` — where they then counted
                // towards the default. See old-bugs.md.
                for (const note of msm.notesAtDate(articulation.date, this.options.scope)) {
                    const toDelete = notes.indexOf(note)
                    if (toDelete !== -1) {
                        notes.splice(toDelete, 1)
                    }
                }
            }
        }

        if (notes.length === 0) return

        // Held out rather than read off the score: these are the notes nothing else articulates,
        // so what articulation has to explain for them is whatever the rest of the MPM does not.
        // That includes any `defaultArticulation` a previous step left in the map — this one is
        // about to replace it, so measuring against it would be measuring against itself.
        const residual = deriveResidual(msm, mpm, { without: ['articulation'] })

        const relativeDurations = notes
            .map(note => residual.of(note)?.tickDuration / note.duration)
            .filter(n => !isNaN(n))

        const mean = relativeDurations.reduce((acc, curr) => acc + curr, 0) / relativeDurations.length

        const def: ArticulationDef = {
            name: 'default articulation',
            relativeDuration: mean,
            type: 'articulationDef',
        }
        mpm.insertDefinition(def, this.options.scope)

        mpm.insertStyle({
            type: 'style',
            'xml:id': v4(),
            date: 0,
            'name.ref': DEFAULT_STYLE_NAME,
            defaultArticulation: def.name,
        }, 'articulation', this.options.scope)
    }
}