import { v4 } from "uuid";
import { MPM, Scope, Tempo } from "mpm-ts";
import { MSM } from "../../msm";
import { BeatLengthBasis, calculateBeatLength, filterByBeatLength } from "../BeatLengthBasis";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { approximateFromPoints } from "./SimplifyTempo";

export type Marker = {
    date: number
    beatLength: number
}

export type SilentOnset = {
    date: number
    onset: number
}

export interface InsertTempoInstructionsOptions extends TransformationOptions {
    /**
     * Defines where new tempo instructions should be
     * set. Alternatively, a beat length can be passed
     * @default 'denominator'
     */
    markers: Marker[] | BeatLengthBasis

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
export class InsertTempoInstructions extends AbstractTransformer<InsertTempoInstructionsOptions> {
    constructor(options?: InsertTempoInstructionsOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            part: 'global',
            markers: 'denominator',
            silentOnsets: []
        })
    }

    public name() { return 'InsertTempoInstructions' }

    transform(msm: MSM, mpm: MPM): string {
        if (!msm.timeSignature) {
            console.warn('A time signature must be given to interpolate a tempo map.')
            return super.transform(msm, mpm);
        }

        // before starting to calculate the <tempo> instructions,
        // make sure to delete the arbitrary silence before the first note onset
        msm.shiftToFirstOnset()

        if (typeof this.options.markers === 'object') {
            this.insertInstructionsByMarkers(msm, mpm, this.options.markers)
        }
        else {
            const beatLength = this.options.markers
            this.insertInstructionsByBeatLength(msm, mpm, beatLength)
        }

        return super.transform(msm, mpm)
    }

    insertInstructionsByMarkers(msm: MSM, mpm: MPM, markers: Marker[]) {
        const onsetAtDate = (date: number) => {
            const currentNotes = msm.notesAtDate(date, this.options.part)
            if (currentNotes.length === 0) {
                const silent = this.options.silentOnsets.find(s => s.date === date)
                return silent?.onset
            }
            return currentNotes[0]["midi.onset"]
        }

        if (markers.length <= 1) {
            console.log('At least two markers need to be specified')
            return super.transform(msm, mpm)
        }

        // make sure the markers are sorted
        markers.sort((a, b) => a.date - b.date)

        // remove duplicate markers at the same time
        // prefer longer beat length over the shorter
        for (let i = 0; i < markers.length - 1; i++) {
            if (markers[i].date === markers[i + 1].date) {
                markers.splice(markers[i].beatLength > markers[i + 1].beatLength ? i : i + 1, 1)
            }
        }

        const tempos = markers
            .map((marker, i) => {
                let nextDate
                const nextMarker = markers[i + 1]
                if (nextMarker) {
                    nextDate = nextMarker.date
                }
                else {
                    nextDate = Math.max(...msm.allNotes.map(n => n.date))
                }

                const points = []
                const firstOnset = onsetAtDate(marker.date)

                for (let date = marker.date; date <= nextDate; date += marker.beatLength) {
                    if (onsetAtDate(date) === undefined) {
                        // when the frames are overlapping, take the first onset
                        // of the next frame as the last data point
                        if (date + marker.beatLength > nextDate) {
                            points.push([nextDate, (onsetAtDate(nextDate) - firstOnset) * 1000])
                        }
                        continue
                    }
                    points.push([date, (onsetAtDate(date) - firstOnset) * 1000])
                }

                return approximateFromPoints(points, marker.beatLength / 720 / 4)
            })

        mpm.insertInstructions(tempos, this.options?.part)
    }

    insertInstructionsByBeatLength(msm: MSM, mpm: MPM, beatLength: BeatLengthBasis) {
        const chords = Object.entries(msm.asChords(this.options.part))
        const tempos = chords
            .filter(filterByBeatLength(beatLength, msm.timeSignature))
            .filter(([_, chord]) => {
                if (chord.length === 0) {
                    console.warn('Empty chord found. This is not supposed to happen.')
                }

                return chord.length !== 0
            })
            .map(([date, chord]) => {
                const firstNote = chord[0]
                if (chord.some(note => note["midi.onset"] !== firstNote["midi.onset"])) {
                    console.log(`Not all notes in the chord at ${date}
                    occur at the same physical time. Make sure that a global physical
                    ornamentation map and/or asynchrony map are calculated before
                    applying this transformer.`)
                }
                return firstNote
            })
            .map((currentNote, i, selectedNotes) => {
                const currentOnset = currentNote["midi.onset"]
                const nextNote = selectedNotes[i + 1]

                let ratio = 1
                let nextOnset, beatLength
                if (nextNote) {
                    nextOnset = nextNote['midi.onset']
                    if (beatLength === 'everything') {
                        beatLength = currentNote['duration'] / 720 / 4
                    }
                    else {
                        const givenBeatLength = calculateBeatLength(beatLength, msm.timeSignature)

                        if (nextNote.date !== currentNote.date + givenBeatLength) {
                            const newBeatLength = nextNote.date - currentNote.date
                            ratio = givenBeatLength / newBeatLength
                        }

                        beatLength = givenBeatLength / 720 / 4
                    }
                }
                else {
                    nextOnset = currentOnset + currentNote['midi.duration']
                    beatLength = currentNote['duration'] / 720 / 4
                }

                const bpm = nextOnset !== undefined ? 60 / (ratio * (nextOnset - currentOnset)) : 60

                return {
                    type: 'tempo',
                    date: currentNote.date,
                    'xml:id': `tempo_${v4()}`,
                    beatLength,
                    bpm
                } as Tempo
            })
            .filter(tempo => !isNaN(tempo.bpm))

        mpm.insertInstructions(tempos, this.options?.part || 'global')
    }
}

