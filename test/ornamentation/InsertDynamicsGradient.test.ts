// @vitest-environment jsdom

import { expect, test } from 'vitest'
import { MSM } from '../../src/msm'
import { MPM, Ornament } from '../../src/mpm'
import { InsertDynamicsGradient } from '../../src/transformers'

/**
 * Quickly generates a simple MSM note
 * @note Example for duration and position: 0.25 = quarter note etc.
 */
const generateNote = (position: number, duration: number, pitch: number, part: number = 1) => ({
    'xml:id': `n_${part}_${pitch}`,
    date: position * 4 * 720,
    part: part,
    pitchname: 'g',
    octave: 4,
    duration: duration * 4 * 720,
    accidentals: 0,
    'midi.pitch': pitch
})

/** A rolled chord whose second note is the louder one. */
const msmFixture = () => new MSM([
    {
        ...generateNote(0, 0.25, 60),
        'midi.onset': 1,
        'midi.duration': 1,
        'midi.velocity': 50
    },
    {
        ...generateNote(0, 0.25, 67),
        'midi.onset': 1.1,
        'midi.duration': 1,
        'midi.velocity': 100
    }],
    { numerator: 1, denominator: 4 })

/** Call the protected `transform` method for testing */
const callTransform = (transformer: InsertDynamicsGradient, msm: MSM, mpm: MPM) => {
    type Transformable = { transform(msm: MSM, mpm: MPM): void }
    ;(transformer as unknown as Transformable).transform(msm, mpm)
}

test('it fits a rising chord to the crescendo gradient and flattens the velocities', () => {
    const msm = msmFixture()
    const mpm = new MPM()

    callTransform(new InsertDynamicsGradient({
        scope: 'global',
        crescendo: { from: -1, to: 0 },
        decrescendo: { from: 0, to: -1 },
        sortVelocities: true,
    }), msm, mpm)

    const ornaments = mpm.getInstructions<Ornament>('ornament', 'global')
    expect(ornaments).toHaveLength(1)
    expect(ornaments[0]['transition.from']).toBe(-1)
    expect(ornaments[0]['transition.to']).toBe(0)
    expect(ornaments[0].scale).toBe(50)

    // The gradient having explained the spread, every note carries the same velocity.
    expect(msm.allNotes.map(n => n['midi.velocity'])).toEqual([100, 100])
})

test('it works with the constructor defaults, which do not sort velocities', () => {
    const msm = msmFixture()
    const mpm = new MPM()

    // `sortVelocities: false` used to leave the gradient unchosen and throw here.
    // See old-bugs.md.
    callTransform(new InsertDynamicsGradient(), msm, mpm)

    const ornaments = mpm.getInstructions<Ornament>('ornament', 'global')
    expect(ornaments).toHaveLength(1)
    expect(ornaments[0]['transition.from']).toBe(-1)
    expect(ornaments[0]['transition.to']).toBe(0)
})

test('a chord whose notes are equally loud gets no gradient', () => {
    const msm = msmFixture()
    msm.allNotes[1]['midi.velocity'] = 50
    const mpm = new MPM()

    callTransform(new InsertDynamicsGradient(), msm, mpm)

    expect(mpm.getInstructions<Ornament>('ornament', 'global')).toHaveLength(0)
})
