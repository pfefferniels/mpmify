import { describe, expect, test } from "vitest"
import { MSM, MsmNote } from "../../src/msm"

const note = (id: string, part: number, date: number): MsmNote => ({
    'xml:id': id,
    part,
    date,
    duration: 720,
    pitchname: 'g',
    accidentals: 0,
    octave: 4,
    'midi.pitch': 67,
} as MsmNote)

/** Each `<part>`'s `@number`, in document order. */
const partNumbers = (xml: string) =>
    [...xml.matchAll(/<part [^>]*number='(\d+)'/g)].map(m => m[1])

/** Every note that survived serialization, in document order. */
const noteIds = (xml: string) =>
    [...xml.matchAll(/<note xml:id='(n\d+)'/g)].map(m => m[1])

describe('MSM.serialize', () => {
    // Issue #34. The part list was `Array.from(Array(2).keys())` — exactly two, always — so a
    // third voice never reached the renderer and nothing said so.
    test('writes one part per part the notes use, not two', () => {
        const msm = new MSM([
            note('n1', 1, 0),
            note('n2', 2, 0),
            note('n3', 3, 0),
            note('n4', 4, 0),
        ])

        const xml = msm.serialize(false)!

        expect(partNumbers(xml)).toEqual(['1', '2', '3', '4'])
        expect(noteIds(xml)).toEqual(['n1', 'n2', 'n3', 'n4'])
    })

    test('a single-part score writes one part, not an empty second one', () => {
        const xml = new MSM([note('n1', 1, 0), note('n2', 1, 720)]).serialize(false)!

        expect(partNumbers(xml)).toEqual(['1'])
        expect(noteIds(xml)).toEqual(['n1', 'n2'])
    })

    test('a gap in the part numbering keeps each part at its own number', () => {
        const xml = new MSM([note('n1', 1, 0), note('n3', 3, 0)]).serialize(false)!

        expect(partNumbers(xml)).toEqual(['1', '3'])
        expect(noteIds(xml)).toEqual(['n1', 'n3'])
    })
})

describe('MSM.serialize pedals', () => {
    // espressivo looks for the pedals in the global `<dated>`; mpmify used to write the
    // `<pedalMap>` one level up, so the renderer never saw a single pedal.
    test('writes the pedalMap inside <dated>, where the renderer looks for it', () => {
        const msm = new MSM([note('n1', 1, 0)])
        msm.pedals = [{
            'xml:id': 'p1',
            date: 0,
            'date.end': 720,
            type: 'sustain',
            'midi.onset': 0,
            'midi.duration': 1,
        }]

        const xml = msm.serialize(false)!
        const dated = xml.slice(xml.indexOf('<dated>'), xml.indexOf('</dated>'))

        expect(dated).toContain('<pedalMap>')
        expect(dated).toContain("xml:id='p1'")
    })
})
