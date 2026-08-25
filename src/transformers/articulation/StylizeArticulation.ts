import { Articulation, ArticulationDef, MPM } from "../../mpm";
import { MSM, MsmNote } from "../../msm";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { dbscan, IPoint } from "../../utils/dbscan";
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
        super({
            volumeTolerance: options?.volumeTolerance || 0.01,
            relativeDurationTolerance: options?.relativeDurationTolerance || 0.2,
        })
    }

    private findConflicts(withinNotes: MsmNote[], clusteredArticulations: Articulation[], residual: Residual) {
        const conflictList: Set<Articulation> = new Set()

        // What every note in this cluster gets stretched to once its articulation refers to the
        // cluster's def, and so the length the conflict below has to be tested against. An
        // articulation that carries no `relativeDuration` measured none and contributes nothing
        // to that mean — averaging it in as `undefined` made the mean NaN, and every comparison
        // against NaN is false, which retired the entire conflict check without saying so.
        const measured = clusteredArticulations
            .map(a => a.relativeDuration)
            .filter(relativeDuration => relativeDuration !== undefined)
        if (measured.length === 0) return conflictList
        const meanRelativeDuration = measured.reduce((acc, d) => acc + d, 0) / measured.length

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
                // A note the residual cannot place has no position on the tick grid — no
                // `<tempo>` covers it — and an overlap is a statement about two positions. So a
                // note without one can neither run into anything nor be run into, and is passed
                // over on both sides of the test. That is what the arithmetic did by accident:
                // `undefined + duration` is NaN and every comparison against it is false.
                const tickDate = residual.of(note)?.tickDate
                if (tickDate === undefined) continue

                const newDuration = note.duration * meanRelativeDuration
                const newEnd = tickDate + newDuration
                const conflicts = withinNotes.filter(n => {
                    if (n["midi.pitch"] !== note["midi.pitch"]) return false
                    const otherTickDate = residual.of(n)?.tickDate
                    if (otherTickDate === undefined) return false

                    // find notes on the same pitch, where the articulated
                    // note starts before the current note and ends after it
                    return tickDate < otherTickDate && newEnd > otherTickDate
                })
                if (conflicts.length > 0) {
                    conflictList.add(articulation)
                }
            }
        }

        return conflictList
    }

    /**
     * One point per articulation, in the same order, labelled with the cluster it belongs to.
     *
     * The clustering happens in (`relativeDuration`, `relativeVelocity`) space, so an
     * articulation missing either attribute has no position in it. That is not exotic:
     * `InsertArticulation` blanks both once it has folded them into a def (issue #25), and the
     * residual leaves either off whenever it could not measure it. Such an articulation is
     * neither evidence for a cluster nor a candidate for one, so it is kept out of the distance
     * computation entirely and returned as noise — which is what it means for it to be left
     * alone, carrying whatever it already says. Feeding it in instead would have compared
     * `undefined` coordinates, and `Math.abs(NaN) <= epsilon` puts it in nobody's neighbourhood
     * while still counting as a point.
     */
    generateClusters(articulations: Articulation[]): IPoint[] {
        const coordinates: number[][] = []
        const placed: number[] = []
        articulations.forEach(({ relativeDuration, relativeVelocity }, index) => {
            if (relativeDuration === undefined || relativeVelocity === undefined) return
            coordinates.push([relativeDuration, relativeVelocity])
            placed.push(index)
        })

        const points: IPoint[] = articulations.map((_, index) => ({ index, value: [], label: -1 }))
        dbscan(coordinates, {
            epsilons: [this.options.relativeDurationTolerance, this.options.volumeTolerance]
        }).forEach((point, i) => points[placed[i]] = { ...point, index: placed[i] })

        return points
    }

    protected transform(msm: MSM, mpm: MPM) {
        // Where each note actually fell, under everything the MPM explains apart from
        // articulation — which is what this step is deciding. Derived once: it does not vary by
        // scope, and each call renders the document.
        const residual = deriveResidual(msm, mpm, { without: ['articulation'] })

        for (const scope of mpm.scopes()) {
            // Find clusters
            const articulations = mpm.getInstructions('articulation', scope)
            const points = this.generateClusters(articulations)

            const clusters: [string, IPoint[]][] = Object
                .entries(Object.groupBy(points, p => p.label))
                .filter(([label]) => label !== '-1')
                .map(([label, cluster = []]) => [label, cluster])

            const defs: ArticulationDef[] = clusters
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

            const labeledArticulations = points.reduce<Record<number, Articulation[]>>((acc, p, i) => {
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
            const bestCluster = clusters
                .reduce<[string, IPoint[]] | undefined>(
                    (prev, curr) => !prev || curr[1].length > prev[1].length ? curr : prev,
                    undefined
                );

            if (bestCluster) {
                const defName = `def_${bestCluster[0]}`
                mpm.getInstructions('articulation', scope)
                    .filter(a => a["name.ref"] === defName)
                    .forEach(a => mpm.removeInstruction(a))

                mpm.ensureDefaultStyle('articulation', scope, { defaultArticulation: defName })
            }
            else if (defs.length > 0) {
                // if no best cluster could be determined, but there
                // are clusters, insert a default style switch
                mpm.ensureDefaultStyle('articulation', scope)
            }
        }
    }
}
