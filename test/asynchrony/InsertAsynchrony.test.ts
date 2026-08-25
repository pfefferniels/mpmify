// @vitest-environment jsdom

import { describe, expect, test } from "vitest"
import { MPM } from "../../src/mpm"
import { MSM, MsmNote } from "../../src/msm"
import { InsertAsynchrony } from "../../src/transformers/asynchrony/InsertAsynchrony"
import { PULSES_PER_QUARTER } from "../../src/ppq"

const note = (id: string, part: number, date: number, onset: number): MsmNote => ({
    'xml:id': id,
    part,
    date,
    duration: PULSES_PER_QUARTER,
    pitchname: 'c',
    accidentals: 0,
    octave: 4,
    'midi.pitch': 60,
    'midi.velocity': 64,
    'midi.onset': onset,
    'midi.duration': 500,
})

const run = (notes: MsmNote[], part: number, to: number) => {
    const msm = new MSM(notes)
    const mpm = new MPM()
    // `argumentation` is assigned by whoever builds the chain; `insertMetadata` reads it
    // through `?.` and falls back to the transformer's own id, so a bare instance runs.
    new InsertAsynchrony({ part, from: 0, to }).run(msm, mpm)
    return { msm, mpm }
}

const offsets = (mpm: MPM) => mpm
    .getInstructions('asynchrony')
    .map(a => a['milliseconds.offset'])

/**
 * `InsertAsynchrony` measures how far one part sits from the rest of the ensemble, writes that
 * as an `<asynchrony>` and takes it back off the onsets it measured.
 *
 * It is the least exercised transformer in the package — unregistered until now, with no test
 * and no round-trip case — and the audit found three things in it (issue #45).
 */
describe("InsertAsynchrony", () => {
    /**
     * MSM parts are 1-based on the note and 0-based in a `Scope`, so `part: 1` here means the
     * notes carrying `part: 2`. The reference used to be `part === 1 ? 0 : 1`, which answers
     * "part 1" for everything that is not part 1 — so on a three-staff score part 2 was measured
     * against part 1 and part 0 was ignored, silently.
     */
    test("measures a part against every other part, not against part 1", () => {
        const { mpm } = run([
            note('a0', 1, 0, 0),
            note('b0', 2, 0, 100),
            note('c0', 3, 0, 40),   // scope 2 is `part: 3`; 40 against the median of 0 and 100
            note('a1', 1, 720, 1000),
            note('b1', 2, 720, 1100),
            note('c1', 3, 720, 1040),
        ], 2, 720)

        // Ignoring part 0 entirely would give 40 − 100 = −60.
        expect(offsets(mpm)).toEqual([-10, 0])
    })

    test("a two-part score still measures against the other part", () => {
        const { mpm } = run([
            note('a0', 1, 0, 0),
            note('b0', 2, 0, 30),
            note('a1', 1, 720, 1000),
            note('b1', 2, 720, 1030),
        ], 1, 720)

        expect(offsets(mpm)).toEqual([30, 0])
    })

    /**
     * The shift used to be read off `chord.at(0)`, the first note in whatever order `asChords`
     * happened to group them — so the spread *within* a chord decided a measurement that is
     * about the distance *between* the parts.
     */
    test("takes each chord's median onset rather than its first note", () => {
        const { mpm } = run([
            note('a0', 1, 0, 0),
            note('a0b', 1, 0, 300),   // a wide roll inside the reference part; median 150
            note('a0c', 1, 0, 150),
            note('b0', 2, 0, 200),
            note('a1', 1, 720, 1000),
            note('a1b', 1, 720, 1300),
            note('a1c', 1, 720, 1150),
            note('b1', 2, 720, 1200),
        ], 1, 720)

        // First-note order would have given 200 − 0 = 200.
        expect(offsets(mpm)).toEqual([50, 0])
    })

    test("takes the measured shift back off the onsets it measured", () => {
        const { msm } = run([
            note('a0', 1, 0, 0),
            note('b0', 2, 0, 30),
            note('a1', 1, 720, 1000),
            note('b1', 2, 720, 1030),
        ], 1, 720)

        const shifted = msm.allNotes.filter(n => n.part === 2)
        expect(shifted.map(n => n['midi.onset'])).toEqual([0, 1000])
        // The reference part is left where it was.
        expect(msm.allNotes.filter(n => n.part === 1).map(n => n['midi.onset'])).toEqual([0, 1000])
    })

    /**
     * `shifts` is empty whenever no date in the range is sounded by both this part and the rest.
     * `0 / 0` then went into `@milliseconds.offset` *and* into every onset in range, after which
     * every tick computation downstream was NaN. `view.ts` refuses to write a non-finite
     * attribute now, so it throws rather than corrupts — which is not an answer either.
     */
    test("writes nothing when no date pairs up, rather than NaN", () => {
        const { msm, mpm } = run([
            note('a0', 1, 0, 0),
            note('b0', 2, 720, 1000),
        ], 1, 720)

        expect(mpm.getInstructions('asynchrony')).toHaveLength(0)
        expect(msm.allNotes.map(n => n['midi.onset'])).toEqual([0, 1000])
    })

    test("writes nothing when the part is not in the score at all", () => {
        const { mpm } = run([
            note('a0', 1, 0, 0),
            note('a1', 1, 720, 1000),
        ], 4, 720)

        expect(mpm.getInstructions('asynchrony')).toHaveLength(0)
    })

    test("only the chords inside the range are measured and moved", () => {
        const { msm, mpm } = run([
            note('a0', 1, 0, 0),
            note('b0', 2, 0, 30),
            note('a1', 1, 720, 1000),
            note('b1', 2, 720, 1500),   // outside the range
        ], 1, 360)

        expect(offsets(mpm)).toEqual([30, 0])
        expect(msm.allNotes.find(n => n['xml:id'] === 'b1')!['midi.onset']).toBe(1500)
    })
})
