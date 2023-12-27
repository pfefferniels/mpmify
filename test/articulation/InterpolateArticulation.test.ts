// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM } from "../../src/msm"
import { Articulation, MPM } from "mpm-ts"
import { InterpolateArticulation } from "../../src/transformers"

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
        ...generateNote(0, 0.25),   // duration = 720 ticks
        'midi.onset': 1,
        'midi.duration': 1,
        'midi.velocity': 50,
        'tickDuration': 360         // real duration = 360 ticks
    }],
    { numerator: 1, denominator: 4 })


test('correctly interpolates articulation', () => {
    // Arrange
    const mpm = new MPM()

    // Act
    const transformer = new InterpolateArticulation({
        part: 'global', 
        relativeDurationPrecision: 0,
        relativeDurationTolerance: 0
    })
    transformer.transform(msmFixture, mpm)

    // Assert
    const articulations = mpm.getInstructions<Articulation>('articulation', 'global')

    expect(articulations.map(artic => [artic.date, artic.relativeDuration]))
        .toEqual([
            [0, 0.5]
        ])
})
