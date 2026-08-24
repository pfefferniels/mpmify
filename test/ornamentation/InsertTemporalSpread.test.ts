// @vitest-environment jsdom

import { expect, test } from 'vitest'
import { MSM } from '../../src/msm'
import { MPM, Ornament } from '../../src/mpm'
import { InsertTemporalSpread } from '../../src/transformers'

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

/** Two notes of one chord, struck a second apart — a rolled chord, seen from the recording. */
const msmFixture = () => new MSM([
    {
        ...generateNote(0, 0.25, 60),
        'midi.onset': 0.5,
        'midi.duration': 1,
        'midi.velocity': 50
    },
    {
        ...generateNote(0, 0.25, 67),
        'midi.onset': 1.5,
        'midi.duration': 1,
        'midi.velocity': 50
    }],
    { numerator: 1, denominator: 4 })

/** Call the protected `transform` method for testing */
const callTransform = (transformer: InsertTemporalSpread, msm: MSM, mpm: MPM) => {
    type Transformable = { transform(msm: MSM, mpm: MPM): void }
    ;(transformer as unknown as Transformable).transform(msm, mpm)
}

const run = (msm: MSM, mpm: MPM) => callTransform(new InsertTemporalSpread({
    scope: 'global',
    placement: 'estimate',
    durationThreshold: 200,
    noteOffShiftTolerance: 0.2,
}), msm, mpm)

test('it describes the roll as an <ornament> in milliseconds around the estimated onset', () => {
    const msm = msmFixture()
    const mpm = new MPM()

    run(msm, mpm)

    const arpeggios = mpm.getInstructions<Ornament>('ornament', 'global')
    expect(arpeggios).toHaveLength(1)
    expect(arpeggios[0]['frame.start']).toEqual(-500)
    expect(arpeggios[0]['frameLength']).toEqual(1000)
    expect(arpeggios[0]['time.unit']).toEqual('milliseconds')
    expect(arpeggios[0]['note.order']).toEqual('ascending pitch')
})

test('it collapses the rolled chord onto one onset, so a tempo can be read off it', () => {
    const msm = msmFixture()
    const mpm = new MPM()

    run(msm, mpm)

    // §0 of PORT-TO-ESPRESSIVO.md: the roll is explained, then removed, and only then is the
    // onset clean enough to measure a tempo from.
    expect(msm.allNotes.map(note => note['midi.onset'])).toEqual([1, 1])
})

test('a roll shorter than the threshold is left alone', () => {
    const msm = msmFixture()
    msm.allNotes[1]['midi.onset'] = 0.51 // 10 ms apart
    const mpm = new MPM()

    run(msm, mpm)

    expect(mpm.getInstructions<Ornament>('ornament', 'global')).toHaveLength(0)
})
