import { Articulation, ArticulationDef, DEFAULT_STYLE_NAME, MPM } from "../../mpm";
import { MSM, MsmNote } from "../../msm";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { v4 } from "uuid";
import { dbscan } from "../../utils/dbscan";
import { InsertArticulation } from "./InsertArticulation";
import { deriveResidual, Residual } from "../../residual";

interface StylizeArticulationOptions extends TransformationOptions {
    volumeTolerance: number
    relativeDurationTolerance: number
}

export class StylizeArticulation extends AbstractTransformer<StylizeArticulationOptions> {
    name = 'StylizeArticulation'
    requires = [InsertArticulation]

    constructor(options?: StylizeArticulationOptions) {
        super()

        this.options = {
            volumeTolerance: options?.volumeTolerance || 0.01,
            relativeDurationTolerance: options?.relativeDurationTolerance || 0.2,
        }
    }

    private findConflicts(withinNotes: MsmNote[], clusteredArticulations: Articulation[], residual: Residual) {
        const meanRelativeDuration = clusteredArticulations.reduce((acc, a) => acc + a.relativeDuration, 0) / clusteredArticulations.length

        const conflictList: Set<Articulation> = new Set()

        for (const articulation of clusteredArticulations) {
            const date = articulation.date
            let targetNotes = withinNotes.filter(n => n.date === date)
            if (articulation.noteid) {
                // `@noteid` is a space-separated list of references — `InsertArticulation`
                // folds a chord's notes into one instruction. Matching the whole attribute
                // against a single id found nothing as soon as there were two. See old-bugs.md.
                const ids = articulation.noteid.split(' ').map(ref => ref.replace(/^#/, ''))
                targetNotes = targetNotes.filter(n => ids.includes(n["xml:id"]))
            }

            for (const note of targetNotes) {
                const newDuration = note.duration * meanRelativeDuration
                const newEnd = residual.of(note)?.tickDate + newDuration
                const conflicts = withinNotes.filter(n => {
                    // find notes on the same pitch, where the articulated 
                    // note starts before the current note and ends after it
                    return (
                        n["midi.pitch"] === note["midi.pitch"]
                        && residual.of(note)?.tickDate < residual.of(n)?.tickDate
                        && newEnd > residual.of(n)?.tickDate
                    )
                })
                if (conflicts.length > 0) {
                    conflictList.add(articulation)
                }
            }
        }

        return conflictList
    }

    generateClusters(articulations: Articulation[]) {
        return dbscan(
            articulations.map(a => [a.relativeDuration, a.relativeVelocity]),
            { epsilons: [this.options.relativeDurationTolerance, this.options.volumeTolerance] }
        )
    }

    protected transform(msm: MSM, mpm: MPM) {
        // Where each note actually fell, under everything the MPM explains apart from
        // articulation — which is what this step is deciding. Derived once: it does not vary by
        // scope, and each call renders the document.
        const residual = deriveResidual(msm, mpm, { without: ['articulation'] })

        for (const scope of mpm.scopes()) {
            // Find clusters
            const articulations = mpm.getInstructions<Articulation>('articulation', scope)
            const points = this.generateClusters(articulations)

            const clusters = Object.groupBy(points, p => p.label)
            const defs: ArticulationDef[] = Object
                .entries(clusters)
                .filter(([label]) => label !== '-1')
                .map(([label, cluster]) => {
                    const relativeDuration = cluster.reduce((acc, p) => acc + p.value[0], 0) / cluster.length
                    const relativeVelocity = cluster.reduce((acc, p) => acc + p.value[1], 0) / cluster.length

                    return {
                        type: 'articulationDef',
                        name: `def_${label}`,
                        relativeDuration,
                        relativeVelocity
                    }
                })

            mpm.insertDefinitions(defs, scope)

            const labeledArticulations: Record<number, Articulation[]> = points.reduce((acc, p, i) => {
                if (p.label === -1) return acc
                if (!acc[p.label]) acc[p.label] = []
                acc[p.label].push(articulations[i])
                return acc
            }, {})

            const conflictList = []
            for (const [, cluster] of Object.entries(labeledArticulations)) {
                conflictList.push(...this.findConflicts(msm.allNotes, cluster, residual))
            }

            for (let i = 0; i < points.length; i++) {
                if (conflictList.includes(articulations[i])) continue
                if (points[i].label === -1) continue

                articulations[i]["name.ref"] = `def_${points[i].label}`
                articulations[i].relativeDuration = undefined
                articulations[i].relativeVelocity = undefined
            }

            // Find default articulation
            const bestCluster = Object.entries(clusters)
                .filter(([label]) => label !== '-1')
                .reduce((prev, curr) => !prev || curr[1].length > prev[1].length ? curr : prev, undefined);

            if (bestCluster) {
                const defName = `def_${bestCluster[0]}`
                mpm.getInstructions<Articulation>('articulation', scope)
                    .filter(a => a["name.ref"] === defName)
                    .forEach(a => mpm.removeInstruction(a))

                mpm.insertStyle({
                    type: 'style',
                    'xml:id': v4(),
                    date: 0,
                    'name.ref': DEFAULT_STYLE_NAME,
                    defaultArticulation: defName
                }, 'articulation', scope)
            }
            else if (defs.length > 0) {
                // if no best cluster could be determined, but there
                // are clusters, insert a default style switch
                mpm.insertStyle({
                    type: 'style',
                    'xml:id': v4(),
                    date: 0,
                    'name.ref': DEFAULT_STYLE_NAME,
                }, 'articulation', scope)
            }
        }
    }
}
