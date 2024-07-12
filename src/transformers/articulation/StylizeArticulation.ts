import { Articulation, ArticulationDef, MPM, Part, Scope } from "mpm-ts";
import { MSM } from "../../msm";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { v4 } from "uuid";

interface StylizeArticulationOptions extends TransformationOptions {
    volumeTolerance: number
    relativeDurationTolerance: number
    scope: Scope
}

export class StylizeArticulation extends AbstractTransformer<StylizeArticulationOptions> {
    name(): string {
        return 'StylizeArticulation'
    }

    constructor() {
        super()

        this.options = {
            volumeTolerance: 2,
            relativeDurationTolerance: 0.2,
            scope: 'global'
        }
    }

    transform(msm: MSM, mpm: MPM) {
        const relativeDurationTolerance = this.options.relativeDurationTolerance / 2
        const volumeTolerance = this.options.volumeTolerance / 2

        const inDurationTolerance = (x: number, target: number): boolean => x >= (target - relativeDurationTolerance) && x <= (target + relativeDurationTolerance)
        const inVolumeTolerance = (x: number, target: number): boolean => x >= (target - volumeTolerance) && x <= (target + volumeTolerance)

        const articulations = mpm.getInstructions<Articulation>('articulation', this.options.scope)
        for (const articulation of articulations) {
            const all = mpm.getDefinitions<ArticulationDef>('articulationDef', this.options.scope)

            // if the articulation represents nothing out of the
            // ordinary we do not actually need it
            if (inDurationTolerance(articulation.relativeDuration, 1.0) && inVolumeTolerance(articulation.absoluteVelocityChange, 0)) {
                mpm.removeInstruction(articulation)
                continue
            }

            // TODO: is it possible to just combine this with an existing
            // articulation instruction at the same date?

            const existing = all.find(def => (
                inDurationTolerance(articulation.relativeDuration, def.relativeDuration)
                && inVolumeTolerance(articulation.absoluteVelocityChange, def.absoluteVelocityChange)
            ))

            let name = `def_${v4()}`
            if (existing) {
                // take the avarage
                existing.relativeDuration = (existing.relativeDuration + articulation.relativeDuration) / 2
                existing.absoluteVelocityChange = (existing.absoluteVelocityChange + articulation.absoluteVelocityChange) / 2
                name = existing.name
            }
            else {
                mpm.insertDefinition({
                    type: 'articulationDef',
                    name: `def_${v4()}`,
                    relativeDuration: articulation.relativeDuration,
                    absoluteVelocityChange: articulation.absoluteVelocityChange
                }, this.options.scope)
            }
            articulation["name.ref"] = name
            delete articulation.relativeDuration
        }

        return super.transform(msm, mpm)
    }
}
