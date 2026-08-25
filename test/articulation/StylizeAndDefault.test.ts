// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM, MsmNote } from "../../src/msm"
import { Articulation, ArticulationDef, MPM, Tempo } from "../../src/mpm"
import { MakeDefaultArticulation } from "../../src/transformers/articulation/MakeDefaultArticulation"
import { StylizeArticulation } from "../../src/transformers/articulation/StylizeArticulation"

/**
 * A note that was played for `tickDuration` ticks.
 *
 * Stated as a recording rather than as tick figures: both transformers here derive where a note
 * fell from the recording and the tempo, so the fixture has to say what was recorded. At 60bpm
 * with a quarter-note beat one second is 720 ticks, which is the whole of the conversion below.
 */
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
    'midi.duration': tickDuration / 720,
    'midi.velocity': 64,
})

/** The tempo those recorded seconds are read against. */
const atSixtyBpm = () => {
    const mpm = new MPM()
    mpm.insertInstruction<Tempo>({
        type: 'tempo', 'xml:id': 't1', date: 0, bpm: 60, beatLength: 0.25,
    }, 'global')
    return mpm
}

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

    const mpm = atSixtyBpm()
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

    const mpm = atSixtyBpm()
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
        .getInstructions('articulation', 'global')
        .find(a => a.noteid === '#n0 #n1')

    expect(conflicting).toBeDefined()
    expect(conflicting!['name.ref']).toBeUndefined()
    expect(conflicting!.relativeDuration).toBe(2)
})

test('a chain running both transformers leaves exactly one <style> in the articulationMap', () => {
    // Both transformers need the <style date="0"> that puts mpmify's own <styleDef> in scope, and
    // both used to insert one unconditionally. Neither `MPM.insertStyle` nor espressivo's
    // `addStyleSwitch` deduplicates, so running the pair wrote two switches at the same date into
    // one map — the second shadowing the first.
    //
    // `ensureDefaultStyle` asks for the switch instead of inserting one, so the second caller
    // amends what the first wrote. n4 and n5 carry no <articulation>, which is what leaves
    // MakeDefaultArticulation something to measure.
    const msm = new MSM([
        note('n0', 0, 60, 360),
        note('n1', 720, 62, 360),
        note('n2', 1440, 64, 365),
        note('n3', 2160, 65, 355),
        note('n4', 2880, 67, 700),
        note('n5', 3600, 69, 700),
    ], { numerator: 4, denominator: 4 })

    const mpm = atSixtyBpm()
    mpm.insertInstructions(([0, 720, 1440, 2160]).map((date, i) => ({
        type: 'articulation', 'xml:id': `articulation_${i}`, date, noteid: `#n${i}`,
        relativeDuration: 0.5, relativeVelocity: 1,
    })) as Articulation[], 'global')

    callTransform(new StylizeArticulation({ volumeTolerance: 0.01, relativeDurationTolerance: 0.2 }), msm, mpm)
    callTransform(new MakeDefaultArticulation(), msm, mpm)

    const styles = mpm.getStyles('articulation', 'global')
    expect(styles).toHaveLength(1)
    expect(styles[0].date).toBe(0)
    // And it is the switch the later transformer amended, not a shadowing duplicate.
    expect(styles[0].defaultArticulation).toBe('default articulation')
})
