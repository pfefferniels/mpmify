// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM } from "../../src/msm"
import { Articulation, ArticulationDef, MPM, Style } from "../../src/mpm"
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

/** Two notes of a chord, one played half as long as written, one twice. */
const msmFixture = () => new MSM([
    {
        ...generateNote(0, 0.25, 'note0'),   // duration = 720 ticks
        'midi.onset': 1,
        'midi.duration': 1,
        'midi.velocity': 50,
        'tickDuration': 360,
    },
    {
        ...generateNote(0, 0.25, 'note1'),   // duration = 720 ticks
        'midi.onset': 1,
        'midi.duration': 1,
        'midi.velocity': 50,
        'tickDuration': 1440,
    }],
    { numerator: 1, denominator: 4 })

/** Call the protected `transform` method for testing */
const callTransform = (transformer: InsertArticulation, msm: MSM, mpm: MPM) => {
    type Transformable = { transform(msm: MSM, mpm: MPM): void }
    ;(transformer as unknown as Transformable).transform(msm, mpm)
}

const run = (msm: MSM, mpm: MPM) => callTransform(new InsertArticulation({
    scope: 'global',
    noteIDs: ['note0', 'note1'],
    aspects: new Set(['relativeDuration']),
    name: 'my-articulation',
}), msm, mpm)

test('it folds the notes at one date into a single <articulation> naming the definition', () => {
    const msm = msmFixture()
    const mpm = new MPM()

    run(msm, mpm)

    const articulations = mpm.getInstructions<Articulation>('articulation', 'global')
    expect(articulations).toHaveLength(1)
    expect(articulations[0].noteid).toBe('#note0 #note1')
    expect(articulations[0]['name.ref']).toBe('my-articulation')
    // The measured value moved into the definition; the instruction only refers to it.
    expect(articulations[0].relativeDuration).toBeUndefined()
})

test('the definition holds the mean of the measured aspect', () => {
    const msm = msmFixture()
    const mpm = new MPM()

    run(msm, mpm)

    const def = mpm.getDefinition('articulationDef', 'my-articulation') as ArticulationDef
    expect(def).not.toBeNull()
    // 360/720 = 0.5 and 1440/720 = 2 → mean 1.25
    expect(def.relativeDuration).toBeCloseTo(1.25, 10)
})

test('it puts the styleDef holding the definition in scope', () => {
    const msm = msmFixture()
    const mpm = new MPM()

    run(msm, mpm)

    // Without a <style> switch, @name.ref resolves to nothing and the articulation is inert.
    // See old-bugs.md.
    const styles = mpm.getStyles('articulation', 'global') as Style[]
    expect(styles).toHaveLength(1)
    expect(styles[0].date).toBe(0)
    expect(styles[0]['name.ref']).toBe('performance_style')
})

test('it takes the definition back out of the notes, leaving the residual duration', () => {
    const msm = msmFixture()
    const mpm = new MPM()

    run(msm, mpm)

    // Recorded divided by explained: what a later step still has to account for.
    expect(msm.allNotes.map(n => n.tickDuration)).toEqual([360 / 1.25, 1440 / 1.25])
})
