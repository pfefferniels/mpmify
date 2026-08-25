// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM } from "../../src/msm"
import { Dynamics, MPM } from "../../src/mpm"
import { InsertDynamicsInstructions } from "../../src/transformers"
import { performMsmToData } from "espressivo"

/**
 * Quickly generates a simple MSM note
 * @note Example for duration and position: 0.25 = quarter note etc.
 */
const generateNote = (position: number, duration: number, part: number = 1) => ({
    'xml:id': `n_${part}_${position}`,
    date: position * 4 * 720,
    part: part,
    pitchname: 'g',
    octave: 4,
    duration: duration * 4 * 720,
    accidentals: 0,
    'midi.pitch': 67
})

const msmFixture = () => new MSM([
    {
        ...generateNote(0, 0.25),
        'midi.onset': 1,
        'midi.duration': 1,
        'midi.velocity': 50
    },
    {
        ...generateNote(0.25, 0.25),
        'midi.onset': 2,
        'midi.duration': 2,
        'midi.velocity': 75
    },
    {
        ...generateNote(0.5, 0.25),
        'midi.onset': 3,
        'midi.duration': 3,
        'midi.velocity': 100
    }],
    { numerator: 3, denominator: 4 })

/** Call the protected `transform` method for testing */
const callTransform = (transformer: InsertDynamicsInstructions, msm: MSM, mpm: MPM) => {
    type Transformable = { transform(msm: MSM, mpm: MPM): void }
    ;(transformer as unknown as Transformable).transform(msm, mpm)
}

const run = (msm: MSM, mpm: MPM) => callTransform(new InsertDynamicsInstructions({
    scope: 'global',
    from: 0,
    to: msm.lastDate(),
    phantomVelocities: new Map(),
}), msm, mpm)

test('it fits one <dynamics> across the range, from the first velocity to the last', () => {
    const msm = msmFixture()
    const mpm = new MPM()

    run(msm, mpm)

    const dynamics = mpm.getInstructions<Dynamics>('dynamics', 'global')
    expect(dynamics[0].date).toBe(0)
    expect(dynamics[0].volume).toBe(50)
    expect(dynamics[0]['transition.to']).toBe(100)
})

test('it closes the fitted transition, which is what makes the transition render', () => {
    const msm = msmFixture()
    const mpm = new MPM()

    run(msm, mpm)

    // An open `transition.to` is not a curve stretched to the end of the piece: the renderer
    // drops the transition and holds `volume`. So the fit writes the instruction that ends its
    // span, holding the volume the curve arrives at. See issue #24.
    const dynamics = mpm.getInstructions<Dynamics>('dynamics', 'global')
    expect(dynamics).toHaveLength(2)
    expect(dynamics[1].date).toBe(msm.lastDate())
    expect(dynamics[1].volume).toBe(100)
    expect(dynamics[1]['transition.to']).toBeUndefined()
})

test('it leaves the residual velocity the curve does not explain on every note', () => {
    const msm = msmFixture()
    const mpm = new MPM()

    run(msm, mpm)

    // The reduction: recorded minus explained, left on the note for the next transformer.
    for (const note of msm.allNotes) {
        expect(note.absoluteVelocityChange).toBeDefined()
    }

    // The curve starts at the instruction's own volume, so the note under it is fully
    // explained. What the curve misses in between is exactly what survives. The tail no longer
    // does: closing the transition makes the span the residual is measured over the same span
    // the curve was fitted over (see old-bugs.md §1, and issue #24).
    expect(msm.allNotes[0].absoluteVelocityChange).toBeCloseTo(0, 5)
    expect(msm.allNotes[msm.allNotes.length - 1].absoluteVelocityChange).toBeCloseTo(0, 5)
})

test('the fitting window is not written into the document', () => {
    const msm = msmFixture()
    const mpm = new MPM()

    run(msm, mpm)

    // `endDate` is a working field of the fit, not an MPM attribute. See old-bugs.md.
    expect(mpm.toXML()).not.toContain('endDate')
})

test('the fitted curve is what espressivo renders', () => {
    const msm = msmFixture()
    const mpm = new MPM()

    run(msm, mpm)

    // The render is the point of the closing instruction: left open, the transition is dropped
    // and every note comes out at the starting volume. See issue #24.
    const data = performMsmToData({ msm: msm.serialize(false), mpm: mpm.toXML() })
    const velocities = data.parts.flatMap(part => part.notes).map(note => note.velocity)

    expect(velocities).toHaveLength(3)
    expect(velocities[0]).toBe(50)
    expect(velocities[2]).toBe(100)
    expect(velocities[1]).toBeGreaterThan(velocities[0])
    expect(velocities[1]).toBeLessThan(velocities[2])
})
