// @vitest-environment jsdom

import { describe, expect, test } from "vitest"
import { MPM, Tempo, elementOf } from "../../src/mpm"

/**
 * mpmify never authors a non-finite attribute; it still reads one.
 *
 * `String(NaN)` is `'NaN'`, and `'NaN'` is a perfectly well-formed attribute value — the
 * document stays schema-valid while saying something no renderer can act on, and the fit that
 * produced it is several steps away by the time anyone notices. `writeValue` refuses instead.
 *
 * Reading is deliberately not symmetrical: files written before the guard existed contain such
 * values, and refusing to parse them would make old work unopenable rather than diagnosable.
 */

const tempo = (bpm: number): Tempo => ({
    type: 'tempo',
    'xml:id': 'tempo_0',
    date: 0,
    bpm,
    beatLength: 0.25,
})

describe('a non-finite number never reaches the document', () => {
    test('inserting NaN throws, and the message names the attribute', () => {
        const mpm = new MPM()

        expect(() => mpm.insertInstruction(tempo(NaN), 'global'))
            .toThrow(/<tempo @bpm>="NaN"/)
    })

    test('an infinity is refused too', () => {
        const mpm = new MPM()

        expect(() => mpm.insertInstruction(tempo(Infinity), 'global'))
            .toThrow(/must be a finite number/)
    })

    test('writing NaN through a view throws rather than corrupting the element', () => {
        const mpm = new MPM()
        const inserted: Tempo = mpm.insertInstruction(tempo(60), 'global')

        expect(() => { inserted.bpm = NaN }).toThrow(/<tempo @bpm>/)
        expect(mpm.getInstructions('tempo', 'global')[0].bpm).toBe(60)
    })

    test('finite numbers are untouched, including zero and negatives', () => {
        const mpm = new MPM()
        const inserted: Tempo = mpm.insertInstruction(tempo(60), 'global')

        inserted['transition.to'] = 0
        inserted.meanTempoAt = -0.5

        expect(mpm.toXML()).toContain('transition.to="0"')
        expect(mpm.toXML()).toContain('meanTempoAt="-0.5"')
    })

    test('a NaN already in a document still reads back as NaN', () => {
        const mpm = new MPM()
        const inserted: Tempo = mpm.insertInstruction(tempo(60), 'global')
        inserted.meanTempoAt = 0.5

        // What a file written by an earlier version looks like once parsed. Going through the
        // element rather than the view is the only way to get one in now — which is the point.
        elementOf(inserted)?.getAttribute('meanTempoAt')?.setValue('NaN')

        expect(mpm.getInstructions('tempo', 'global')[0].meanTempoAt).toBeNaN()
    })

    test('@bpm is numberOrString, so a NaN there would come back as the string "NaN"', () => {
        const mpm = new MPM()
        const inserted: Tempo = mpm.insertInstruction(tempo(60), 'global')

        // Not a curiosity: `@bpm` may name a tempo ("Allegro"), so `readValue` keeps anything
        // that is not a finite number as text. A NaN written here would not even survive as a
        // number — it would come back as a tempo *named* "NaN" — which is the second reason the
        // guard belongs on the write and not on the read.
        elementOf(inserted)?.getAttribute('bpm')?.setValue('NaN')

        expect(mpm.getInstructions('tempo', 'global')[0].bpm).toBe('NaN')
    })
})
