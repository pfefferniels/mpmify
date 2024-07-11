import { DynamicsGradient, MPM, Ornament, OrnamentDef, Part } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
import { v4 } from "uuid"

const withinTolerance = (tolerance: number, given: number, search: number) => {
    return search >= (given - tolerance) && search < given + tolerance
}

export interface StylizeOrnamentationOptions extends TransformationOptions {
    /**
     * given in ticks
     */
    tolerance: number
}

/**
 * This transformer tries to combine multiple instructions
 * into fewer archetype definitions, taking a given tolerance into account.
 * Style definitions will always be written into the global environment.
 */
export class StylizeOrnamentation extends AbstractTransformer<StylizeOrnamentationOptions> {
    constructor() {
        super()

        this.options = {
            tolerance: 10
        }
    }

    public name() { return 'StylizeOrnamentation' }

    public transform(msm: MSM, mpm: MPM): string {
        for (const [scope, ] of mpm.doc.performance.parts) {
            const ornaments = mpm.getInstructions<Ornament>('ornament', scope)
            console.log('ornaments', ornaments)
            for (const ornament of ornaments) {
                if (ornament["frame.start"] === undefined || ornament.frameLength === undefined) continue

                console.log('startin insertion')

                let dynamicsGradient: DynamicsGradient
                if (ornament.gradient === 'crescendo') {
                    dynamicsGradient = { type: 'dynamicsGradient', 'transition.from': -1, 'transition.to': 0 }
                }
                else if (ornament.gradient === 'decrescendo') {
                    dynamicsGradient = { type: 'dynamicsGradient', 'transition.from': 0, 'transition.to': -1 }
                }

                const defs = mpm.getDefinitions<OrnamentDef>('ornamentDef', scope)
                const existingDef = defs.find(def => {
                    let sameGradient = true
                    if (def.dynamicsGradient) {
                        const gradient = def.dynamicsGradient
                        const trans = (gradient["transition.to"] - gradient["transition.from"]) > 0 ? 'crescendo' : 'decrescendo'
                        sameGradient = trans === ornament.gradient
                    }

                    return (
                        withinTolerance(this.options.tolerance, def.temporalSpread['frame.start'], ornament['frame.start'] || 0) &&
                        withinTolerance(this.options.tolerance, def.temporalSpread['frameLength'], ornament['frameLength'] || 0) &&
                        sameGradient
                    )
                })

                if (existingDef) {
                    existingDef.temporalSpread["frame.start"] = (existingDef.temporalSpread['frame.start'] + ornament['frame.start']) / 2
                    existingDef.temporalSpread['frameLength'] = (existingDef.temporalSpread['frameLength'] + ornament['frameLength']) / 2
                    ornament["name.ref"] = existingDef.name
                }
                else {
                    console.log('but really!')
                    const defName = `def_${v4()}`
                    mpm.insertDefinition({
                        'type': 'ornamentDef',
                        name: defName,
                        dynamicsGradient,
                        temporalSpread: {
                            type: 'temporalSpread',
                            'frameLength': ornament.frameLength,
                            'frame.start': ornament['frame.start'],
                            'noteoff.shift': ornament['noteoff.shift'] || true,
                            'time.unit': ornament['time.unit'],
                        }
                    }, scope)
                    ornament["name.ref"] = defName
                }

                delete ornament['noteoff.shift']
                delete ornament['time.unit']
                delete ornament['gradient']
                delete ornament["frame.start"]
                delete ornament["frameLength"]
            }
        }


        // hand it over to the next transformer
        return super.transform(msm, mpm)
    }
}
