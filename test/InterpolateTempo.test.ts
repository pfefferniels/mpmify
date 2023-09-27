// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM } from "../src/msm"
import { MPM, Tempo } from 'mpm-ts'
import { InterpolateTempoMap } from "../src/transformers/InterpolateTempoMap"

const generateQuarterNote = (part: number, n: number) => ({
    'xml:id': `n_${part}_${n}`,
    date: 720 * n,
    part: part,
    pitchname: 'g',
    octave: 4,
    duration: 720,
    accidentals: 0,
    'midi.pitch': 67
})

const msm000 = () => new MSM(
    [
        // right hand: four quarter notes on G with 
        // each having a length of 1s (i.e. bpm = 60, beat length = 0.25)
        ...new Array(4).fill(null).map((_, i) => ({
            ...generateQuarterNote(1, i),
            'midi.onset': i + 1,
            'midi.duration': 1,
            'midi.velocity': 100
        })),

        // and four notes with 0.5s (i.e. bpm = 120, beat length = 0.25)
        ...new Array(4).fill(null).map((_, i) => ({
            ...generateQuarterNote(1, i + 4),
            'midi.onset': 5 + i * 0.5,
            'midi.duration': 0.5,
            'midi.velocity': 100
        }))
    ],
    { numerator: 4, denominator: 4 }
)

test('it correctly interpolates a constant tempo based on the denominator', () => {
    // Arrange
    const msm = msm000()
    const mpm = new MPM()

    // Act
    const tempo = new InterpolateTempoMap({ beatLength: 'denominator', epsilon: 0, precision: 2 })
    tempo.transform(msm, mpm)

    // Assert
    const tempos = mpm.getInstructions<Tempo>('tempo', 'global')

    expect(tempos).toHaveLength(2)
    expect(tempos.map(t => t.bpm)).toEqual([60, 120])
    expect(tempos.map(t => t.beatLength)).toEqual([0.25, 0.25])
})


test('it correctly interpolates a constant tempo based on halfbars', () => {
    // Arrange
    const msm = msm000()
    const mpm = new MPM()

    // Act
    const tempo = new InterpolateTempoMap({ beatLength: 'halfbar', epsilon: 0, precision: 2 })
    tempo.transform(msm, mpm)

    // Assert
    const tempos = mpm.getInstructions<Tempo>('tempo', 'global')

    expect(tempos).toHaveLength(2)
    expect(tempos.map(t => t.bpm)).toEqual([30, 60])
    expect(tempos.map(t => t.beatLength)).toEqual([0.5, 0.5])
    expect(msm.allNotes.map(n => n.tickDate)).toEqual([0, 720, 1440, 2160, 2880, 3600, 4320, 5040])
})

const msm001 = () => new MSM(
    [
        {
            ...generateQuarterNote(1, 0),
            'midi.onset': 1,
            'midi.duration': 0.5,
            'midi.velocity': 100
        },
        {
            ...generateQuarterNote(1, 1),
            'midi.onset': 1.892,
            'midi.duration': 0.5,
            'midi.velocity': 100
        },
        {
            ...generateQuarterNote(1, 2),
            'midi.onset': 2.621,
            'midi.duration': 0.5,
            'midi.velocity': 100
        },
        {
            ...generateQuarterNote(1, 3),
            'midi.onset': 3.238,
            'midi.duration': 0.5,
            'midi.velocity': 100
        },
        {
            ...generateQuarterNote(1, 4),
            'midi.onset': 3.772,
            'midi.duration': 0.5,
            'midi.velocity': 100
        },
    ],
    { numerator: 4, denominator: 4 }
)

test('it correctly interpolates a linear tempo transition', () => {
    // Arrange
    const msm = msm001()
    const mpm = new MPM()

    // Act
    const tempo = new InterpolateTempoMap({ beatLength: 'denominator', epsilon: 0, precision: 2 })
    tempo.transform(msm, mpm)

    // Assert
    const tempos = mpm.getInstructions<Tempo>('tempo', 'global')

    expect(tempos).toHaveLength(2)
    expect(tempos.map(t => t.bpm)).toEqual([59.84, 120])
    expect(tempos.map(t => t.beatLength)).toEqual([0.25, 0.25])
    expect(msm.allNotes.map(n => n.tickDate)).toEqual([0, 720, 1440, 2160, 2880])
})
