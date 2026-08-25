// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM } from "../../src/msm"
import { Dynamics, MPM } from "../../src/mpm"
import { InsertDynamicsInstructions } from "../../src/transformers"

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


// The closing instruction (issue #24) is now checked structurally on *every* fitted MPM the
// round-trip suite produces, rather than on this one fixture: see the 'every transition is
// closed' invariant in test/roundtrip/invariants.ts.

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


// Superseded by test/roundtrip: 'dynamics: linear crescendo 40 to 100' renders the fit and
// measures the velocity error against the performance it was fitted to, which is strictly
// stronger than asserting the middle note lies between the outer two.
