// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM } from "../../src/msm"
import { MPM, Tempo } from 'mpm-ts'
import { SimplifyTempo } from "../../src/transformers/SimplifyTempo"
import { InsertTempoInstructions } from "../../src/transformers/InsertTempoInstructions"

const roundToNearestTen = (n: number): number => {
    return +(Math.round(n / 10) * 10).toFixed(0);
}

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

test('it correctly simplifies a linear tempo transition', () => {
    // Arrange
    const msm = new MSM(
        [
            {
                ...generateQuarterNote(1, 0),
                'midi.onset': 1,
                'midi.duration': 0.5,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 1),
                'midi.onset': 1.892993197,
                'midi.duration': 0.5,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 2),
                'midi.onset': 2.621995465,
                'midi.duration': 0.5,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 3),
                'midi.onset': 3.238004535,
                'midi.duration': 0.5,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 4),
                'midi.onset': 3.772993197,
                'midi.duration': 0.5,
                'midi.velocity': 100
            },
        ],
        { numerator: 4, denominator: 4 }
    )
    const mpm = new MPM()

    // Act
    const insert = new InsertTempoInstructions({
        part: 'global',
        beatLength: 'denominator'
    })

    const simplify = new SimplifyTempo({
        part: 'global', 
        epsilon: 8,
        mode: 'linear'
    })

    insert.transform(msm, mpm)
    simplify.transform(msm, mpm)

    // Assert
    const tempos = mpm.getInstructions<Tempo>('tempo', 'global')

    expect(tempos).toHaveLength(2)
    expect.soft(+tempos[0].meanTempoAt!.toFixed(1)).toEqual(0.5)
    expect.soft(roundToNearestTen(tempos[0].bpm)).toEqual(60)
    expect.soft(roundToNearestTen(tempos[1].bpm)).toEqual(120)
    // expect(msm.allNotes.map(n => roundToNearestTen(n.tickDate || 0)))
    //     .toEqual([0, 720, 1440, 2160, 2880])
})

test('it correctly simplifies a non linear accelerando', () => {
    // Arrange
    const msm = new MSM(
        [
            {
                ...generateQuarterNote(1, 0),
                'midi.onset': 1,
                'midi.duration': 0.5,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 1),
                'midi.onset': 1.785011338,
                'midi.duration': 0.5,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 2),
                'midi.onset': 2.425011338,
                'midi.duration': 0.5,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 3),
                'midi.onset': 2.992993197,
                'midi.duration': 0.5,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 4),
                'midi.onset': 3.512993197,
                'midi.duration': 0.5,
                'midi.velocity': 100
            },
        ],
        { numerator: 4, denominator: 4 }
    )
    const mpm = new MPM()

    // Act
    const insert = new InsertTempoInstructions({
        part: 'global',
        beatLength: 'denominator'
    })

    const simplify = new SimplifyTempo({
        part: 'global', 
        epsilon: 8,
        mode: 'linear'
    })

    insert.transform(msm, mpm)
    simplify.transform(msm, mpm)

    // Assert
    const tempos = mpm.getInstructions<Tempo>('tempo', 'global')

    console.log(tempos)

    expect.soft(tempos).toHaveLength(2)
    expect.soft(+tempos[0].meanTempoAt!.toFixed(1)).toEqual(0.3)
    expect.soft(roundToNearestTen(tempos[0].bpm)).toEqual(60)
    expect.soft(roundToNearestTen(tempos[1].bpm)).toEqual(120)
    expect.soft(msm.allNotes.map(n => roundToNearestTen(n.tickDate || 0)))
        .toEqual([0, 720, 1440, 2160, 2880])
})

test('it correctly simplifies a non linear ritardando', () => {
    // Arrange
    const msm = new MSM(
        [
            {
                ...generateQuarterNote(1, 0),
                'midi.onset': 3.512993197,
                'midi.duration': 0.5,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 1),
                'midi.onset': 4.030,
                'midi.duration': 0.5,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 2),
                'midi.onset': 4.607,
                'midi.duration': 0.5,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 3),
                'midi.onset': 5.290,
                'midi.duration': 0.5,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 4),
                'midi.onset': 6.153,
                'midi.duration': 1,
                'midi.velocity': 100
            },
        ],
        { numerator: 4, denominator: 4 }
    )
    const mpm = new MPM()

    // Act
    const insert = new InsertTempoInstructions({
        part: 'global',
        beatLength: 'denominator'
    })

    const simplify = new SimplifyTempo({
        part: 'global', 
        epsilon: 8,
        mode: 'linear'
    })

    insert.transform(msm, mpm)
    simplify.transform(msm, mpm)

    // Assert
    const tempos = mpm.getInstructions<Tempo>('tempo', 'global')

    console.log(tempos)

    expect.soft(tempos).toHaveLength(2)
    expect.soft(+tempos[0].meanTempoAt!.toFixed(1)).toEqual(0.6)
    expect.soft(roundToNearestTen(tempos[0].bpm)).toEqual(120)
    expect.soft(roundToNearestTen(tempos[1].bpm)).toEqual(60)
    // expect.soft(msm.allNotes.map(n => n.tickDate)).toEqual([0, 720, 1440, 2160, 2880])
})

test('it splits a simple tempo bow into two segments (accelerando and ritardando)', () => {
    // Arrange
    const msm = new MSM(
        [
            {
                ...generateQuarterNote(1, 0),
                'midi.onset': 1,
                'midi.duration': 0.785,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 1),
                'midi.onset': 1.785011338,
                'midi.duration': 0.64,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 2),
                'midi.onset': 2.425011338,
                'midi.duration': 0.568,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 3),
                'midi.onset': 2.992993197,
                'midi.duration': 0.52,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 4),
                'midi.onset': 3.512993197,
                'midi.duration': 0.517,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 5),
                'midi.onset': 4.030,
                'midi.duration': 0.577,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 6),
                'midi.onset': 4.607,
                'midi.duration': 0.682,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 7),
                'midi.onset': 5.290,
                'midi.duration': 0.863,
                'midi.velocity': 100
            },
            {
                ...generateQuarterNote(1, 8),
                'midi.onset': 6.153,
                'midi.duration': 1,
                'midi.velocity': 100
            }
        ],
        { numerator: 4, denominator: 4 }
    )
    const mpm = new MPM()

    // Act
    const insert = new InsertTempoInstructions({
        part: 'global',
        beatLength: 'denominator'
    })

    const simplify = new SimplifyTempo({
        part: 'global', 
        epsilon: 8,
        mode: 'linear'
    })

    insert.transform(msm, mpm)
    simplify.transform(msm, mpm)

    // Assert
    const tempos = mpm.getInstructions<Tempo>('tempo', 'global')

    console.log(tempos)

    expect.soft(tempos).toHaveLength(3)
    expect.soft(+tempos[0].meanTempoAt!.toFixed(1)).toEqual(0.3)
    expect.soft(+tempos[1].meanTempoAt!.toFixed(1)).toEqual(0.6)
    expect.soft(roundToNearestTen(tempos[0].bpm)).toEqual(60)
    expect.soft(roundToNearestTen(tempos[1].bpm)).toEqual(120)
    expect.soft(roundToNearestTen(tempos[2].bpm)).toEqual(60)
    // expect.soft(msm.allNotes.map(n => roundToNearestTen(n.tickDate || 0)))
    //     .toEqual([0, 720, 1440, 2160, 2880, 3600, 4320, 5040, 5760])
    // expect.soft(msm.allNotes.map(n => roundToNearestTen(n.tickDuration || 0)))
    //     .toEqual([720, 720, 720, 720, 720, 720, 720, 720, 720])
})

