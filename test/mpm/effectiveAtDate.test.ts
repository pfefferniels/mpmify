// @vitest-environment jsdom

import { describe, expect, test } from "vitest"
import { AccentuationPatternDef, MPM, Rubato, Tempo } from "../../src/mpm"
import { PULSES_PER_WHOLE } from "../../src/ppq"

const tempo = (date: number, bpm: number): Tempo => ({
    type: 'tempo', 'xml:id': `tempo_${date}`, date, bpm, beatLength: 0.25,
})

const rubato = (date: number, over: Partial<Rubato> = {}): Rubato => ({
    type: 'rubato',
    'xml:id': `rubato_${date}`,
    date,
    frameLength: 720,
    intensity: 1.2,
    ...over,
} as Rubato)

/**
 * "The instructions in force at a date" is a set, and the method now answers with one.
 *
 * It used to answer with a list that could name the same instruction two or three times: one at
 * the requested date was pushed by the exact-date filter and again as the last one still
 * running, and a *looping* rubato covering the date matched two separate `if`s rather than one
 * condition. Every caller takes `[0]`, so nothing was broken — which is exactly why it is worth
 * pinning before someone reads the name and believes it (issue #47).
 */
describe("instructionsEffectiveAtDate", () => {
    test("names an instruction at the requested date once, not twice", () => {
        const mpm = new MPM()
        mpm.insertInstruction(tempo(0, 60), 'global')

        expect(mpm.instructionsEffectiveAtDate(0, 'tempo', 'global')).toHaveLength(1)
    })

    test("a looping rubato covering the date is named once, not three times", () => {
        const mpm = new MPM()
        mpm.insertInstruction(rubato(0, { loop: true }), 'global')

        expect(mpm.instructionsEffectiveAtDate(0, 'rubato', 'global')).toHaveLength(1)
        expect(mpm.instructionsEffectiveAtDate(360, 'rubato', 'global')).toHaveLength(1)
    })

    test("a loop still counts as in force past its own frame", () => {
        const mpm = new MPM()
        mpm.insertInstruction(rubato(0, { loop: true }), 'global')

        expect(mpm.instructionsEffectiveAtDate(2000, 'rubato', 'global')).toHaveLength(1)
    })

    test("a rubato that does not loop stops at the end of its frame", () => {
        const mpm = new MPM()
        mpm.insertInstruction(rubato(0), 'global')

        expect(mpm.instructionsEffectiveAtDate(719, 'rubato', 'global')).toHaveLength(1)
        expect(mpm.instructionsEffectiveAtDate(720, 'rubato', 'global')).toHaveLength(0)
    })

    test("the earlier tempo still running is named, and the later one is not yet", () => {
        const mpm = new MPM()
        mpm.insertInstruction(tempo(0, 60), 'global')
        mpm.insertInstruction(tempo(2880, 90), 'global')

        const effective = mpm.instructionsEffectiveAtDate(1440, 'tempo', 'global')
        expect(effective).toHaveLength(1)
        expect(effective[0].bpm).toBe(60)
    })
})

/**
 * How long an `<accentuationPattern>` covers depends on the metre, which an MPM document does
 * not carry — `@length` is in beats and a beat is `4 * ppq / denominator` ticks, the conversion
 * espressivo's `MetricalAccentuationMap` makes when it renders one. The span used to be spelled
 * `def.length * 720 * 4 / 4`, which is the 4/4 assumption with the denominator's place left in
 * the arithmetic as a cancelling `4 / 4` (issue #42). The caller says which metre it means now,
 * and 4 remains the default.
 */
describe("an accentuation pattern's span", () => {
    const withPattern = (length: number) => {
        const mpm = new MPM()
        mpm.insertDefinition({
            type: 'accentuationPatternDef',
            name: 'downbeat',
            length,
            children: [{ type: 'accentuation', beat: 1, value: 1, 'transition.from': 1, 'transition.to': 0 }],
        } as AccentuationPatternDef, 'global')
        mpm.insertInstruction({
            type: 'accentuationPattern',
            'xml:id': 'accentuationPattern_0',
            date: 0,
            'name.ref': 'downbeat',
            scale: 1,
        }, 'global')
        return mpm
    }

    test("four quarter-note beats reach one whole note", () => {
        const mpm = withPattern(4)
        const justInside = PULSES_PER_WHOLE - 1

        expect(mpm.instructionsEffectiveAtDate(justInside, 'accentuationPattern', 'global')).toHaveLength(1)
        expect(mpm.instructionsEffectiveAtDate(PULSES_PER_WHOLE, 'accentuationPattern', 'global')).toHaveLength(0)
    })

    test("six eighth-note beats reach three quarters, not six", () => {
        const mpm = withPattern(6)
        const barIn68 = PULSES_PER_WHOLE * 6 / 8

        expect(mpm.instructionsEffectiveAtDate(barIn68 - 1, 'accentuationPattern', 'global', 8)).toHaveLength(1)
        expect(mpm.instructionsEffectiveAtDate(barIn68, 'accentuationPattern', 'global', 8)).toHaveLength(0)

        // Read as quarters — the old, unconditional assumption — the same pattern claims twice
        // the span it has.
        expect(mpm.instructionsEffectiveAtDate(barIn68, 'accentuationPattern', 'global')).toHaveLength(1)
    })
})
