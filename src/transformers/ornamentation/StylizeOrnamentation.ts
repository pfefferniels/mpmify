import { DEFAULT_STYLE_NAME, DynamicsGradient, MPM, Ornament, OrnamentDef, Scope } from "../../mpm"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
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
        for (const scope of mpm.scopes()) {
            const ornaments = mpm.getInstructions<Ornament>('ornament', scope)

            const filteredOrnaments = ornaments.filter(o =>
                o["frame.start"] !== undefined &&
                o.frameLength !== undefined
            )

            // An ornament can carry a velocity ramp and no roll — that is exactly what
            // `InsertDynamicsGradient` fits. Clustering keys on the frame, so those used to fall
            // out here and be left pointing at `neutralArpeggio`, a name no definition ever
            // carries. They get definitions of their own, keyed on the only thing they have.
            const gradientOnly = ornaments.filter(o =>
                o["frame.start"] === undefined &&
                o.frameLength === undefined &&
                o["transition.from"] !== undefined &&
                o["transition.to"] !== undefined
            )

            if (filteredOrnaments.length === 0 && gradientOnly.length === 0) continue

            // Which ornaments this run actually gave a definition to. The cleanup below is
            // restricted to these: an ornament that was skipped keeps its attributes, so it
            // still describes something, rather than being emptied out while pointing at a
            // definition that does not exist.
            const defined = new Set<Ornament>()

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
                    group.forEach(({ ornament }) => this.defineAndName(mpm, scope, ornament, defined))
                    continue
                }

                // Process subgroups
                const subClusters = this.generateSubClusters(group.map(c => c.ornament))
                const subClustersByLabel = subClusters.reduce((acc, cur, i) => {
                    const label = cur.label.toString()
                    if (!acc[label]) acc[label] = []
                    acc[label].push(group[i].ornament)
                    return acc
                }, {} as { [label: string]: Ornament[] })

                for (const subLabel in subClustersByLabel) {
                    const subgroup = subClustersByLabel[subLabel]

                    if (subLabel === "-1") {
                        subgroup.forEach(ornament => this.defineAndName(mpm, scope, ornament, defined))
                    } else {
                        const def = this.mergedDef(subgroup, `def_${scope}_${label}_${subLabel}`)
                        mpm.insertDefinition(def, scope)
                        subgroup.forEach(ornament => {
                            ornament["name.ref"] = def.name
                            defined.add(ornament)
                        })
                    }
                }
            }

            this.defineGradientOnly(mpm, scope, gradientOnly, defined)

            mpm.insertStyle({
                date: 0,
                type: 'style',
                'xml:id': v4(),
                'name.ref': DEFAULT_STYLE_NAME,
            }, 'ornament', scope)

            // The working attributes move into the definition, so they come off the
            // instruction — but only for the ornaments that got one. This used to test
            // `name.ref` for truthiness, which is true of an ornament that merely *arrived*
            // carrying a reference: `InsertDynamicsGradient` writes `neutralArpeggio`, a name
            // no definition ever has. Those were stripped of the gradient they were fitted with
            // and left pointing at nothing.
            defined.forEach(ornament => {
                delete ornament['noteoff.shift']
                delete ornament['time.unit']
                delete ornament['transition.from']
                delete ornament['transition.to']
                delete ornament["frame.start"]
                delete ornament["frameLength"]
            })
        }
    }

    /**
     * One definition for a cluster of ornaments: each attribute the mean of the group's.
     *
     * Averaged from the ornaments themselves rather than from the clustering's coordinate
     * vectors. Those vectors were being read by position — `point[3]` and `point[4]` for the two
     * `transition.*` — while `generateClusters` builds a **four**-dimensional point ending in
     * `noteoff.shift`. So the gradient was read one place short: `transition.from` came back as
     * the note-off shift and `transition.to` as `transition.from`, which turned every clustered
     * crescendo into its own mirror image — a truth of 39/51.5/64 refitting as 64/51.5/39. Read
     * the attributes by name and the two cannot come apart again.
     */
    private mergedDef(ornaments: Ornament[], name: string): OrnamentDef {
        const mean = (of: (ornament: Ornament) => number | undefined) => {
            const values = ornaments
                .map(of)
                .filter((value): value is number => value !== undefined)
            if (values.length === 0) return undefined
            return values.reduce((sum, value) => sum + value, 0) / values.length
        }

        const transitionFrom = mean(ornament => ornament["transition.from"])
        const transitionTo = mean(ornament => ornament["transition.to"])

        return {
            type: 'ornamentDef',
            name,
            // Only if the group actually carries one. Defaulting the two ends to zero would
            // describe a ramp nobody measured.
            dynamicsGradient: (transitionFrom !== undefined && transitionTo !== undefined)
                ? {
                    type: 'dynamicsGradient',
                    'transition.from': transitionFrom,
                    'transition.to': transitionTo,
                }
                : undefined,
            temporalSpread: {
                type: 'temporalSpread',
                'frame.start': mean(ornament => ornament["frame.start"]) as number,
                'frameLength': mean(ornament => ornament.frameLength) as number,
                'noteoff.shift': ornaments[0]["noteoff.shift"],
                'time.unit': ornaments[0]["time.unit"],
                // `?? 1`, not `|| 1`: an intensity of 0 is a legal value, not a missing one.
                intensity: mean(ornament => ornament.intensity ?? 1),
            }
        }
    }

    /**
     * Definitions for the ornaments that carry a ramp and no roll.
     *
     * Same shape as the framed path, one dimension shorter: sub-cluster on the gradient alone,
     * give each cluster one definition holding the mean, and leave the noise points with a
     * definition each. Without this the whole family reached the document as `@name.ref`
     * pointing at nothing — well-formed, and silent.
     */
    private defineGradientOnly(mpm: MPM, scope: Scope, ornaments: Ornament[], defined: Set<Ornament>) {
        if (ornaments.length === 0) return

        const clusters = this.generateSubClusters(ornaments)
        const byLabel = clusters.reduce((acc, cluster, index) => {
            const label = cluster.label.toString()
            if (!acc[label]) acc[label] = []
            acc[label].push(ornaments[index])
            return acc
        }, {} as { [label: string]: Ornament[] })

        for (const label in byLabel) {
            const group = byLabel[label]

            if (label === "-1") {
                group.forEach(ornament => this.defineAndName(mpm, scope, ornament, defined))
                continue
            }

            const sums = group.reduce((acc, ornament) => ({
                from: acc.from + (ornament["transition.from"] as number),
                to: acc.to + (ornament["transition.to"] as number),
            }), { from: 0, to: 0 })

            const def: OrnamentDef = {
                type: 'ornamentDef',
                name: `def_${scope}_gradient_${label}`,
                dynamicsGradient: {
                    type: 'dynamicsGradient',
                    'transition.from': sums.from / group.length,
                    'transition.to': sums.to / group.length,
                }
            }

            mpm.insertDefinition(def, scope)
            group.forEach(ornament => {
                ornament["name.ref"] = def.name
                defined.add(ornament)
            })
        }
    }

    /**
     * The definition one ornament asks for, on its own — the shape a cluster of size one gets.
     *
     * Pure. It used to stamp `ornament["name.ref"] = defName` on its way out, before its callers
     * had decided whether to insert the definition at all; every skipped one therefore left the
     * map naming a definition that was never written. Naming now happens where inserting does.
     */
    private asDef(ornament: Ornament): OrnamentDef {
        // `transition.to` is compared against undefined rather than tested for truth. Zero is a
        // legal end for a ramp — and it is the end of `InsertDynamicsGradient`'s own default
        // crescendo, `{ from: -1, to: 0 }` — so a truthiness test dropped the gradient from
        // every crescendo mpmify fits by default.
        let dynamicsGradient: DynamicsGradient | undefined = undefined
        if (ornament["transition.from"] !== undefined &&
            ornament["transition.to"] !== undefined) {
            dynamicsGradient = {
                type: 'dynamicsGradient',
                'transition.from': ornament["transition.from"],
                'transition.to': ornament["transition.to"]
            }
        }

        // An ornament with no frame is a velocity ramp and nothing else. Writing a
        // `<temporalSpread>` full of undefined for it would describe a roll that was never
        // measured.
        const hasFrame = ornament["frame.start"] !== undefined && ornament.frameLength !== undefined

        return {
            type: 'ornamentDef',
            name: `def_${v4()}`,
            dynamicsGradient,
            temporalSpread: hasFrame
                ? {
                    type: 'temporalSpread',
                    'frame.start': ornament["frame.start"],
                    'frameLength': ornament.frameLength,
                    'noteoff.shift': (ornament['noteoff.shift'] !== undefined) ? ornament['noteoff.shift'] : true,
                    'time.unit': ornament['time.unit'],
                    intensity: ornament.intensity
                }
                : undefined
        }
    }

    /**
     * Insert the definition and point the ornament at it — the two halves that must not come
     * apart. An ornament whose frame did not survive translation gets neither: it keeps whatever
     * `@name.ref` it already had rather than gaining a dangling one.
     */
    private defineAndName(mpm: MPM, scope: Scope, ornament: Ornament, defined: Set<Ornament>) {
        const frameStart = ornament["frame.start"]
        const frameLength = ornament.frameLength
        const hasFrame = frameStart !== undefined && frameLength !== undefined

        // Having no frame and having an unusable one are different. A gradient-only ornament has
        // nothing to check; one whose frame failed translation must not be given a definition.
        if (hasFrame && (isNaN(frameStart) || isNaN(frameLength))) {
            console.warn('skipping ornament with an unusable frame', ornament["xml:id"])
            return
        }

        const def = this.asDef(ornament)
        mpm.insertDefinition(def, scope)
        ornament["name.ref"] = def.name
        defined.add(ornament)
    }
}
