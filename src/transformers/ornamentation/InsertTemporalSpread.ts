import { MPM, Ornament } from "mpm-ts"
import { MSM, MsmNote } from "../../msm"
import { isDefined } from "../../utils/utils"
import { AbstractTransformer, generateId, ScopedTransformationOptions } from "../Transformer"

export type ArpeggioPlacement = 'on-beat' | 'before-beat' | 'estimate' | 'none'
export type DatedArpeggioPlacement = Map<number, ArpeggioPlacement>

// onsets is a sorted array normalized to [0, 1]
export const determineIntensity = (onsets: number[]): number => {
    const n = onsets.length;
    // intensity only makes sense for more than 2 notes
    if (n <= 2) return 1;

    // The error function we want to minimize.
    const error = (intensity: number): number => {
        let sum = 0;
        for (let i = 0; i < n; i++) {
            const expected = Math.pow(i / (n - 1), intensity);
            const diff = onsets[i] - expected;
            sum += diff * diff;
        }
        return sum;
    };

    // Search bounds. TODO: make these configurable.
    let lower = 0.1,
        upper = 5.0;
    const tol = 1e-6;
    const goldenRatio = (Math.sqrt(5) + 1) / 2;

    let c = upper - (upper - lower) / goldenRatio;
    let d = lower + (upper - lower) / goldenRatio;

    // Continue refining the bounds until convergence.
    while (upper - lower > tol) {
        if (error(c) < error(d)) {
            upper = d;
        } else {
            lower = c;
        }
        c = upper - (upper - lower) / goldenRatio;
        d = lower + (upper - lower) / goldenRatio;
    }

    return (lower + upper) / 2;
};


/**
 * A little helper function to determine how an array is sorted.
 * 
 * @param arr The array to check
 * @returns -1 if the array is sorted in descending order, 1 if its 
 * sorted in ascending order, 0 if it isn't sorted.
 */
const determineSortDirection = (arr: number[]) => {
    if (arr.length < 2) return 0;

    const direction = Math.sign(arr[1] - arr[0]);
    return arr.slice(1).every((val, i) =>
        Math.sign(val - arr[i]) === direction) ? direction : 0;
}

export interface InsertTemporalSpreadOptions extends ScopedTransformationOptions {
    /**
     * the minimum number of notes an arpeggio is expected to have (inclusive)
     */
    minimumArpeggioSize: number

    /**
     * The minimum amount of time in milliseconds an ornamentation should spread over
     */
    durationThreshold: number

    /**
     * The tolerance in milliseconds applied when calculating the noteoff.shift attribute.
     */
    noteOffShiftTolerance: number

    /**
     * Where to place the arpeggio in relation to the beat?
     * Provides the placements for single dates. If a date
     * is not provided, the default placement is used instead.
     */
    placement: DatedArpeggioPlacement

    /**
     * Fallback placement if no placement is provided for a date.
     */
    defaultPlacement: ArpeggioPlacement
}

/**
 * Interpolates arpeggiated chords as ornaments, inserts them as physical
 * values into the MPM and substracts accordingly from the MIDI onset, so
 * that after the transformation all notes of the chord will have the same
 * onset.
 */
export class InsertTemporalSpread extends AbstractTransformer<InsertTemporalSpreadOptions> {
    name = 'InsertTemporalSpread'
    requires = []

    constructor(options?: InsertTemporalSpreadOptions) {
        super()

        // set the default options
        this.options = options || {
            minimumArpeggioSize: 3,
            durationThreshold: 35,
            placement: new Map(),
            defaultPlacement: 'estimate',
            noteOffShiftTolerance: 500,
            scope: 'global'
        }
    }

    protected transform(msm: MSM, mpm: MPM) {
        const ornaments: Ornament[] = []

        console.log('options=', this.options)

        const chords = msm.asChords(this.options.scope)
        for (let [date, arpeggioNotes] of chords) {
            // only consider notes with a defined onset time
            arpeggioNotes = arpeggioNotes.filter(note => isDefined(note['midi.onset']))

            // make sure number of arpeggiated notes is greater or equal than minimum arpeggio size
            if (arpeggioNotes.length < (this.options?.minimumArpeggioSize || 2)) continue

            const sortedByOnset = arpeggioNotes.sort((a, b) => a['midi.onset'] - b['midi.onset'])

            // detecting the direction of the arpeggiated notes.
            const arpeggioDirection = determineSortDirection(sortedByOnset.map(note => note["midi.pitch"]))
            let noteOrder = ''
            if (arpeggioDirection === 1) noteOrder = 'ascending pitch'
            else if (arpeggioDirection === -1) noteOrder = 'descending pitch'
            else noteOrder = sortedByOnset.map(note => `#${note["xml:id"]}`).join(' ')

            // the arpeggio's duration is the time distance between first and last onset
            const duration = sortedByOnset[sortedByOnset.length - 1]["midi.onset"] - sortedByOnset[0]["midi.onset"]
            if (duration * 1000 <= (this.options?.durationThreshold || 0)) continue

            // by default, no offset shifting is applied
            let noteOffShift: boolean | 'monophonic' = false
            const firstNote = sortedByOnset[0]
            const lastNote = sortedByOnset[sortedByOnset.length - 1]

            const offsetOf = (note: MsmNote) => {
                return note['midi.onset'] + note['midi.duration']
            }

            const sortedByOffset = sortedByOnset.slice().sort((a, b) => offsetOf(a) - offsetOf(b))
            const sameOrder = sortedByOnset.every((note, i) => note === sortedByOffset[i])

            const offsetScaleTolerance = 0.8
            const minOffsetDistance = duration * offsetScaleTolerance
            if (offsetOf(lastNote) - offsetOf(firstNote) > minOffsetDistance && sameOrder) {
                noteOffShift = true
            }

            const monophonicTolerance = 20 / 1000 // in ms
            let isMonophonic = true
            for (let i = 1; i < sortedByOnset.length; i++) {
                const prev = sortedByOnset[i - 1]
                const curr = sortedByOnset[i]

                if (Math.abs(offsetOf(prev) - curr["midi.onset"]) > monophonicTolerance) {
                    isMonophonic = false;
                    break;
                }
            }

            if (isMonophonic) {
                noteOffShift = 'monophonic'
            }

            /*
            if (noteOffShift === 'monophonic') {
                for (let i = 0; i < sortedByOnset.length - 1; i++) {
                    const curr = sortedByOnset[i]
                    const next = sortedByOnset[i + 1]

                    curr["midi.duration"] = next["midi.onset"] - curr["midi.onset"]
                }
            }
            else if (noteOffShift) {
                const meanDuration = sortedByOnset.map(n => n["midi.duration"]).reduce((a, b) => a + b, 0) / sortedByOnset.length
                sortedByOnset.forEach(note => {
                    note["midi.duration"] = meanDuration
                })
            }
            else {
                const newOffset = firstNote['midi.onset'] + firstNote['midi.duration']
                for (let i = 1; i < sortedByOnset.length; i++) {
                    const note = sortedByOnset[i]
                    note['midi.duration'] = newOffset - note['midi.onset']
                }
            }
                */

            // define the frame start based on the given option
            const frameLength = duration * 1000
            let frameStart: number, newOnset: number

            const placement = this.options.placement.get(date) || this.options.defaultPlacement

            if (placement === 'none') {
                // leave everything as it is
                continue
            }
            else if (placement === 'on-beat') {
                frameStart = 0
                newOnset = arpeggioNotes[0]['midi.onset']
            }
            else if (placement === 'before-beat') {
                frameStart = -frameLength
                newOnset = arpeggioNotes[arpeggioNotes.length - 1]['midi.onset']
            }
            else {
                // the estimated onset is the average of all onsets
                newOnset = arpeggioNotes.map(note => note['midi.onset']).reduce((a, b) => a + b, 0) / arpeggioNotes.length

                // frame start is the distance between the first note's onset and the estimated onset
                frameStart = (arpeggioNotes[0]['midi.onset'] - newOnset) * 1000
            }

            // determine the ornament's intensity
            const normalizedOnsets = sortedByOnset
                .map(note => note['midi.onset'])
                .map(onset => (onset - firstNote['midi.onset']) / duration)

            const intensity = determineIntensity(normalizedOnsets)

            ornaments.push({
                'type': 'ornament',
                'xml:id': generateId('ornament', date, mpm),
                date,
                'name.ref': 'neutralArpeggio',
                'noteoff.shift': noteOffShift,
                'note.order': noteOrder,
                'frame.start': frameStart,
                'frameLength': frameLength,
                'time.unit': 'milliseconds',
                'intensity': intensity === 1 ? undefined : intensity
            })

            arpeggioNotes.forEach(note => {
                note['midi.onset'] = newOnset
            })
        }

        mpm.insertInstructions(ornaments, this.options.scope)
    }
}
