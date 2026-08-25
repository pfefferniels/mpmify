import { Articulation, ArticulationDef, DEFAULT_STYLE_NAME, MPM } from "../../mpm"
import { MSM, MsmNote } from "../../msm"
import { AbstractTransformer, generateId, ScopedTransformationOptions } from "../Transformer"
import { v4 } from "uuid"
import { TranslatePhysicalTimeToTicks } from "../tempo"
import { deriveResidual, NoteResidual } from "../../residual"

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

/**
 * Defines the articulation of a note through the attributes relativeDuration and
 * relativeVelocity. This transformer can be applied to either all notes,
 * a selection of notes or a specific part.
 * 
 * @note This transformation can only be applied after both dynamics and tempo transformation.
 */
export class InsertArticulation extends AbstractTransformer<InsertArticulationOptions> {
    name = 'InsertArticulation'
    requires = [TranslatePhysicalTimeToTicks]

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

    /**
     * The articulation one note calls for, measured against what the rest of the MPM already
     * renders it as.
     *
     * The divisor for `relativeVelocity` is the velocity the MPM prescribes at this date — the
     * renderer computes `velocity = dynamics x relativeVelocity`, so the ratio has to be taken
     * against the dynamics side of that product (issue #23). That used to be reached by taking
     * the accumulated residual back off the recording,
     * `midi.velocity - absoluteVelocityChange`; it is now read directly off a residual derived
     * with articulation held out, which is the same quantity without the intervening algebra.
     */
    private noteToArticulation(
        aspects: Set<ArticulationProperty>,
        note: MsmNote,
        residual: NoteResidual | undefined
    ): Articulation {
        const tickDuration = residual?.tickDuration
        const relativeDuration = tickDuration ? (tickDuration / note.duration) : undefined

        // A prescribed volume of zero (or below) cannot be scaled into the performed one by any
        // multiplier, so there is no ratio to write. Leaving the attribute off says that
        // honestly; a guessed value would be silently wrong.
        const prescribed = residual?.renderedVelocity
        const relativeVelocity = prescribed !== undefined && prescribed > 0
            ? note["midi.velocity"] / prescribed
            : undefined

        const absoluteDuration = tickDuration
        const absoluteDurationChange = (tickDuration as number) - note.duration

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
                // What the document now says this note's velocity is: the curve's value scaled
                // by the def. The residual left for whatever runs next is measured against that,
                // so it moves by the part of the curve the def has taken over. Zeroing it — what
                // this used to do — claimed the def explained the note exactly, which it does
                // not: the def carries the *average* ratio of its group.
                note.absoluteVelocityChange =
                    (note.absoluteVelocityChange ?? 0)
                    - (note["midi.velocity"] - (note.absoluteVelocityChange ?? 0)) * (def.relativeVelocity - 1)
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

        // What the MPM explains without any articulation is what articulation has to account
        // for. Derived here rather than read off the notes, so this no longer depends on which
        // earlier transformer subtracted what.
        const residual = deriveResidual(msm, mpm, { without: ['articulation'] })

        let articulations: Articulation[] = affectedNotes
            .map(note => this.noteToArticulation(aspects, note, residual.of(note)))

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

        // A <style> switch is what puts the styleDef holding `def` in scope; without one the
        // @name.ref below resolves to nothing and the articulation is inert. Only
        // StylizeArticulation and MakeDefaultArticulation used to emit it, so a chain that ran
        // neither produced definitions no renderer could reach. See old-bugs.md.
        if (mpm.getStyles('articulation', this.options.scope).length === 0) {
            mpm.insertStyle({
                type: 'style',
                'xml:id': v4(),
                date: 0,
                'name.ref': DEFAULT_STYLE_NAME,
            }, 'articulation', this.options.scope)
        }

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
