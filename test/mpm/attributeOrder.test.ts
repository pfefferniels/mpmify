import { describe, expect, test } from "vitest"
import { MPM, Tempo } from "../../src/mpm"

/** The attribute names of the first `<tempo>`, in serialized order. */
const tempoAttributeOrder = (mpm: MPM) => {
    const tag = mpm.toXML().match(/<tempo [^>]*\/>/)![0]
    return [...tag.matchAll(/([a-zA-Z:.]+)=/g)].map(m => m[1])
}

describe('editing an instruction through a view', () => {
    test('leaves the attribute where it was in the document', () => {
        const mpm = new MPM()
        const tempo = mpm.insertInstruction<Tempo>({
            type: 'tempo',
            'xml:id': 't1',
            date: 0,
            bpm: 120,
            beatLength: 0.25,
        }, 'global')

        const before = tempoAttributeOrder(mpm)
        expect(before).toEqual(['date', 'xml:id', 'bpm', 'beatLength'])

        tempo.bpm = 132

        // espressivo's `Element.addAttribute` is remove-then-append, so writing through it
        // would move `bpm` to the end and make every edited document differ from its source by
        // attribute order alone.
        expect(tempoAttributeOrder(mpm)).toEqual(before)
        expect(mpm.toXML()).toContain("bpm=\"132\"")
    })

    // `xml:id` is stored namespaced, so it only stays put if the lookup matches the qualified
    // name rather than the local one.
    test('holds for the namespaced xml:id too', () => {
        const mpm = new MPM()
        const tempo = mpm.insertInstruction<Tempo>({
            type: 'tempo',
            'xml:id': 't1',
            date: 0,
            bpm: 120,
            beatLength: 0.25,
        }, 'global')

        tempo['xml:id'] = 't2'

        expect(tempoAttributeOrder(mpm)).toEqual(['date', 'xml:id', 'bpm', 'beatLength'])
        expect(mpm.toXML()).toContain('xml:id="t2"')
    })
})
