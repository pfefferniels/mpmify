// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM, MsmNote } from "../../src/msm"
import { Articulation, ArticulationDef, MPM } from "../../src/mpm"
import { MakeDefaultArticulation } from "../../src/transformers/articulation/MakeDefaultArticulation"
import { StylizeArticulation } from "../../src/transformers/articulation/StylizeArticulation"

const note = (id: string, date: number, pitch: number, tickDuration: number): MsmNote => ({
    'xml:id': id,
    date,
    part: 1,
    pitchname: 'c',
    octave: 4,
    accidentals: 0,
    duration: 720,
    'midi.pitch': pitch,
    'midi.onset': date / 720,
    'midi.duration': 1,
    'midi.velocity': 64,
    tickDate: date,
    tickDuration,
})

/** Call the protected `transform` method for testing */
const callTransform = (
    transformer: MakeDefaultArticulation | StylizeArticulation,
    msm: MSM,
    mpm: MPM
) => {
    type Transformable = { transform(msm: MSM, mpm: MPM): void }
    ;(transformer as unknown as Transformable).transform(msm, mpm)
}

test('MakeDefaultArticulation excludes the notes a date-scoped <articulation> already covers', () => {
    // Two notes at date 0 are covered by an articulation carrying no @noteid, which applies to
    // every note at its date. Only the third note should reach the default. The inner `notes`
    // used to shadow the outer one, so all three did and the mean was (0.5 + 2 + 1) / 3.
    // See old-bugs.md.
    const msm = new MSM([
        note('n0', 0, 60, 360),
        note('n1', 0, 67, 1440),
        note('n2', 720, 60, 720),
    ], { numerator: 4, denominator: 4 })

    const mpm = new MPM()
    mpm.insertInstruction({
        type: 'articulation', 'xml:id': 'articulation_0', date: 0, 'name.ref': 'explicit',
    } as Articulation, 'global')

    callTransform(new MakeDefaultArticulation({ scope: 'global' }), msm, mpm)

    const def = mpm.getDefinition('articulationDef', 'default articulation') as ArticulationDef
    expect(def.relativeDuration).toBeCloseTo(1, 10)
})

test('StylizeArticulation sees every note a multi-note @noteid names', () => {
    // The articulation covers a chord; stretching it to the cluster mean would run over the
    // repeated c at date 720, so it is a conflict and must keep its own values. Matching the
    // whole `#n0 #n1` attribute against one id found no target note at all, so the conflict
    // went unnoticed. See old-bugs.md.
    const msm = new MSM([
        note('n0', 0, 60, 1440),
        note('n1', 0, 67, 1440),
        note('n2', 720, 60, 720),
    ], { numerator: 4, denominator: 4 })

    const mpm = new MPM()
    mpm.insertInstructions([
        {
            type: 'articulation', 'xml:id': 'articulation_0', date: 0, noteid: '#n0 #n1',
            relativeDuration: 2, relativeVelocity: 1,
        },
        {
            type: 'articulation', 'xml:id': 'articulation_720', date: 720, noteid: '#n2',
            relativeDuration: 2, relativeVelocity: 1,
        },
    ] as Articulation[], 'global')

    callTransform(new StylizeArticulation({ volumeTolerance: 0.01, relativeDurationTolerance: 0.2 }), msm, mpm)

    const conflicting = mpm
        .getInstructions<Articulation>('articulation', 'global')
        .find(a => a.noteid === '#n0 #n1')

    expect(conflicting).toBeDefined()
    expect(conflicting!['name.ref']).toBeUndefined()
    expect(conflicting!.relativeDuration).toBe(2)
})
