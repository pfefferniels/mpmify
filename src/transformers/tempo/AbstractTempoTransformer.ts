import { v4 } from "uuid";
import { MPM, Scope, Tempo } from "mpm-ts";
import { MSM } from "../../msm";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { TempoWithEndDate } from "./tempoCalculations";

export type Marker = {
    date: number
    measureBeatLength?: number
    beatLength: number
    continuous: boolean
}

export type SilentOnset = {
    date: number
    onset: number
}

export type Point = [number, number];

export interface AbstractTempoTransformerOptions extends TransformationOptions {
    /**
     * Defines where new tempo instructions should be
     * set.
     */
    markers: Marker[]
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
export abstract class AbstractTempoTransformer extends AbstractTransformer<AbstractTempoTransformerOptions> {
    requires = []

    constructor(options?: AbstractTempoTransformerOptions) {
        super()

        // set the default options
        this.options = options || {
            part: 'global',
            markers: [],
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

        this.insertInstructionsByMarkers(msm, mpm, this.options.markers)
        this.addTickOnsets(msm)
    }

    insertInstructionsByMarkers(msm: MSM, mpm: MPM, markers: Marker[]) {
        const onsetAtDate = (date: number) => {
            const silent = this.options.silentOnsets.find(s => s.date === date)
            if (silent) {
                return silent.onset
            }

            const currentNotes = msm.notesAtDate(date, this.options.part)
            if (currentNotes.length) return currentNotes[0]["midi.onset"]
        }

        if (markers.length < 1) {
            console.log('At least one markers need to be specified')
            return
        }

        // make sure the markers are sorted
        markers.sort((a, b) => a.date - b.date)

        // remove all tempo instructions that should be overwritten by the new markers
        this.removeAffectedTempoInstructions(mpm, this.options.part, markers)

        // remove duplicate markers at the same time
        // prefer longer beat length over the shorter
        for (let i = 0; i < markers.length - 1; i++) {
            if (markers[i].date === markers[i + 1].date) {
                markers.splice(markers[i].beatLength > markers[i + 1].beatLength ? i : i + 1, 1)
            }
        }

        const markersWithPoints = markers
            .map((marker, i): Marker & { points: [number, number][] } => {
                let nextDate
                const nextMarker = markers[i + 1]
                if (nextMarker) {
                    nextDate = nextMarker.date
                }
                else {
                    // when reaching the end, take the overall last onset 
                    // as a virtual next date
                    nextDate = Math.max(...msm.allNotes.map(n => n.date))
                }

                const points: [number, number][] = []
                const firstOnset = onsetAtDate(marker.date)
                const beatLength = marker.measureBeatLength || marker.beatLength

                for (let date = marker.date; date <= nextDate; date += beatLength) {
                    // when the frames are overlapping, take the first onset
                    // of the next frame as the last data point
                    if (date + beatLength > nextDate) {
                        points.push([nextDate, (onsetAtDate(nextDate)/* - firstOnset*/) * 1000])
                        break
                    }

                    const correspondingOnset = onsetAtDate(date)
                    if (correspondingOnset !== undefined) {
                        points.push([date, (onsetAtDate(date)/* - firstOnset*/) * 1000])
                    }
                }

                return { ...marker, points }
            })

        let prevTransitionTo = undefined
        const tempos: TempoWithEndDate[] = []
        for (const marker of markersWithPoints) {
            const startBPM = marker.continuous ? prevTransitionTo : undefined
            try {
                const curve = this.approximateCurve(
                    marker.points,
                    marker.beatLength / 720 / 4,
                    startBPM
                )
                tempos.push(curve)
                if (curve["transition.to"]) {
                    prevTransitionTo = curve["transition.to"]
                }
            }
            catch (e) {
                console.error('Failed to approximate curve:', e)
                continue;
            }
        }

        mpm.insertInstructions(tempos, this.options?.part, true)

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

    /**
     * Approximates a tempo curve from given data points.
     * 
     * @param data The points to approximate the tempo curve from, given as [score time, physical time].
     * @param targetBeatLength The target beat length for the tempo curve.
     * @param startBPM An optional parameter that can be passed when the curve
     * segment to be approximated is intended to continue from the previous curve segment.
     * @returns The approximated tempo curve.
     */
    protected abstract approximateCurve(points: Point[], beatLength: number, startBPM?: number): TempoWithEndDate

    protected abstract addTickOnsets(msm: MSM): void

    removeAffectedTempoInstructions(mpm: MPM, scope: Scope, markers: Marker[]) {
        const sorted = markers.slice().sort((a, b) => a.date - b.date)
        const tempos = mpm.getInstructions<Tempo>('tempo', scope)
        for (const tempo of tempos) {
            if (sorted.some((marker, index) =>
                index < sorted.length - 1 &&
                tempo.date >= marker.date &&
                tempo.date < sorted[index + 1].date
            )) {
                mpm.removeInstruction(tempo)
            }
        }
    }
}

