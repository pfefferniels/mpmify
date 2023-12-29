// @vitest-environment jsdom

import { expect, test } from 'vitest'
import { MSM } from '../../src/msm'
import { MPM, Ornament } from 'mpm-ts'
import { InsertDynamicsGradient } from '../../src/transformers'

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
        ...generateNote(0, 0.25),
        'midi.onset': 1,
        'midi.duration': 1,
        'midi.velocity': 100
    }],
    { numerator: 1, denominator: 4 })


test('Inserts a crescendo gradient', () => {
    // Arrange
    const mpm = new MPM()

    // Act
    const transformer = new InsertDynamicsGradient()
    transformer.transform(msmFixture, mpm)

    // Assert
    const arpeggios = mpm.getInstructions<Ornament>('ornament', 'global')
    expect(arpeggios[0].gradient).toEqual('crescendo')
})
