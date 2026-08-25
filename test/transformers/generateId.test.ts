// @vitest-environment jsdom

import { describe, expect, test } from "vitest"
import { MPM, Tempo } from "../../src/mpm"
import { generateId } from "../../src/transformers/Transformer"

const tempo = (date: number, id: string): Tempo => ({
    type: 'tempo', 'xml:id': id, date, bpm: 60, beatLength: 0.25,
})

/**
 * An `xml:id` has to be free, and the suffix used to be the *count* of instructions at the date
 * rather than the first free index. Counting is only the same thing while nothing has ever been
 * removed — and `ApproximateLogarithmicTempo` removes and re-inserts on every refit, so it is
 * ordinary operation (issue #30).
 *
 * A collision is not cosmetic: `MPMRecording.created` records ids and
 * `AbstractTransformer.insertMetadata` resolves them back through `findInstructionById` to write
 * `@corresp`, so a duplicate attributes an argumentation to the wrong element silently.
 */
describe("generateId", () => {
    test("takes the bare name when the date holds nothing", () => {
        expect(generateId('tempo', 0, new MPM())).toBe('tempo_0')
    })

    test("counts up while ids are taken", () => {
        const mpm = new MPM()
        mpm.insertInstruction(tempo(0, 'tempo_0'), 'global')
        expect(generateId('tempo', 0, mpm)).toBe('tempo_0_1')

        mpm.insertInstruction({ ...tempo(0, 'tempo_0_1'), noteid: '#a' }, 'global')
        expect(generateId('tempo', 0, mpm)).toBe('tempo_0_2')
    })

    test("does not reissue an id a removal left a hole before", () => {
        const mpm = new MPM()
        mpm.insertInstruction({ ...tempo(0, 'tempo_0_1'), noteid: '#a' }, 'global')
        mpm.insertInstruction({ ...tempo(0, 'tempo_0_2'), noteid: '#b' }, 'global')

        // Two instructions at the date, so counting answers `tempo_0_2` — which is taken.
        expect(generateId('tempo', 0, mpm)).toBe('tempo_0')
    })

    test("skips over a hole in the middle of the run", () => {
        const mpm = new MPM()
        mpm.insertInstruction(tempo(0, 'tempo_0'), 'global')
        mpm.insertInstruction({ ...tempo(0, 'tempo_0_2'), noteid: '#b' }, 'global')

        expect(generateId('tempo', 0, mpm)).toBe('tempo_0_1')
    })

    test("a different date is a different name, not a different suffix", () => {
        const mpm = new MPM()
        mpm.insertInstruction(tempo(0, 'tempo_0'), 'global')

        expect(generateId('tempo', 720, mpm)).toBe('tempo_720')
    })
})
