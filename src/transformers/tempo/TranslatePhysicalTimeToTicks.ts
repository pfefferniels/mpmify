import { MPM, Ornament, Tempo } from "../../mpm";
import { MSM } from "../../msm";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { computeMillisecondsAt, TempoWithEndDate } from "./tempoCalculations";
import { addTickDurations, addTickOnsets, approximateDate } from "./tickTimes";

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
 * Interpolates the global tempo and inserts it into the MPM
 */
export class TranslatePhysicalTimeToTicks extends AbstractTransformer<TranslatePhysicalTimeToTicksOptions> {
    name = 'TranslatePhysicalTimeToTicks'
    requires = []

    constructor(options?: TranslatePhysicalTimeToTicksOptions) {
        super()

        // set the default options
        this.options = options || {
            translatePhysicalModifiers: true
        }
    }

    protected transform(msm: MSM, mpm: MPM) {
        addTickOnsets(msm, mpm)
        if (this.options.translatePhysicalModifiers) this.translatePhysicalMPMModifiers(mpm, msm)
        addTickDurations(msm, mpm)
    }

    private msToTicks(ms: number, tempos: Tempo[], msm: MSM) {
        let currentMs = 0
        for (let i = 0; i < tempos.length; i++) {
            const tempo = tempos[i]
            const nextTempo = tempos[i + 1]
            const endDate = nextTempo ? nextTempo.date : msm.end

            const tempoWithEndDate: TempoWithEndDate = {
                ...tempo,
                endDate
            }

            const endMs = computeMillisecondsAt(endDate, tempoWithEndDate)

            if (ms >= currentMs && ms < (currentMs + endMs)) {
                return approximateDate(ms - currentMs, tempoWithEndDate)
            }

            const note = msm.allNotes.find(n => n.date === endDate)
            if (!note) {
                currentMs += endMs
            }
            else {
                currentMs = note["midi.onset"] * 1000
            }
        }
        console.warn('no tempo found for', ms, 'ms amongst', tempos.length, 'tempo instructions')
    }

    private ticksToMs(ticks: number, tempos: Tempo[], msm: MSM) {
        let currentMs = 0
        for (let i = 0; i < tempos.length; i++) {
            const tempo = tempos[i]
            const nextTempo = tempos[i + 1]
            const endDate = nextTempo ? nextTempo.date : msm.end

            const tempoWithEndDate: TempoWithEndDate = {
                ...tempo,
                endDate
            }

            if (ticks >= tempo.date && ticks < endDate) {
                return currentMs + computeMillisecondsAt(ticks, tempoWithEndDate)
            }

            const note = msm.allNotes.find(n => n.date === endDate)
            if (!note) {
                const endMs = computeMillisecondsAt(endDate, tempoWithEndDate)
                currentMs += endMs
            }
            else {
                currentMs = note["midi.onset"] * 1000
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
            const tempos = mpm.getInstructions<Tempo>('tempo', scope)

            const ornaments = mpm.getInstructions<Ornament>('ornament', scope)
            for (const ornament of ornaments) {
                if (ornament["time.unit"] === 'ticks') {
                    // the job is done already
                    continue
                }

                const ornamentMs = this.ticksToMs(ornament.date, tempos, msm)

                const frameStartMs = ornamentMs + ornament["frame.start"]
                const frameEndMs = frameStartMs + ornament.frameLength

                const frameStartTicks = this.msToTicks(frameStartMs, tempos, msm)
                const frameEndTicks = this.msToTicks(frameEndMs, tempos, msm)

                ornament["frame.start"] = frameStartTicks - ornament.date
                ornament['frameLength'] = frameEndTicks - frameStartTicks
                ornament['time.unit'] = 'ticks'
            }
        }
    }


}
