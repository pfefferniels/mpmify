import { MPM } from "../../mpm";
import { MSM } from "../../msm";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { millisecondsAt, ticksForConstantTempo } from "./tempoCalculations";
import { placeTempos, PlacedTempo } from "./placedTempos";
import { approximateDate } from "./tickTimes";

export interface TranslatePhysicalTimeToTicksOptions extends TransformationOptions {
    /**
     * Defines whether physical modifiers which are already present in the MPM
     * (e.g. because of a previous <ornamentation> or <asynchrony> interpolation)
     * should be translated into symbolic ones too.
     */
    translatePhysicalModifiers: boolean

    /**
     * Defines whether the pedal instruction in the MSM should be 
     * translated to tick time as well.
     * @todo not yet implemented
     */
    translatePedalling?: boolean
}

/**
 * Converts the physical parts of the MPM into the tick domain.
 *
 * It used to do two things: write `tickDate` and `tickDuration` onto every note, and convert an
 * ornament's frame from milliseconds to ticks. The first is gone — where a recorded onset falls
 * on the score grid is derived on demand by `deriveResidual` now, so populating it here served
 * nobody and made every later fit depend on this having run.
 *
 * The second is real work and stays: an `<ornament>` frame written in milliseconds has to become
 * ticks in the document itself, which is an edit to the MPM rather than a note about the score.
 * The class keeps its name and its place in the registry — saved work files name it, and
 * `requires` relations across the chain point at it.
 */
export class TranslatePhysicalTimeToTicks extends AbstractTransformer<TranslatePhysicalTimeToTicksOptions> {
    name = 'TranslatePhysicalTimeToTicks'
    requires = []

    constructor(options?: TranslatePhysicalTimeToTicksOptions) {
        super(options || {
            translatePhysicalModifiers: true
        })
    }

    protected transform(msm: MSM, mpm: MPM) {
        if (this.options.translatePhysicalModifiers) this.translatePhysicalMPMModifiers(mpm, msm)
    }

    /**
     * Where a millisecond time falls on the tick grid.
     *
     * The tempo segments cover the piece, and the times asked about do not have to: an ornament's
     * frame reaches backwards from its anchor, so a roll on the first beat asks about a negative
     * time, and a roll near the last one can ask about a time past the final note. Both used to
     * fall out of the loop and return `undefined`, which the caller then subtracted — writing
     * `NaN` into the frame and marking the ornament converted. A roll that begins before its beat
     * is what an arpeggio *is*, so that was every piece-initial ornament.
     *
     * Outside the covered span the answer is an extrapolation at the boundary tempo rather than
     * nothing: exact wherever that boundary segment is constant, and the right limit approaching
     * the boundary where it is not.
     */
    private msToTicks(ms: number, segments: PlacedTempo[]): number | undefined {
        if (segments.length === 0) return undefined

        const first = segments[0].tempo
        if (ms < 0) {
            return first.date + ticksForConstantTempo(ms, first)
        }

        for (const { tempo, startMs, modelledMs } of segments) {
            if (ms >= startMs && ms < startMs + modelledMs) {
                return approximateDate(ms - startMs, tempo)
            }
        }

        // Past the final segment: extrapolate at the tempo it arrives at.
        const last = segments[segments.length - 1]
        const elapsed = last.startMs + last.measuredMs
        return last.tempo.endDate + ticksForConstantTempo(ms - elapsed, {
            bpm: last.tempo["transition.to"] ?? last.tempo.bpm,
            beatLength: last.tempo.beatLength,
        })
    }

    private ticksToMs(ticks: number, segments: PlacedTempo[]) {
        for (const { tempo, resolved, startMs } of segments) {
            // The tick window is the instruction's own span, and for the last segment that ends
            // at the end of the score rather than running open — so this is deliberately not
            // `coversDate`, which lets the last segment take everything after it.
            if (ticks >= tempo.date && ticks < tempo.endDate) {
                return startMs + millisecondsAt(ticks, resolved)
            }
        }
    }

    /**
     * Walks through physical attributes in the
     * given MPM and translates them into tick values.
     * @todo Currently, only ornaments are taken into account.
     */
    translatePhysicalMPMModifiers(mpm: MPM, msm: MSM) {
        for (const scope of mpm.scopes()) {
            const segments = placeTempos(msm, mpm, scope)

            const ornaments = mpm.getInstructions('ornament', scope)
            for (const ornament of ornaments) {
                if (ornament["time.unit"] === 'ticks') {
                    // the job is done already
                    continue
                }

                // An ornament fitted by `InsertDynamicsGradient` carries a velocity ramp and no
                // frame at all. There is nothing physical on it to translate, and translating the
                // absence wrote a `NaN` frame plus a `time.unit` claiming it had been converted —
                // which is what turned every gradient-only ornament into one that
                // `StylizeOrnamentation` would go on to discard.
                if (ornament["frame.start"] === undefined || ornament.frameLength === undefined) {
                    continue
                }

                const ornamentMs = this.ticksToMs(ornament.date, segments)
                if (ornamentMs === undefined) continue

                const frameStartMs = ornamentMs + ornament["frame.start"]
                const frameEndMs = frameStartMs + ornament.frameLength

                const frameStartTicks = this.msToTicks(frameStartMs, segments)
                const frameEndTicks = this.msToTicks(frameEndMs, segments)

                // Leave the ornament in milliseconds rather than stamp an unusable frame on it.
                // Milliseconds are a legal `time.unit`, so an untranslated ornament still
                // performs; a `NaN` one does not.
                if (frameStartTicks === undefined || frameEndTicks === undefined) continue

                ornament["frame.start"] = frameStartTicks - ornament.date
                ornament['frameLength'] = frameEndTicks - frameStartTicks
                ornament['time.unit'] = 'ticks'
            }
        }
    }


}
