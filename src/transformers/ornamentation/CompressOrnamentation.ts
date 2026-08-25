import { getDefinitions, Mpm, scopesOf } from "../../mpm";
import { Alignment } from "../../alignment";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { fix } from "../../utils/utils";
import { StylizeOrnamentation } from "./StylizeOrnamentation";

interface CompressOrnamentationOptions extends TransformationOptions {
    tickPrecision: number
}

export class CompressOrnamentation extends AbstractTransformer<CompressOrnamentationOptions> {
    name = 'CompressOrnamentation'
    requires = [StylizeOrnamentation]

    constructor() {
        super({
            tickPrecision: 0
        })
    }

    protected transform(msm: Alignment, mpm: Mpm) {
        const parts = scopesOf(mpm)
        for (const part of parts) {
            const defs = getDefinitions(mpm, 'ornamentDef', part)
            for (const def of defs) {
                const spread = def.getTemporalSpread()
                if (!spread) continue

                const frame = {
                    frameStart: spread.frameStart,
                    frameLength: spread.getFrameLength(),
                }
                fix(frame, 'frameStart', this.options.tickPrecision)
                fix(frame, 'frameLength', this.options.tickPrecision)

                // Written back through the def rather than onto the spread's own fields. A
                // `TemporalSpread` caches the element it generated when the def adopted it, so
                // assigning to `frameStart` would round the object and leave the document
                // holding the unrounded figure.
                def.setTemporalSpreadValues(
                    frame.frameStart,
                    frame.frameLength,
                    spread.frameDomain,
                    spread.intensity,
                    spread.noteOffShift,
                )
            }
        }
    }
}
