// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM, MsmNote } from "../../src/msm"
import { MPM } from "../../src/mpm"
import { MakeDefaultArticulation } from "../../src/transformers/articulation/MakeDefaultArticulation"
import { StylizeArticulation } from "../../src/transformers/articulation/StylizeArticulation"

/**
 * The `@name.ref` the hand-built articulations below carry, naming no `<articulationDef>` that
 * exists.
 *
 * These fixtures are about an articulation that states its own `@relativeDuration` and
 * `@relativeVelocity` and inherits nothing, which is what they used to say by carrying no
 * `@name.ref` at all. That spelling is no longer available: `@name.ref` is required by
 * `AddArticulationOptions`, and an `<articulation>` without one reads back as no instruction.
 * Naming a def that was never defined says the same thing — `StylizeArticulation` looks it up,
 * finds nothing, and falls back to the two values on the instruction, exactly as before.
 */
const UNRESOLVED = 'measured'

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
    mpm.requireMap('tempo', 'global').addTempo({ id: 't1', date: 0, bpm: 60, beatLength: 0.25 })
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
    mpm.requireMap('articulation', 'global').addArticulation({
        id: 'articulation_0', date: 0, nameRef: 'explicit',
    })

    callTransform(new MakeDefaultArticulation({ scope: 'global' }), msm, mpm)

    const def = mpm.getDefinition('articulationDef', 'default articulation')
    expect(def!.getRelativeDuration()).toBeCloseTo(1, 10)
})

test('StylizeArticulation tells the notes of a chord apart', () => {
    // Two notes of a chord, one articulation each — the spelling issue #53 replaced the folded
    // `noteid="#n0 #n1"` with. They are not interchangeable: stretching the lower one to the
    // cluster mean would run over the repeated c at date 720, so it is a conflict and has to
    // keep its own values, while the upper one has nothing in its way and joins the cluster.
    // The folded instruction could not express that difference even once it was read correctly.
    const msm = new MSM([
        note('n0', 0, 60, 1440),
        note('n1', 0, 67, 1440),
        note('n2', 720, 60, 720),
    ], { numerator: 4, denominator: 4 })

    const mpm = atSixtyBpm()
    const articulationMap = mpm.requireMap('articulation', 'global')
    for (const articulation of [
        {
            id: 'articulation_0', date: 0, noteid: '#n0', nameRef: UNRESOLVED,
            relativeDuration: 2, relativeVelocity: 1,
        },
        {
            id: 'articulation_0_1', date: 0, noteid: '#n1', nameRef: UNRESOLVED,
            relativeDuration: 2, relativeVelocity: 1,
        },
        {
            id: 'articulation_720', date: 720, noteid: '#n2', nameRef: UNRESOLVED,
            relativeDuration: 2, relativeVelocity: 1,
        },
    ]) articulationMap.addArticulation(articulation)

    callTransform(new StylizeArticulation({ volumeTolerance: 0.01, relativeDurationTolerance: 0.2 }), msm, mpm)

    const byNote = (id: string) => mpm
        .getInstructions('articulation', 'global')
        .find(a => a.noteid === id)

    // The lower note is the conflict, and keeps what it measured: still its own
    // `@relativeDuration`, and still pointing at nothing rather than at the cluster's def.
    expect(byNote('#n0')).toBeDefined()
    expect(byNote('#n0')!.nameRef).toBe(UNRESOLVED)
    expect(byNote('#n0')!.relativeDuration).toBe(2)

    // The upper one joined the cluster that became the default, and the style now says so on
    // its behalf — which is why its instruction is gone from the map.
    expect(byNote('#n1')).toBeUndefined()
    expect(mpm.getStyles('articulation', 'global')[0].defaultArticulation).toBeDefined()
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
    const articulationMap = mpm.requireMap('articulation', 'global')
    for (const [i, date] of [0, 720, 1440, 2160].entries()) {
        articulationMap.addArticulation({
            id: `articulation_${i}`, date, noteid: `#n${i}`, nameRef: UNRESOLVED,
            relativeDuration: 0.5, relativeVelocity: 1,
        })
    }

    callTransform(new StylizeArticulation({ volumeTolerance: 0.01, relativeDurationTolerance: 0.2 }), msm, mpm)
    callTransform(new MakeDefaultArticulation(), msm, mpm)

    const styles = mpm.getStyles('articulation', 'global')
    expect(styles).toHaveLength(1)
    expect(styles[0].date).toBe(0)
    // And it is the switch the later transformer amended, not a shadowing duplicate.
    expect(styles[0].defaultArticulation).toBe('default articulation')
})
