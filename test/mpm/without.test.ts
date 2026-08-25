import { describe, expect, test } from "vitest"
import { MPM } from "../../src/mpm"

const populated = () => {
    const mpm = new MPM()
    mpm.insertInstruction('tempo', { id: 't1', date: 0, bpm: 120, beatLength: 0.25 }, 'global')
    mpm.insertInstruction('dynamics', { id: 'd1', date: 0, volume: 64 }, 'global')
    mpm.insertInstruction('dynamics', { id: 'd2', date: 720, volume: 90 }, 1)
    return mpm
}

describe('MPM.without', () => {
    test('drops the named maps in every scope', () => {
        const probe = populated().without(['dynamics'])

        expect(probe.getInstructions('dynamics')).toHaveLength(0)
        expect(probe.getInstructions('tempo')).toHaveLength(1)
        expect(probe.toXML()).not.toContain('dynamicsMap')
        expect(probe.toXML()).toContain('tempoMap')
    })

    test('leaves the document it was taken from untouched', () => {
        const mpm = populated()
        const before = mpm.toXML()

        mpm.without(['dynamics', 'tempo'])

        expect(mpm.toXML()).toEqual(before)
        expect(mpm.getInstructions('dynamics')).toHaveLength(2)
        expect(mpm.getInstructions('tempo')).toHaveLength(1)
    })

    test('an empty list is a faithful copy', () => {
        const mpm = populated()
        expect(mpm.without([]).toXML()).toEqual(mpm.toXML())
    })
})
