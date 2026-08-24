// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM, MsmNote } from "../../src/msm"
import { MPM, Rubato } from "../../src/mpm"
import { CombineAdjacentRubatos } from "../../src/transformers/rubato/CombineAdjacentRubatos"

const note = (date: number): MsmNote => ({
    'xml:id': `n${date}`,
    date,
    part: 1,
    pitchname: 'c',
    octave: 4,
    accidentals: 0,
    duration: 720,
    'midi.pitch': 60,
    'midi.onset': date / 720,
    'midi.duration': 1,
    'midi.velocity': 64,
})

const rubato = (date: number, intensity: number): Rubato => ({
    type: 'rubato', 'xml:id': `rubato_${date}`, date, frameLength: 720, intensity,
})

/** Call the protected `transform` method for testing */
const run = (transformer: CombineAdjacentRubatos, msm: MSM, mpm: MPM) => {
    type Transformable = { transform(msm: MSM, mpm: MPM): void }
    ;(transformer as unknown as Transformable).transform(msm, mpm)
}

const transformer = () => new CombineAdjacentRubatos({
    intensityTolerance: 0.2,
    compressionTolerance: 0.1,
    scope: 'global',
})

test('it terminates when the last rubato has no frame left before the final note', () => {
    // The walk used to advance `ref` only from inside the frame loop, so a `ref` whose next
    // frame started at or after the last note never advanced and the transformer span forever.
    // See old-bugs.md.
    const msm = new MSM(
        [0, 720, 1440, 2160, 2880].map(note),
        { numerator: 4, denominator: 4 }
    )
    const mpm = new MPM()
    mpm.insertInstructions([
        rubato(0, 0.5),
        rubato(720, 2.0),   // opposite side of 1: not mergeable with its predecessor
        rubato(2160, 0.5),  // reached as `ref`; its next frame starts at the last note
    ], 'global')

    run(transformer(), msm, mpm)

    expect(mpm.getInstructions<Rubato>('rubato', 'global').map(r => r.date)).toEqual([0, 720, 2160])
})

test('it folds a run of similar rubatos into one looping instruction', () => {
    const msm = new MSM(
        [0, 720, 1440, 2160, 2880, 3600].map(note),
        { numerator: 4, denominator: 4 }
    )
    const mpm = new MPM()
    mpm.insertInstructions([
        rubato(0, 1.4),
        rubato(720, 1.45),
        rubato(1440, 1.5),
        rubato(2160, 0.6),  // stops the run
    ], 'global')

    run(transformer(), msm, mpm)

    const rubatos = mpm.getInstructions<Rubato>('rubato', 'global')
    expect(rubatos.map(r => r.date)).toEqual([0, 2160])
    expect(rubatos[0].loop).toBe(true)
    expect(rubatos[0].intensity).toBeCloseTo((1.4 + 1.45 + 1.5) / 3, 10)
})
