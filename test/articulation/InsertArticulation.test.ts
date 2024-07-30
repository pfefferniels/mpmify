// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM } from "../../src/msm"
import { Articulation, MPM } from "mpm-ts"
import { InsertArticulation } from "../../src/transformers"

/**
 * Quickly generates a simple MSM note
 * @note Example for duration and position: 0.25 = quarter note etc.
 */
const generateNote = (position: number, duration: number, id: string, part: number = 1) => ({
    'xml:id': id,
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
        ...generateNote(0, 0.25, 'note0'),   // duration = 720 ticks
        'midi.onset': 1,
        'midi.duration': 1,
        'midi.velocity': 50,
        'tickDuration': 360,         // real duration = 360 ticks,
    },
    {
        ...generateNote(0, 0.25, 'note1'),   // duration = 720 ticks
        'midi.onset': 1,
        'midi.duration': 1,
        'midi.velocity': 50,
        'tickDuration': 1440,         // real duration = 360 ticks,
        relativeVolume: -10,
    }],
    { numerator: 1, denominator: 4 })


test('correctly interpolates articulation', () => {
    // Arrange
    const mpm = new MPM()

    // Act
    const transformer = new InsertArticulation({
        scope: 'global', 
    })
    transformer.transform(msmFixture, mpm)

    // Assert
    const articulations = mpm.getInstructions<Articulation>('articulation', 'global')

    expect(articulations.map(artic => [artic.noteid, artic.relativeDuration, artic.relativeVelocity]))
        .toEqual([
            ['#note0', 0.5, undefined],
            ['#note1', 2, -10],
        ])
})
