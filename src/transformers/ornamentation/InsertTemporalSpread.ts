import { MPM, Ornament, Scope } from "mpm-ts"
import { MSM } from "../../msm"
import { isDefined } from "../../utils/utils"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
import { v4 } from "uuid"

export type ArpeggioPlacement = 'on-beat' | 'before-beat' | 'estimate' | 'none'
export type DatedArpeggioPlacement = Map<number, ArpeggioPlacement>

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

export interface InsertTemporalSpreadOptions extends TransformationOptions {
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

    /**
     * The part on which the transformer is to be applied to.
     */
    part: Scope
}

/**
 * Interpolates arpeggiated chords as ornaments, inserts them as physical
 * values into the MPM and substracts accordingly from the MIDI onset, so
 * that after the transformation all notes of the chord will have the same
 * onset.
 */
export class InsertTemporalSpread extends AbstractTransformer<InsertTemporalSpreadOptions> {
    name = 'InsertTemporalSpread'

    constructor(options?: InsertTemporalSpreadOptions) {
        super()

        // set the default options
        this.options = options || {
            minimumArpeggioSize: 3,
            durationThreshold: 35,
            placement: new Map(),
            defaultPlacement: 'estimate',
            noteOffShiftTolerance: 500,
            part: 'global'
        }
    }

    public transform(msm: MSM, mpm: MPM) {
        const ornaments: Ornament[] = []

        const chords = msm.asChords(this.options?.part)
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

            // helper function to check wether a value is in the shift tolerance
            const shiftTolerance = this.options?.noteOffShiftTolerance || 0
            const inToleranceRange = (x: number, target: number) => x >= (target - (shiftTolerance / 1000) / 2) && x <= (target + (shiftTolerance / 1000) / 2)

            // by default, no offset shifting is applied
            let noteOffShift: boolean | 'monophonic' = false
            const firstNote = sortedByOnset[0]

            // if every onset is in the tolerance range of the previous offset, 
            // set noteoff.shift to monophonic. This should be tested first, 
            // since it might be a special case of arpeggiation with regular note off shifting.
            if (sortedByOnset.every((note, i, notes) => {
                if (i === 0) return true
                const lastOffset = notes[i - 1]['midi.onset'] + notes[i - 1]['midi.duration']
                return inToleranceRange(note['midi.onset'], lastOffset)
            })) {
                noteOffShift = 'monophonic'
            }
            // if every note has the same duration (including tolerance) like the first note, 
            // set noteoff.shift to true
            else if (sortedByOnset.every(note => inToleranceRange(note['midi.duration'], firstNote['midi.duration']))) {
                noteOffShift = true
            }

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

            ornaments.push({
                'type': 'ornament',
                'xml:id': 'ornament_' + v4(),
                date,
                'name.ref': 'neutralArpeggio',
                'noteoff.shift': noteOffShift,
                'note.order': noteOrder,
                'frame.start': frameStart,
                'frameLength': frameLength,
                'time.unit': 'milliseconds',
            })

            arpeggioNotes.forEach(note => {
                note['midi.onset'] = newOnset
            })
        }

        mpm.insertInstructions(ornaments, this.options.part)
    }
}
