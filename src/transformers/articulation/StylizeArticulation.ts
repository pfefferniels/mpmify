import { Articulation, ArticulationDef, MPM } from "mpm-ts";
import { MSM } from "../../msm";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { v4 } from "uuid";
import { dbscan } from "../../utils/dbscan";

interface StylizeArticulationOptions extends TransformationOptions {
    volumeTolerance: number
    relativeDurationTolerance: number
}

export class StylizeArticulation extends AbstractTransformer<StylizeArticulationOptions> {
    name(): string {
        return 'StylizeArticulation'
    }

    constructor(options?: StylizeArticulationOptions) {
        super()

        this.options = {
            volumeTolerance: options?.volumeTolerance || 0.01,
            relativeDurationTolerance: options?.relativeDurationTolerance || 0.2,
        }
    }

    transform(msm: MSM, mpm: MPM) {
        for (const [scope,] of mpm.doc.performance.parts) {
            // Find clusters
            const articulations = mpm.getInstructions<Articulation>('articulation', scope)
            const points =
                dbscan(
                    articulations.map(a => [a.relativeDuration, a.relativeVelocity]),
                    { epsilons: [this.options.relativeDurationTolerance, this.options.volumeTolerance] }
                )
            console.log('points=', points)

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

            for (let i = 0; i < points.length; i++) {
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
                    'name.ref': 'performance_style',
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
                    'name.ref': 'performance_style',
                }, 'articulation', scope)
            }
        }

        return super.transform(msm, mpm)
    }

    countPreview(mpm: MPM) {
        // todo: implement
        return 12;
    }
}
