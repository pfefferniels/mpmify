import { DynamicsGradient, MPM, Ornament, OrnamentDef } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions, Transformer } from "../Transformer"
import { v4 } from "uuid"
import { dbscan } from "../../utils/dbscan"
import { InsertDynamicsGradient } from "./InsertDynamicsGradient"
import { InsertTemporalSpread } from "./InsertTemporalSpread"

export interface StylizeOrnamentationOptions extends TransformationOptions {
    /**
     * given in ticks; used as epsilon for both frame.start and frameLength
     * of the temporalSpread
     */
    tickTolerance: number

    /**
     * Used as epsilon for transition.from and transition.to of the dynamicsGradients
     */
    gradientTolerance: number

    /**
     * Used as epsilon for intensity of the temporalSpread
     */
    intensityTolerance: number
}

export class StylizeOrnamentation extends AbstractTransformer<StylizeOrnamentationOptions> {
    name = 'StylizeOrnamentation'
    requires = [InsertDynamicsGradient, InsertTemporalSpread]

    constructor(options?: StylizeOrnamentationOptions) {
        super()
        this.options = {
            tickTolerance: options?.tickTolerance || 10,
            intensityTolerance: 0.3,
            gradientTolerance: 0.1
        }
    }

    generateClusters(ornaments: Ornament[]) {
        const points = ornaments.map(o => {
            return [
                o["frame.start"] as number,
                o.frameLength as number,
                (o.intensity || 1) as number,
                (o["noteoff.shift"] === 'monophonic' ? -1 : (o['noteoff.shift']) || 0) as number
            ]
        })
        return dbscan(points, {
            epsilons: [
                this.options.tickTolerance,
                this.options.tickTolerance,
                this.options.intensityTolerance,
                0
            ]
        })
    }

    generateSubClusters(ornaments: Ornament[]) {
        const points = ornaments.map(o => {
            return [
                (o["transition.from"] || 0) as number,
                (o["transition.to"] || 0) as number
            ]
        })
        return dbscan(points, {
            epsilons: [
                this.options.gradientTolerance,
                this.options.gradientTolerance
            ]
        })
    }

    protected transform(msm: MSM, mpm: MPM) {
        for (const [scope,] of mpm.doc.performance.parts) {
            const ornaments = mpm.getInstructions<Ornament>('ornament', scope)

            const filteredOrnaments = ornaments.filter(o =>
                o["frame.start"] !== undefined &&
                o.frameLength !== undefined
            )
            if (filteredOrnaments.length === 0) continue

            const clusters = this.generateClusters(filteredOrnaments)

            // Group points by label
            const clustersByLabel = clusters.reduce((acc, cur, i) => {
                const label = cur.label.toString()
                if (!acc[label]) acc[label] = []
                acc[label].push({ ornament: filteredOrnaments[i], point: cur.value as [number, number, number] })
                return acc
            }, {} as { [label: string]: { ornament: Ornament, point: [number, number, number] }[] })

            // Process each cluster
            for (const label in clustersByLabel) {
                const group = clustersByLabel[label]
                if (label === "-1") {
                    group.forEach(({ ornament }) => {
                        const def = this.asDef(ornament)
                        mpm.insertDefinition(def, scope)
                    })
                    continue
                }

                // Process subgroups
                const subClusters = this.generateSubClusters(group.map(c => c.ornament))
                const subClustersByLabel = subClusters.reduce((acc, cur, i) => {
                    const label = cur.label.toString()
                    if (!acc[label]) acc[label] = []
                    acc[label].push({
                        ornament: group[i].ornament,
                        point: [...group[i].point, ...cur.value] as [number, number, number, number, number]
                    })
                    return acc
                }, {} as { [label: string]: { ornament: Ornament, point: [number, number, number, number, number] }[] })

                for (const subLabel in subClustersByLabel) {
                    const subgroup = subClustersByLabel[subLabel]

                    if (subLabel === "-1") {
                        subgroup.forEach(({ ornament }) => {
                            const def = this.asDef(ornament)
                            mpm.insertDefinition(def, scope)
                        })
                    } else {
                        const sums = subgroup.reduce((acc, cur) => {
                            acc.frameStart += cur.point[0]
                            acc.frameLength += cur.point[1]
                            acc.intensity += cur.point[2]
                            acc.transitionFrom += cur.point[3]
                            acc.transitionTo += cur.point[4]
                            return acc
                        }, { frameStart: 0, frameLength: 0, intensity: 0, transitionFrom: 0, transitionTo: 0 })
                        const avgFrameStart = sums.frameStart / subgroup.length
                        const avgFrameLength = sums.frameLength / subgroup.length
                        const avgIntensity = sums.intensity / subgroup.length
                        const avgTransitionFrom = sums.transitionFrom / subgroup.length
                        const avgTransitionTo = sums.transitionTo / subgroup.length

                        const defName = `def_${scope}_${label}_${subLabel}`
                        const noteOffShift = subgroup[0].ornament["noteoff.shift"]
                        const timeUnit = subgroup[0].ornament["time.unit"]

                        const def: OrnamentDef = {
                            type: 'ornamentDef',
                            name: defName,
                            dynamicsGradient: {
                                type: 'dynamicsGradient',
                                'transition.from': avgTransitionFrom,
                                'transition.to': avgTransitionTo
                            },
                            temporalSpread: {
                                type: 'temporalSpread',
                                'frame.start': avgFrameStart,
                                'frameLength': avgFrameLength,
                                'noteoff.shift': noteOffShift,
                                'time.unit': timeUnit,
                                intensity: avgIntensity
                            }
                        }
                        mpm.insertDefinition(def, scope)
                        subgroup.forEach(({ ornament }) => {
                            ornament["name.ref"] = defName
                        })
                    }
                }
            }

            mpm.insertStyle({
                date: 0,
                type: 'style',
                'xml:id': v4(),
                'name.ref': 'performance_style',
            }, 'ornament', scope)

            // Remove temporary fields from ornaments
            ornaments.forEach(o => {
                if (o["name.ref"]) {
                    delete o['noteoff.shift']
                    delete o['time.unit']
                    delete o['transition.from']
                    delete o['transition.to']
                    delete o["frame.start"]
                    delete o["frameLength"]
                }
            })
        }
    }

    private asDef(ornament: Ornament) {
        // For noise points, create individual ornamentDefs
        let dynamicsGradient: DynamicsGradient | undefined = undefined
        if (ornament["transition.from"] !== undefined &&
            ornament["transition.to"]) {
            dynamicsGradient = {
                type: 'dynamicsGradient',
                'transition.from': ornament["transition.from"],
                'transition.to': ornament["transition.to"]
            }
        }

        if (isNaN(ornament["frame.start"]) || isNaN(ornament.frameLength)) {
            console.log('strange ornament', ornament)
        }

        const defName = `def_${v4()}`
        const def: OrnamentDef = {
            type: 'ornamentDef',
            name: defName,
            dynamicsGradient,
            temporalSpread: {
                type: 'temporalSpread',
                'frame.start': ornament["frame.start"],
                'frameLength': ornament.frameLength,
                'noteoff.shift': (ornament['noteoff.shift'] !== undefined) ? ornament['noteoff.shift'] : true,
                'time.unit': ornament['time.unit'],
                intensity: ornament.intensity
            }
        }
        ornament["name.ref"] = defName

        return def
    }
}
