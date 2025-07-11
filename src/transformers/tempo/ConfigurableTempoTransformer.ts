import { v4 } from "uuid";
import { MPM, Scope, Tempo } from "mpm-ts";
import { MSM, MsmNote } from "../../msm";
import { AbstractTransformer, generateId, TransformationOptions } from "../Transformer";
import { TempoWithEndDate } from "./tempoCalculations";

export type Point = [number, number];

export type TempoSegment = {
    startDate: number
    endDate: number

    beatLength: number
    measureBeatLength?: number

    startBPM?: number
    endBPM?: number
    meanTempoAt?: number
}

export type TempoSegmentWithPoints = TempoSegment & {
    points: Point[]
}

export type SilentOnset = {
    date: number
    onset: number
}

export interface ConfigurableTempoTransformerOptions extends TransformationOptions {
    /**
     * Defines where new tempo instructions should be
     * set.
     */
    segment: TempoSegment
    silentOnsets: SilentOnset[]

    /**
     * Defines on which part to apply to transformer to.
     * @default 'global'
     */
    part: Scope
}

/**
 * Inserts tempo instructions into the given part based on the
 * given beat length.
 */
export abstract class ConfigurableTempoTransformer extends AbstractTransformer<ConfigurableTempoTransformerOptions> {
    requires = []

    constructor(options?: ConfigurableTempoTransformerOptions) {
        super()

        // set the default options
        this.options = options || {
            part: 'global',
            segment: {
                startDate: 0,
                endDate: 0,
                beatLength: 720
            },
            silentOnsets: []
        }
    }

    protected transform(msm: MSM, mpm: MPM) {
        if (!msm.timeSignature) {
            console.warn('A time signature must be given to interpolate a tempo map.')
            return
        }

        // before starting to calculate the <tempo> instructions,
        // make sure to delete the arbitrary silence before the first note onset
        msm.shiftToFirstOnset()

        this.insertInstructionBySegment(msm, mpm, this.options.segment)
    }

    insertInstructionBySegment(msm: MSM, mpm: MPM, segment: TempoSegment) {
        // remove all tempo instructions that should be overwritten by the new markers
        this.removeAffectedTempoInstructions(mpm, this.options.part, segment)


        const notes = msm.notesInPart(this.options.part)
        const silentOnsets = this.options.silentOnsets

        const segmentWithPoints = pointsWithinSegment(segment, notes, silentOnsets)
        if (segmentWithPoints.points.length < 2) {
            return null
        }

        const tempo = this.approximateTempo(segmentWithPoints)
        tempo['xml:id'] = generateId('tempo', tempo.date, mpm)

        mpm.insertInstruction(tempo, this.options?.part, true)

        // insert a tempo instruction at the very end

        mpm.insertInstruction({
            type: 'tempo',
            date: tempo.endDate,
            bpm: tempo["transition.to"] || tempo.bpm,
            beatLength: tempo.beatLength,
            "xml:id": `tempo_${v4()}`
        }, this.options?.part)
    }

    protected abstract approximateTempo(segment: TempoSegmentWithPoints): TempoWithEndDate

    removeAffectedTempoInstructions(mpm: MPM, scope: Scope, segment: TempoSegment) {
        const tempos = mpm.getInstructions<Tempo>('tempo', scope)
        for (const tempo of tempos) {
            if (tempo.date >= segment.startDate && tempo.date < segment.endDate) {
                mpm.removeInstruction(tempo)
            }
        }
    }
}


export const pointsWithinSegment = (
    segment: TempoSegment,
    notes: MsmNote[],
    silentOnsets: SilentOnset[]
): TempoSegmentWithPoints => {
    const onsetAtDate = (date: number) => {
        const silent = silentOnsets.find(s => s.date === date)
        if (silent) {
            return silent.onset
        }

        const currentNotes = notes.filter(n => n.date === date)
        if (currentNotes.length) return currentNotes[0]["midi.onset"]
    }

    const firstOnset = onsetAtDate(segment.startDate)
    const points: [number, number][] = []
    const beatLength = (segment.measureBeatLength || segment.beatLength) * 4 * 720

    for (let date = segment.startDate; date <= segment.endDate; date += beatLength) {
        const correspondingOnset = onsetAtDate(date)
        if (correspondingOnset !== undefined) {
            console.log('onset at date', date, correspondingOnset)
            points.push([date, (onsetAtDate(date) - firstOnset) * 1000])
        }
    }

    return { ...segment, points }
}
