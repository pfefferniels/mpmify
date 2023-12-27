// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM } from "../../src/msm"
import { Dynamics, MPM } from 'mpm-ts'
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

const msmFixture = new MSM([
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

test('It inserts correct dynamics instructions', () => {
    // Arrange
    const mpm = new MPM()

    // Act
    const transformer = new InsertDynamicsInstructions({
        part: 'global',
        beatLength: 'denominator'
    })
    transformer.transform(msmFixture, mpm)

    // Assert
    const dynamics = mpm.getInstructions<Dynamics>('dynamics', 'global')

    expect(dynamics.map(dynamics => [dynamics.date, dynamics.volume]))
        .toEqual([
            [0, 50],
            [720, 75],
            [1440, 100]
        ])
})
