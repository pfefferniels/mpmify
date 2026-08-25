import { MPM } from "../../mpm"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
import { TranslatePhysicalTimeToTicks } from "../tempo"
import { deriveResidual } from "../../residual"

export type InsertPedalOptions =
    TransformationOptions
    & {
        pedal?: string, // identify a pedal by its xml:id. If not given, all pedals are considered
        start: number // relative to the original time, in ticks
        duration: number // in ticks
        direction: 'up' | 'down',
        depth?: number // [0..1], default 1
    }

/**
 * This transformer is a shortcut. The developed "path" for encoding pedal changes
 * would be to first insert accurate movements into the MSM (if necessary), and then
 * to approximate the shape using a transformer similiar to `InsertDynamics`. However,
 * this shortcut is useful for all cases in which the original source material
 * cannot represent accurate pedal movements (such as reproducing piano rolls)
 * and where these abrupt pedal changes are to be interpreted.
 */
export class InsertPedal extends AbstractTransformer<InsertPedalOptions> {
    name = 'InsertPedal'
    requires = [TranslatePhysicalTimeToTicks]

    constructor(options?: InsertPedalOptions) {
        super(options || {
            // A pedal mark carries no shape of its own, so the defaults are the reading this
            // shortcut exists for: the pedal goes down where the mark is, over a ramp short
            // enough to read as the abrupt change a piano roll records — a 32nd at mpmify's
            // 720 ppq, some 60 ms at 120 bpm. A zero-length one would put both movements on
            // the same date, which describes no ramp at all.
            start: 0,
            duration: 90,
            direction: 'down'
        })
    }

    protected transform(msm: MSM, mpm: MPM) {
        // Where each pedal fell on the score grid, under the MPM as it stands. `movement` is
        // held out for the same reason every other fitter holds its own dimension out, though
        // it changes nothing here: a movementMap moves controllers, not the pedal marks this
        // reads. Note the tick figures for pedals carry no rubato compensation — the warp is
        // taken off notes only, which `removeRubatoDistortion` records as a standing @todo.
        const residual = deriveResidual(msm, mpm, { without: ['movement'] })

        const validPedals = msm.pedals
            .filter(pedal => {
                const tickDate = residual.ofPedal(pedal)?.tickDate
                const tickDuration = residual.ofPedal(pedal)?.tickDuration

                if (tickDate === undefined || tickDuration === undefined) {
                    return false
                }

                if (this.options.pedal) {
                    return pedal["xml:id"] === this.options.pedal
                }

                return true
            })
        // `??`, so a caller asking for a depth of `0` gets one. `||` read it as "not given" and
        // substituted a fully depressed pedal — the opposite of what was asked for (issue #46).
        const depth = this.options.depth ?? 1

        for (const pedal of validPedals) {
            const tickDate = residual.ofPedal(pedal)!.tickDate!
            const tickDuration = residual.ofPedal(pedal)!.tickDuration!

            if (this.options.direction === 'down') {
                mpm.insertInstruction({
                    'xml:id': `${pedal['xml:id']}_start`,
                    type: 'movement',
                    date: tickDate + this.options.start,
                    position: 0,
                    "transition.to": depth,
                    controller: pedal.type
                }, 'global')

                mpm.insertInstruction({
                    'xml:id': `${pedal['xml:id']}_moveDown`,
                    type: 'movement',
                    date: tickDate + this.options.start + this.options.duration,
                    position: depth,
                    controller: pedal.type
                }, 'global')
            }
            else {
                const endDate = tickDate + tickDuration

                mpm.insertInstruction({
                    'xml:id': `${pedal['xml:id']}_moveUp`,
                    type: 'movement',
                    date: endDate + this.options.start,
                    position: depth,
                    "transition.to": 0,
                    controller: pedal.type
                }, 'global')

                mpm.insertInstruction({
                    'xml:id': `${pedal['xml:id']}_end`,
                    type: 'movement',
                    date: endDate + this.options.start + this.options.duration,
                    position: 0,
                    controller: pedal.type
                }, 'global')
            }
        }
    }
}
