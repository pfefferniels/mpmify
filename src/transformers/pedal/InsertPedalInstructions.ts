import type { Normalized } from "espressivo"
import { Mpm, requireMap } from "../../mpm"
import { Alignment } from "../../alignment"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
import { TranslatePhysicalTimeToTicks } from "../tempo"
import { deriveResidual } from "../../residual"

/**
 * A pedal depth as `@position` and `@transition.to` are typed: espressivo's `Normalized`.
 *
 * The brand is compile-time only — `units.ts` is required to emit no JavaScript, so there is no
 * `asNormalized(n)` to call and a plain number reaches the option through an assertion. This is
 * the one place mpmify makes it, so that the two values below carry the brand and the four
 * instructions are written without a cast in sight. Nothing is checked here that was not already
 * the caller's to promise: `@depth` is documented `[0..1]` on the options.
 */
const normalized = (value: number) => value as Normalized

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
 * would be to first insert accurate movements into the alignment (if necessary), and then
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

    protected transform(msm: Alignment, mpm: Mpm) {
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
        const depth = normalized(this.options.depth ?? 1)
        const released = normalized(0)

        const map = requireMap(mpm, 'movement', 'global')

        for (const pedal of validPedals) {
            const tickDate = residual.ofPedal(pedal)!.tickDate!
            const tickDuration = residual.ofPedal(pedal)!.tickDuration!

            if (this.options.direction === 'down') {
                map.addMovement({
                    id: `${pedal['xml:id']}_start`,
                    date: tickDate + this.options.start,
                    position: released,
                    transitionTo: depth,
                    controller: pedal.type
                })

                map.addMovement({
                    id: `${pedal['xml:id']}_moveDown`,
                    date: tickDate + this.options.start + this.options.duration,
                    position: depth,
                    controller: pedal.type
                })
            }
            else {
                const endDate = tickDate + tickDuration

                map.addMovement({
                    id: `${pedal['xml:id']}_moveUp`,
                    date: endDate + this.options.start,
                    position: depth,
                    transitionTo: released,
                    controller: pedal.type
                })

                map.addMovement({
                    id: `${pedal['xml:id']}_end`,
                    date: endDate + this.options.start + this.options.duration,
                    position: released,
                    controller: pedal.type
                })
            }
        }
    }
}
