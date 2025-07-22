import { v4 } from "uuid";
import { MPM, Scope, Tempo } from "mpm-ts";
import { MSM, MsmNote } from "../../msm";
import { AbstractTransformer, generateId, ScopedTransformationOptions, TransformationOptions } from "../Transformer";
import { TempoWithEndDate } from "./tempoCalculations";

export type Point = [number, number];

export type TempoSegment = {
    from: number
    to: number

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

export type ConfigurableTempoTransformerOptions =
    ScopedTransformationOptions
    & TempoSegment
    & {
        silentOnsets: SilentOnset[]
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
            scope: 'global',
            from: 0,
            to: 0,
            beatLength: 720,
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

        this.insertInstructionBySegment(msm, mpm, this.options)
    }

    insertInstructionBySegment(msm: MSM, mpm: MPM, segment: TempoSegment) {
        // remove all tempo instructions that should be overwritten by the new markers
        this.removeAffectedTempoInstructions(mpm, this.options.scope, segment)

        const notes = msm.notesInPart(this.options.scope)
        const silentOnsets = this.options.silentOnsets

        const segmentWithPoints = pointsWithinSegment(segment, notes, silentOnsets)
        if (segmentWithPoints.points.length < 2) {
            return null
        }

        const tempo = this.approximateTempo(segmentWithPoints)
        tempo['xml:id'] = generateId('tempo', tempo.date, mpm)

        mpm.insertInstruction(tempo, this.options?.scope, true)

        // insert a tempo instruction at the very end

        mpm.insertInstruction({
            type: 'tempo',
            date: tempo.endDate,
            bpm: tempo["transition.to"] || tempo.bpm,
            beatLength: tempo.beatLength,
            "xml:id": `tempo_${v4()}`
        }, this.options?.scope)
    }

    protected abstract approximateTempo(segment: TempoSegmentWithPoints): TempoWithEndDate

    removeAffectedTempoInstructions(mpm: MPM, scope: Scope, segment: TempoSegment) {
        const tempos = mpm.getInstructions<Tempo>('tempo', scope)
        for (const tempo of tempos) {
            if (tempo.date >= segment.from && tempo.date < segment.to) {
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

    const firstOnset = onsetAtDate(segment.from)
    const points: [number, number][] = []
    const beatLength = (segment.measureBeatLength || segment.beatLength) * 4 * 720

    for (let date = segment.from; date <= segment.to; date += beatLength) {
        const correspondingOnset = onsetAtDate(date)
        if (correspondingOnset !== undefined) {
            points.push([date, (onsetAtDate(date) - firstOnset) * 1000])
        }
    }

    return { ...segment, points }
}
