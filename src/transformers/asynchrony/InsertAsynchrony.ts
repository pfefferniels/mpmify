import { v4 } from "uuid"
import { Mpm, requireMap, Scope } from "../../mpm"
import { Alignment } from "../../alignment"
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
 * the affected notes. Since it only modifies physical
 * attributes it should be applied before translating
 * physical time to tick time.
 */
export class InsertAsynchrony extends AbstractTransformer<InsertAsynchronyOptions> {
    name = 'InsertAsynchrony'
    requires = []

    constructor(options?: InsertAsynchronyOptions) {
        super(options || {
            from: 0,
            to: 0,
            part: 1
        })
    }

    protected transform(msm: Alignment, mpm: Mpm) {
        const chords = Array
            .from(msm.asChords(this.options.part as Scope))
            .filter(([date, chord]) => {
                // Filter out chords that are not in the range
                return date >= this.options.from && date <= this.options.to && chord.length > 0
            })

        const shifts = chords
            .flatMap(([date, chord]) => {
                const onset = chord.at(0)?.['milliseconds.date']
                const otherChords = msm.asChords(this.options?.part === 1 ? 0 : 1)
                const otherOnset = otherChords.get(date)?.at(0)?.['milliseconds.date']

                // A date the other part does not sound at, or a note that carries no performance
                // onset yet, has no shift to contribute — dropping the pair here is what keeps it
                // out of the average, and doing it in one step is what lets the subtraction below
                // see two numbers.
                if (onset === undefined || otherOnset === undefined) return []
                return [onset - otherOnset]
            })
        
        // A difference of two recorded onsets, so already the milliseconds `@milliseconds.offset`
        // is stated in.
        const averageShift = shifts.reduce((acc, shift) => acc + shift, 0) / shifts.length

        const map = requireMap(mpm, 'asynchrony', this.options.part as Scope)

        map.addAsynchrony({
            id: 'asynchrony_' + v4(),
            date: this.options.from,
            millisecondsOffset: averageShift
        })

        map.addAsynchrony({
            id: 'asynchrony_' + v4(),
            date: this.options.to,
            millisecondsOffset: 0
        })

        // Move the notes by the average shift. Both ends, not just the onset: the instruction
        // displaces the whole note, so a release left where it was would shorten every note the
        // part is early on and lengthen every one it is late on.
        for (const [_, chord] of chords) {
            for (const note of chord) {
                note['milliseconds.date'] -= averageShift
                note['milliseconds.date.end'] -= averageShift
            }
        }
    }
}
