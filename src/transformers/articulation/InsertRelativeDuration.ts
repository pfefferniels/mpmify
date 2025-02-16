import { Articulation, MPM } from "mpm-ts"
import { MSM, MsmNote } from "../../msm"
import { AbstractTransformer, ScopedTransformationOptions } from "../Transformer"
import { v4 } from "uuid"
import { DefinedProperty } from "../../utils/utils"

export interface InsertRelativeDurationOptions extends ScopedTransformationOptions {
    /**
     * Usually this transformation is applied only to a few selected notes.
     * When this parameter is not defined, all notes will be considered.
     */
    noteIDs?: string[]
}

type ArticulatedNote = DefinedProperty<MsmNote, 'tickDuration'>

/**
 * Defines the articulation of a note through the attributes relativeDuration and
 * relativeVelocity. This transformer can be applied to either all notes,
 * a selection of notes or a specific part.
 * 
 * @note This transformation can only be applied after both dynamics and tempo transformation.
 */
export class InsertRelativeDuration extends AbstractTransformer<InsertRelativeDurationOptions> {
    name = 'InsertRelativeDuration'

    constructor(options?: InsertRelativeDurationOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            scope: 'global'
        })
    }

    private noteToArticulation(note: ArticulatedNote, adjust: boolean = true): Articulation {
        const relativeDuration = note.tickDuration ? (note.tickDuration / note.duration) : undefined

        if (adjust) {
            note.tickDuration = note.duration
        }

        return {
            type: 'articulation',
            'xml:id': `articulation_${v4()}`,
            date: note.date,
            noteid: '#' + note['xml:id'],
            relativeDuration
        }
    }

    public transform(msm: MSM, mpm: MPM): string {
        const articulations: Articulation[] = []

        if (this.options.noteIDs) {
            for (const id of this.options.noteIDs) {
                const note = msm.getByID(id)
                if (!note) continue
                articulations.push(this.noteToArticulation(note as ArticulatedNote))
            }
        }
        else {
            const chords = msm.asChords(this.options?.scope)

            for (const [, chord] of chords) {
                const chordArticulations: Articulation[] = []
                for (const note of chord) {
                    if (!note) continue
                    chordArticulations.push(this.noteToArticulation(note as ArticulatedNote))
                }

                // if the articulated chord is actually a single 
                // note, there is no need to define a particular 
                // noteid attribute.
                if (chordArticulations.length === 1 && chord.length === 1) {
                    delete chordArticulations[0].noteid
                }

                articulations.push(...chordArticulations)
            }
        }

        mpm.insertInstructions(articulations, this.options.scope, true)

        // hand it over to the next transformer
        return super.transform(msm, mpm)
    }
}
