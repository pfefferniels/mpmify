// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM } from "../src/msm"
import { MPM, Tempo } from 'mpm-ts'
import { InsertTempoInstructions } from "../src/transformers/InsertTempoInstructions"

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
            'midi.duration': 2,         // lasting 2 seconds (i.e. 60bpm)
            'midi.velocity': 100
        },
        {
            ...generateNote(0.5, 0.25), // quarter note ...
            'midi.onset': 3,            
            'midi.duration': 1,         // lasting 1 seconds (i.e. 60bpm too)
            'midi.velocity': 100
        },
        {
            ...generateNote(0.75, 0.25),
            'midi.onset': 4,
            'midi.duration': 1,
            'midi.velocity': 100
        }
    ],
    { numerator: 4, denominator: 4 }
)


test('It inserts the right tempo instructions using beat length = denominator', () => {
    // Arrange
    const mpm = new MPM()

    // Act
    const tempo = new InsertTempoInstructions({
        part: 'global',
        beatLength: 'denominator'
    })
    tempo.transform(msmFixture, mpm)

    // Assert
    const tempos = mpm.getInstructions<Tempo>('tempo', 'global')

    expect(tempos.every(tempo => tempo.bpm === 60)).toBeTruthy()
    expect(tempos.every(tempo => tempo.beatLength === 0.25)).toBeTruthy()
})

test('It inserts the right tempo instructions using beat length = everything', () => {
    // Arrange
    const mpm = new MPM()

    // Act
    const tempo = new InsertTempoInstructions({
        part: 'global',
        beatLength: 'everything'
    })
    tempo.transform(msmFixture, mpm)

    // Assert
    const tempos = mpm.getInstructions<Tempo>('tempo', 'global')

    expect(tempos.map(tempo => tempo.bpm)).toEqual([30, 60, 60])
    expect(tempos.map(tempo => tempo.beatLength)).toEqual([0.5, 0.25, 0.25])
})
