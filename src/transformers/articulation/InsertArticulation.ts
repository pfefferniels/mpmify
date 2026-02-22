import { Articulation, ArticulationDef, MPM } from "mpm-ts"
import { MSM, MsmNote } from "../../msm"
import { AbstractTransformer, generateId, ScopedTransformationOptions } from "../Transformer"
import { v4 } from "uuid"
import { DefinedProperty } from "../../utils/utils"
import { TranslatePhyiscalTimeToTicks } from "../tempo"

export type ArticulationProperty =
    | 'relativeDuration'
    | 'relativeVelocity'
    | 'absoluteDuration'
    | 'absoluteDurationChange'

export type ArticulationUnit = {
    noteIDs: string[]
    name: string
    aspects: Set<ArticulationProperty>
}

export type InsertArticulationOptions = ScopedTransformationOptions & ArticulationUnit

type ArticulatedNote = DefinedProperty<MsmNote, 'tickDuration'>

/**
 * Defines the articulation of a note through the attributes relativeDuration and
 * relativeVelocity. This transformer can be applied to either all notes,
 * a selection of notes or a specific part.
 * 
 * @note This transformation can only be applied after both dynamics and tempo transformation.
 */
export class InsertArticulation extends AbstractTransformer<InsertArticulationOptions> {
    name = 'InsertArticulation'
    requires = [TranslatePhyiscalTimeToTicks]

    constructor(options?: InsertArticulationOptions) {
        super()

        // set the default options
        this.options = options || {
            noteIDs: [],
            aspects: new Set(),
            name: v4(),
            scope: 'global'
        }
    }

    private noteToArticulation(aspects: Set<ArticulationProperty>, note: ArticulatedNote): Articulation {
        const relativeDuration = note.tickDuration ? (note.tickDuration / note.duration) : undefined
        const relativeVelocity = ((note.absoluteVelocityChange ?? 0) + note["midi.velocity"]) / note["midi.velocity"]
        const absoluteDuration = note.tickDuration
        const absoluteDurationChange = note.tickDuration - note.duration

        return {
            type: 'articulation',
            'xml:id': `articulation_${v4()}`,
            date: note.date,
            noteid: '#' + note['xml:id'],
            relativeDuration: aspects.has('relativeDuration') ? relativeDuration : undefined,
            relativeVelocity: aspects.has('relativeVelocity') ? relativeVelocity : undefined,
            absoluteDuration: aspects.has('absoluteDuration') ? absoluteDuration : undefined,
            absoluteDurationChange: aspects.has('absoluteDurationChange') ? absoluteDurationChange : undefined
        }
    }

    private undoEffectOf(def: ArticulationDef, onNotes: MsmNote[]) {
        for (const note of onNotes) {
            if (def.relativeDuration !== undefined) {
                note.tickDuration /= def.relativeDuration
            }
            if (def.relativeVelocity !== undefined) {
                // TODO
                note.absoluteVelocityChange = 0
            }
            if (def.absoluteDuration !== undefined) {
                note.tickDuration = note.duration
            }
            if (def.absoluteDurationChange !== undefined) {
                note.tickDuration -= def.absoluteDurationChange
            }
        }
    }

    protected transform(msm: MSM, mpm: MPM) {
        const { noteIDs, aspects, name } = this.options
        const affectedNotes = noteIDs
            .map(id => msm.getByID(id))
            .filter(n => !!n) as MsmNote[]

        let articulations: Articulation[] = affectedNotes
            .map(note => this.noteToArticulation(aspects, note as ArticulatedNote))

        const avgs: Record<string, number> = {}
        Array
            .from(aspects)
            .map(aspect => {
                return [
                    aspect,
                    articulations
                        .map(a => a[aspect])
                        .filter(a => a !== undefined)
                ] as [ArticulationProperty, number[]]
            })
            .forEach(([aspect, values]) => {
                if (values.length === 0) return
                avgs[aspect] = values.reduce((acc, v) => acc + v, 0) / values.length
            })

        const def: ArticulationDef = {
            type: 'articulationDef',
            name,
            ...avgs
        }

        mpm.insertDefinition(def, this.options.scope)
        this.undoEffectOf(def, affectedNotes)

        articulations = articulations.reduce((acc, curr) => {
            aspects.forEach(aspect => curr[aspect] = undefined)

            const existing = acc.find(a => a.date === curr.date && a['name.ref'] === name)
            if (existing) {
                existing.noteid += ' ' + curr.noteid
                return acc
            }

            curr['name.ref'] = name
            return [...acc, curr]
        }, [] as Articulation[])

        articulations.forEach(a => a['xml:id'] = generateId('articulation', a.date, mpm))

        mpm.insertInstructions(articulations, this.options.scope)
    }
}
