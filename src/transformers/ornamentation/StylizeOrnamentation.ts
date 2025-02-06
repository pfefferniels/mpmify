import { DynamicsGradient, MPM, Ornament, OrnamentDef } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
import { v4 } from "uuid"
import { dbscan } from "../../utils/dbscan"

export interface StylizeOrnamentationOptions extends TransformationOptions {
    /**
     * given in ticks; used as epsilon tolerance for both frame.start and frameLength
     */
    tolerance: number
}

export class StylizeOrnamentation extends AbstractTransformer<StylizeOrnamentationOptions> {
    constructor(options?: StylizeOrnamentationOptions) {
        super()
        this.options = {
            tolerance: options?.tolerance || 10
        }
    }

    public name() { return 'StylizeOrnamentation' }

    generateClusters(ornaments: Ornament[]) {
        const points = ornaments.map(o => [o["frame.start"] as number, o.frameLength as number])
        return dbscan(points, { epsilons: [this.options.tolerance, this.options.tolerance] })
    }

    public transform(msm: MSM, mpm: MPM): string {
        for (const [scope, ] of mpm.doc.performance.parts) {
            const ornaments = mpm.getInstructions<Ornament>('ornament', scope)

            const gradients = ["crescendo", "decrescendo"]

            for (const gradientType of gradients) {
                // Filter ornaments that match the current gradient and have required fields
                const filteredOrnaments = ornaments.filter(o =>
                    o.gradient === gradientType &&
                    o["frame.start"] !== undefined &&
                    o.frameLength !== undefined
                )
                if (filteredOrnaments.length === 0) continue

                const clusters = this.generateClusters(filteredOrnaments)

                // Group points by label
                const clustersByLabel = clusters.reduce((acc, cur, i) => {
                    const label = cur.label.toString()
                    if (!acc[label]) acc[label] = []
                    acc[label].push({ ornament: filteredOrnaments[i], point: cur.value as [number, number] })
                    return acc
                }, {} as { [label: string]: { ornament: Ornament, point: [number, number] }[] })

                // Process each cluster
                for (const label in clustersByLabel) {
                    const group = clustersByLabel[label]
                    if (label === "-1") {
                        // For noise points, create individual ornamentDefs
                        group.forEach(({ ornament, point }) => {
                            let dynamicsGradient: DynamicsGradient
                            if (gradientType === 'crescendo') {
                                dynamicsGradient = { type: 'dynamicsGradient', 'transition.from': -1, 'transition.to': 0 }
                            } else {
                                dynamicsGradient = { type: 'dynamicsGradient', 'transition.from': 0, 'transition.to': -1 }
                            }
                            const defName = `def_${gradientType}_${v4()}`
                            const def: OrnamentDef = {
                                type: 'ornamentDef',
                                name: defName,
                                dynamicsGradient,
                                temporalSpread: {
                                    type: 'temporalSpread',
                                    'frame.start': point[0],
                                    'frameLength': point[1],
                                    'noteoff.shift': (ornament['noteoff.shift'] !== undefined) ? ornament['noteoff.shift'] : true,
                                    'time.unit': ornament['time.unit']
                                }
                            }
                            mpm.insertDefinition(def, scope)
                            ornament["name.ref"] = defName
                        })
                    } else {
                        // For clusters (more than one point), combine ornaments
                        const sum = group.reduce((acc, cur) => {
                            acc.x += cur.point[0]
                            acc.y += cur.point[1]
                            return acc
                        }, { x: 0, y: 0 })
                        const avgX = sum.x / group.length
                        const avgY = sum.y / group.length

                        let dynamicsGradient: DynamicsGradient
                        if (gradientType === 'crescendo') {
                            dynamicsGradient = { type: 'dynamicsGradient', 'transition.from': -1, 'transition.to': 0 }
                        } else {
                            dynamicsGradient = { type: 'dynamicsGradient', 'transition.from': 0, 'transition.to': -1 }
                        }
                        const defName = `def_${gradientType}_${label}`
                        // Use representative ornament from the group
                        const repOrn = group[0].ornament
                        const def: OrnamentDef = {
                            type: 'ornamentDef',
                            name: defName,
                            dynamicsGradient,
                            temporalSpread: {
                                type: 'temporalSpread',
                                'frame.start': avgX,
                                'frameLength': avgY,
                                'noteoff.shift': repOrn['noteoff.shift'] !== undefined ? repOrn['noteoff.shift'] : true,
                                'time.unit': repOrn['time.unit']
                            }
                        }
                        mpm.insertDefinition(def, scope)
                        group.forEach(({ ornament }) => {
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
                    delete o['gradient']
                    delete o["frame.start"]
                    delete o["frameLength"]
                }
            })


        }

        // Hand it over to the next transformer
        return super.transform(msm, mpm)
    }
}
