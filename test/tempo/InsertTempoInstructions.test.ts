// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM } from "../../src/msm"
import { MPM, Tempo } from 'mpm-ts'
import { InsertTempoInstructions } from "../../src/transformers/tempo/InsertTempoInstructions"

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

const msmFixture = new MSM(
    [
        {
            ...generateNote(0, 0.5),    // half note ...
            'midi.onset': 1,
            'midi.duration': 2,         // lasting 2 seconds
            'midi.velocity': 100,
            relativeVolume: 0
        },
        {
            ...generateNote(0.5, 0.25), // quarter note ...
            'midi.onset': 3,
            'midi.duration': 1,         // lasting 1 second
            'midi.velocity': 100,
            relativeVolume: 0
        },
        {
            ...generateNote(0.75, 0.125),   // eighth note ...
            'midi.onset': 4,
            'midi.duration': 0.5,           // lasting half a second 
            'midi.velocity': 100,
            relativeVolume: 0
        },
        {
            ...generateNote(0.875, 0.125),  // eighth note ...
            'midi.onset': 4.5,
            'midi.duration': 0.5,           // lasting half a second 
            'midi.velocity': 100,
            relativeVolume: 0
        }
    ],
    { numerator: 4, denominator: 4 }
)


test('It inserts the right tempo instructions', () => {
    // Arrange
    const mpm = new MPM()

    // Act
    const tempo = new InsertTempoInstructions({
        part: 'global',
        markers: [{
            date: 0,
            beatLength: 720
        }],
        silentOnsets: []
    })
    tempo.transform(msmFixture, mpm)

    // Assert
    const tempos = mpm.getInstructions<Tempo>('tempo', 'global')

    console.log('tempi=', tempos)

    expect(tempos).toHaveLength(1)
    expect(tempos[0].bpm).toEqual(60)
    expect(tempos[0].beatLength).toEqual(0.25)
})
