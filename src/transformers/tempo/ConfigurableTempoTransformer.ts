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
    segments: TempoSegment[]
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
            segments: [],
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

        this.insertInstructionsBySegments(msm, mpm, this.options.segments)
    }

    insertInstructionsBySegments(msm: MSM, mpm: MPM, segments: TempoSegment[]) {
        if (segments.length < 1) {
            console.log('At least one markers need to be specified')
            return
        }

        // remove all tempo instructions that should be overwritten by the new markers
        this.removeAffectedTempoInstructions(mpm, this.options.part, segments)

        const tempos = segments
            .map(segment => {
                const notes = msm.notesInPart(this.options.part)
                const silentOnsets = this.options.silentOnsets

                return pointsWithinSegment(segment, notes, silentOnsets)
            })
            .map(segment => {
                if (segment.points.length < 2) {
                    return null
                }

                return this.approximateTempo(segment)
            })
            .filter((segment): segment is TempoWithEndDate => segment !== null)
            .sort((a, b) => a.date - b.date)
            .map(t => {
                return {
                    ...t, 
                    'xml:id': generateId('tempo', t.date, mpm)
                }
            })

        mpm.insertInstructions(tempos.sort((a, b) => a.date - b.date), this.options?.part, true)

        // insert another tempo instruction at the very end
        if (tempos.length > 0) {
            const lastTempo = tempos[tempos.length - 1]

            mpm.insertInstruction({
                type: 'tempo',
                date: lastTempo.endDate,
                bpm: lastTempo["transition.to"] || lastTempo.bpm,
                beatLength: lastTempo.beatLength,
                "xml:id": `tempo_${v4()}`
            }, this.options?.part)
        }
    }

    protected abstract approximateTempo(segment: TempoSegmentWithPoints): TempoWithEndDate

    removeAffectedTempoInstructions(mpm: MPM, scope: Scope, markers: TempoSegment[]) {
        const sorted = markers.slice().sort((a, b) => a.startDate - b.startDate)
        const tempos = mpm.getInstructions<Tempo>('tempo', scope)
        for (const tempo of tempos) {
            if (sorted.some((marker, index) =>
                index < sorted.length - 1 &&
                tempo.date >= marker.startDate &&
                tempo.date < marker.endDate
            )) {
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
