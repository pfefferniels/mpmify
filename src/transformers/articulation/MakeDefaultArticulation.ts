import { ensureDefaultStyle, getInstructions, insertDefinition, Mpm } from "../../mpm";
import { Alignment, AlignedNote } from "../../alignment";
import { AbstractTransformer, ScopedTransformationOptions } from "../Transformer";
import { TranslatePhysicalTimeToTicks } from "../tempo";
import { deriveResidual } from "../../residual";
import { makeArticulationDef } from "./InsertArticulation";

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
        super(options || {
            scope: 'global'
        })
    }

    protected transform(msm: Alignment, mpm: Mpm) {
        // collect notes that have no articulation
        const notes: AlignedNote[] = [...msm.allNotes]
        for (const articulation of getInstructions(mpm, 'articulation', this.options.scope)) {
            if (articulation.noteid) {
                // One reference, the way the renderer reads it. This walked a space-separated
                // list for as long as `InsertArticulation` wrote one — see issue #53.
                const noteId = articulation.noteid.slice(1)
                const toDelete = notes.findIndex(n => n['xml:id'] === noteId)
                if (toDelete !== -1) {
                    notes.splice(toDelete, 1)
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

        // Every rejection here has to be explicit, because the arithmetic hides two of them.
        // `undefined / duration` is NaN, which the old `!isNaN` filter did catch — but a note of
        // zero duration (a grace note) gives Infinity, which it did not, and one such note made
        // the mean Infinity. And when the filter emptied the list, `0 / 0` made the mean NaN.
        // Either way an unusable number reached `relativeDuration` and was written out.
        const relativeDurations = notes
            .map(note => {
                const tickDuration = residual.of(note)?.tickDuration
                if (tickDuration === undefined || note.duration === 0) return undefined
                return tickDuration / note.duration
            })
            .filter((ratio): ratio is number => ratio !== undefined && Number.isFinite(ratio))

        // Nothing measurable is not the same as a default articulation of zero: say nothing.
        if (relativeDurations.length === 0) return

        const mean = relativeDurations.reduce((acc, curr) => acc + curr, 0) / relativeDurations.length

        const def = makeArticulationDef('default articulation', { relativeDuration: mean })
        insertDefinition(mpm, 'articulationDef', def, this.options.scope)

        ensureDefaultStyle(mpm, 'articulation', this.options.scope, { defaultArticulation: def.getName() })
    }
}