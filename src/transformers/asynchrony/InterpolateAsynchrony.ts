import { v4 } from "uuid"
import { Asynchrony, MPM, Part } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"

export interface InterpolateAsynchronyOptions extends TransformationOptions {
    /**
     * Defines which part to apply asynchrony for. Global asynchrony is impossible.
     */
    part: Omit<Part, 'global'>

    /**
     * Tolerance in milliseconds for not inserting a new asynchrony instruction
     */
    tolerance: number

    /**
     * Precision (in digits after the decimal point)
     */
    precision: number
}

/**
 * This transformer interpolates asynchrony instructions. It maybe applied only 
 * to a part, not globally.
 * 
 * Since it only modifies physical attributes it should
 * be applied before interpolating the tempo map. If neither global physical
 * ornamentation map nor asynchrony map are calculated, the tempo map transformer can
 * not know, which note of a chord to use for its calculations.
 * 
 * Under certain circumstances it should not be applied
 * after a global ornamentationMap has been interpolated. A subsequent interpolation
 * of dynamics map should be partwise.
 */
export class InterpolateAsynchrony extends AbstractTransformer<InterpolateAsynchronyOptions> {
    constructor(options?: InterpolateAsynchronyOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            part: 0,
            tolerance: 10,
            precision: 0
        })
    }

    public name() { return 'InterpolateAsynchrony' }

    public transform(msm: MSM, mpm: MPM): string {
        // Calculate the difference to the other part 
        // for every tstamp
        const asynchronies: Asynchrony[] = []

        const chords = msm.asChords(this.options?.part as Part || 0)
        for (const [date, chord] of chords) {
            if (!chord.length) {
                // This is not supposed to happen. Throw an error instead?
                continue
            }

            // Assume, that all notes of that part 
            // are synchronized already as arpeggiations.
            // If not, take the first note and print a warning.
            const firstNote = chord[0]
            const onset = firstNote['midi.onset']

            if (chord.some(note => note['midi.onset'] !== onset)) {
                console.log(`Multiple notes inside a chord of part should be 
                    synchronized before applying the InterpolateAsynchrony transformer.`)
            }

            const otherChords = msm.asChords(this.options?.part === 1 ? 0 : 1)
            const otherChord = otherChords.get(date)

            if (!onset || !otherChord || !otherChord.length || !otherChord[0]['midi.onset']) {
                console.log(`Cannot interpolate asynchrony if no MIDI onset is defined
                    for one of the two parts.`)
                continue
            }

            const otherOnset = otherChord[0]['midi.onset']

            const offset = (onset - otherOnset) * 1000

            // Check whether the new offset is in the tolerance range of the previous one.
            // If yes ...
            const lastOffset = asynchronies.at(-1)?.["milliseconds.offset"]
            if (lastOffset && Math.abs(offset - lastOffset) < this.options!.tolerance) {
                // ... remove the offset time from the onset for further processing
                // and don't insert a new asynchrony into the map
                chord.forEach(note => note["midi.onset"] -= (lastOffset / 1000))
                continue
            }

            asynchronies.push({
                'type': 'asynchrony',
                'xml:id': 'asynchrony_' + v4(),
                date,
                'milliseconds.offset': +offset.toFixed(this.options?.precision || 0)
            })
            chord.forEach(note => note["midi.onset"] -= (offset / 1000))

            // TODO: avoid singular asynchrony instructions, as they are 
            // better covered by @absoluteDelay of <articulation>.
        }

        console.log('after applying asynchrony', msm.allNotes.map(note => note['midi.onset']))

        mpm.insertInstructions(asynchronies, 0)

        return super.transform(msm, mpm)
    }
}
