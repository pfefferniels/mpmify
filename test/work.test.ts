import { describe, expect, test } from "vitest"
import { exportWork, importWork, sourcesOf, type WorkFile } from "../src/Work"
import { InsertRubato, MakeChoice } from "../src/transformers"
import "../src/transformers/Order"

const work = { name: 'Träumerei', mei: 'roll.mei', mpm: 'performance.mpm' }

const chain = () => {
    const choice = new MakeChoice({ scope: 'global', prefer: 'take2' })
    const rubato = new InsertRubato({ scope: 'global', date: 0, length: 2880 })
    // What a run would have left behind. `exportWork` reads it to fill in a segment's elements.
    rubato.created = ['rubato_0', 'rubato_720']
    return { choice, rubato }
}

describe('the work file', () => {
    test('records every call with the options it ran with', () => {
        const { choice, rubato } = chain()
        const file = JSON.parse(exportWork(work, [choice, rubato])) as WorkFile

        expect(file.provenance.map(call => call.name)).toEqual(['MakeChoice', 'InsertRubato'])
        expect(file.provenance[1].options).toMatchObject({ date: 0, length: 2880 })
        expect(file.provenance[1].id).toBe(rubato.id)
    })

    test('fills a segment in with the elements its calls produced', () => {
        const { choice, rubato } = chain()
        const file = JSON.parse(exportWork(work, [choice, rubato], [
            { id: 'segment-1', note: 'Hinspielen auf 1', calls: [rubato.id] },
        ])) as WorkFile

        expect(file.segments).toEqual([{
            id: 'segment-1',
            note: 'Hinspielen auf 1',
            calls: [rubato.id],
            elements: ['rubato_0', 'rubato_720'],
        }])
    })

    test('comes back as the chain it went out as', () => {
        const { choice, rubato } = chain()
        const json = exportWork(work, [choice, rubato], [
            { id: 'segment-1', calls: [rubato.id] },
        ])

        const imported = importWork(json)

        expect(imported.transformers.map(t => t.name)).toEqual(['MakeChoice', 'InsertRubato'])
        expect(imported.transformers[1].id).toBe(rubato.id)
        expect(imported.transformers[1].options).toEqual(rubato.options)
        expect(imported.segments[0].calls).toEqual([rubato.id])
        expect(imported.segments[0].elements).toEqual(['rubato_0', 'rubato_720'])
    })

    test('names the recordings the chain chose between', () => {
        const { choice, rubato } = chain()
        expect(sourcesOf([choice, rubato])).toEqual(['take2'])
    })

    test('says which part of a file it could not read', () => {
        expect(() => importWork('{}')).toThrow(/provenance/)
        expect(() => importWork(JSON.stringify({ provenance: [{}] }))).toThrow(/no name/)
        expect(() => importWork(JSON.stringify({ provenance: [], segments: [{}] })))
            .toThrow(/no "calls" list/)
    })
})
