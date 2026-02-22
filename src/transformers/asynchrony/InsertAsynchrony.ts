import { v4 } from "uuid"
import { MPM, Scope } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"

export type InsertAsynchronyOptions = TransformationOptions
    & {
        /**
         * Defines which part to apply asynchrony for. Global asynchrony is impossible.
         */
        part: Omit<Scope, 'global'>
    }
    & {
        from: number
        to: number
    }


/**
 * This transformer inserts <asynchrony> instructions for a
 * given range and part and substracts the shift from
 * the affected MSM notes. Since it only modifies physical
 * attributes it should be applied before translating
 * physical time to tick time.
 */
export class InsertAsynchrony extends AbstractTransformer<InsertAsynchronyOptions> {
    name = 'InsertAsynchrony'
    requires = []

    constructor(options?: InsertAsynchronyOptions) {
        super()

        // set the default options
        this.options = options || {
            from: 0,
            to: 0,
            part: 1
        }
    }

    protected transform(msm: MSM, mpm: MPM) {
        const chords = Array
            .from(msm.asChords(this.options.part as Scope))
            .filter(([date, chord]) => {
                // Filter out chords that are not in the range
                return date >= this.options.from && date <= this.options.to && chord.length > 0
            })

        const shifts = chords
            .map(([date, chord]) => {
                const onset = chord.at(0)?.['midi.onset']
                const otherChords = msm.asChords(this.options?.part === 1 ? 0 : 1)
                const otherOnset = otherChords.get(date)?.at(0)?.['midi.onset']
                return [onset, otherOnset] as [number?, number?]
            })
            .filter(([onset, otherOnset]) => {
                return onset !== undefined && otherOnset !== undefined
            })
            .map(([onset, otherOnset]) => {
                return onset - otherOnset
            })
        
        const averageShift = shifts.reduce((acc, shift) => acc + shift, 0) / shifts.length

        mpm.insertInstruction({
            'xml:id': 'asynchrony_' + v4(),
            type: 'asynchrony',
            date: this.options.from,
            'milliseconds.offset': averageShift
        }, this.options.part as Scope)

        mpm.insertInstruction({
            'xml:id': 'asynchrony_' + v4(),
            type: 'asynchrony',
            date: this.options.to,
            'milliseconds.offset': 0
        }, this.options.part as Scope)

        // Move the onsets by the average shift
        for (const [_, chord] of chords) {
            for (const note of chord) {
                note['midi.onset'] -= averageShift
            }
        }
    }
}
