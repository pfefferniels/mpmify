// @vitest-environment jsdom

import { describe, expect, test } from "vitest"
import { InstructionOptions, MPM } from "../../src/mpm"

/**
 * mpmify never authors a non-finite attribute; it still reads one.
 *
 * `String(NaN)` is `'NaN'`, and `'NaN'` is a perfectly well-formed attribute value — the
 * document stays schema-valid while saying something no renderer can act on, and the fit that
 * produced it is several steps away by the time anyone notices. `MPM.insertInstruction` and
 * `updateInstruction` refuse instead.
 *
 * The guard is mpmify's, not espressivo's, and that is deliberate: espressivo's interior is
 * frozen at logs-and-returns (its RULE E1), so throwing there would be a divergence from the
 * library it is held equivalent to. Here it is one step from where the number was computed.
 *
 * Reading is deliberately not symmetrical: files written before the guard existed contain such
 * values, and refusing to parse them would make old work unopenable rather than diagnosable.
 */

const tempo = (bpm: number): InstructionOptions<'tempo'> => ({
    id: 'tempo_0',
    date: 0,
    bpm,
    beatLength: 0.25,
})

describe('a non-finite number never reaches the document', () => {
    test('inserting NaN throws, and the message names the attribute', () => {
        const mpm = new MPM()

        expect(() => mpm.insertInstruction('tempo', tempo(NaN), 'global'))
            .toThrow(/<tempo @bpm>="NaN"/)
    })

    test('an infinity is refused too', () => {
        const mpm = new MPM()

        expect(() => mpm.insertInstruction('tempo', tempo(Infinity), 'global'))
            .toThrow(/must be a finite number/)
    })

    test('patching NaN throws rather than corrupting the element', () => {
        const mpm = new MPM()
        const inserted = mpm.insertInstruction('tempo', tempo(60), 'global')

        expect(() => mpm.updateInstruction(inserted, { bpm: NaN })).toThrow(/<tempo @bpm>/)
        expect(mpm.getInstructions('tempo', 'global')[0].bpm).toBe(60)
    })

    test('finite numbers are untouched, including zero and negatives', () => {
        const mpm = new MPM()
        const inserted = mpm.insertInstruction('tempo', tempo(60), 'global')

        mpm.updateInstruction(inserted, { transitionTo: 0, meanTempoAt: -0.5 })

        expect(mpm.toXML()).toContain('transition.to="0"')
        expect(mpm.toXML()).toContain('meanTempoAt="-0.5"')
    })

    test('a NaN already in a document still reads back as NaN', () => {
        const mpm = new MPM()
        const inserted = mpm.insertInstruction('tempo', { ...tempo(60), meanTempoAt: 0.5 }, 'global')

        // What a file written by an earlier version looks like once parsed. Going through the
        // element rather than the API is the only way to get one in now — which is the point.
        inserted.element.getAttribute('meanTempoAt')?.setValue('NaN')

        expect(mpm.getInstructions('tempo', 'global')[0].meanTempoAt).toBeNaN()
    })

    test('@bpm is number-or-name, so a NaN there comes back as the string "NaN"', () => {
        const mpm = new MPM()
        const inserted = mpm.insertInstruction('tempo', tempo(60), 'global')

        // Not a curiosity: `@bpm` may name a tempo ("Allegro"), so espressivo's reader keeps
        // anything that is not a round-tripping number as text. A NaN written here would not
        // even survive as a number — it would come back as a tempo *named* "NaN" — which is the
        // second reason the guard belongs on the write and not on the read.
        inserted.element.getAttribute('bpm')?.setValue('NaN')

        expect(mpm.getInstructions('tempo', 'global')[0].bpm).toBe('NaN')
    })
})
