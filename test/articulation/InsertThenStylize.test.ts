// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM, MsmNote } from "../../src/msm"
import { ArticulationDef, MPM, Tempo } from "../../src/mpm"
import { InsertArticulation } from "../../src/transformers/articulation/InsertArticulation"
import { StylizeArticulation } from "../../src/transformers/articulation/StylizeArticulation"

/**
 * The chain issue #25 is about: `InsertArticulation` first, `StylizeArticulation` on what it
 * wrote. Every other articulation test hands `StylizeArticulation` `<articulation>` elements
 * built by hand, which still carry `@relativeDuration` and `@relativeVelocity` — and that is
 * exactly the state the real chain never produces, because `InsertArticulation` moves both into
 * the `<articulationDef>` and blanks them on the instruction. Clustering read the blanked
 * attributes, so every point was `[undefined, undefined]`, every distance NaN, and the whole
 * transformer a no-op that five green tests could not see.
 */

/** A note that was played for `playedTicks` ticks — stated as a recording, read at 60bpm. */
const note = (id: string, date: number, pitch: number, playedTicks: number): MsmNote => ({
    'xml:id': id,
    date,
    part: 1,
    pitchname: 'c',
    octave: 4,
    accidentals: 0,
    duration: 720,
    'midi.pitch': pitch,
    'midi.onset': date / 720,
    'midi.duration': playedTicks / 720,
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

type Transformable = { transform(msm: MSM, mpm: MPM): void }
const callTransform = (
    transformer: InsertArticulation | StylizeArticulation,
    msm: MSM,
    mpm: MPM
) => (transformer as unknown as Transformable).transform(msm, mpm)

const BOTH = new Set(['relativeDuration', 'relativeVelocity'] as const)

/** Eight notes on eight pitches, so no stretched note can run into a repeat of its own. */
const PITCHES = [60, 62, 64, 65, 67, 69, 71, 72]

const insert = (msm: MSM, mpm: MPM, name: string, ids: string[]) =>
    callTransform(new InsertArticulation({
        scope: 'global', noteIDs: ids, aspects: new Set(BOTH), name,
    }), msm, mpm)

const stylize = (msm: MSM, mpm: MPM) =>
    callTransform(new StylizeArticulation(), msm, mpm)

const defaultDef = (mpm: MPM) => {
    const name = mpm.getStyles('articulation', 'global')[0]?.defaultArticulation
    return name === undefined
        ? null
        : mpm.getDefinition('articulationDef', name) as ArticulationDef | null
}

test('the articulations InsertArticulation wrote are clustered, not read as noise', () => {
    // The issue's own evidence: two notes shortened alike, folded into one def named 'a', and
    // two `<articulation>` elements carrying nothing but `@name.ref="a"`. That is one cluster,
    // and being the only one it becomes the map's default — so the instructions can go.
    const msm = new MSM([
        note('n0', 0, 60, 648),
        note('n1', 720, 62, 648),
    ], { numerator: 4, denominator: 4 })

    const mpm = atSixtyBpm()
    insert(msm, mpm, 'a', ['n0', 'n1'])
    stylize(msm, mpm)

    const def = defaultDef(mpm)
    expect(def).not.toBeNull()
    expect(def!.relativeDuration).toBeCloseTo(0.9, 6)
    expect(mpm.getInstructions('articulation', 'global')).toHaveLength(0)

    // And the def they were merged out of is gone with them: leaving it would have the styleDef
    // say the same thing twice, once under the name nothing refers to any more.
    expect(mpm.getDefinition('articulationDef', 'a')).toBeNull()
})

test('two articulation units are kept apart, and the larger one becomes the default', () => {
    // Five notes shortened to half, three lengthened to 1.4 — two units, two defs, and two
    // clusters that are further apart than `relativeDurationTolerance`. The larger becomes the
    // default; the smaller keeps an instruction each, now naming the def the cluster was given.
    const played = [360, 360, 360, 360, 360, 1008, 1008, 1008]
    const msm = new MSM(
        PITCHES.map((pitch, i) => note(`n${i}`, i * 720, pitch, played[i])),
        { numerator: 4, denominator: 4 }
    )

    const mpm = atSixtyBpm()
    insert(msm, mpm, 'short', ['n0', 'n1', 'n2', 'n3', 'n4'])
    insert(msm, mpm, 'long', ['n5', 'n6', 'n7'])
    stylize(msm, mpm)

    const def = defaultDef(mpm)
    expect(def).not.toBeNull()
    expect(def!.relativeDuration).toBeCloseTo(0.5, 6)

    const left = mpm.getInstructions('articulation', 'global')
    expect(left.map(a => a.noteid).sort()).toEqual(['#n5', '#n6', '#n7'])

    const longName = left[0]['name.ref']
    expect(longName).toBeDefined()
    expect(longName).not.toBe(def!.name)
    expect(new Set(left.map(a => a['name.ref']))).toEqual(new Set([longName]))

    const longDef = mpm.getDefinition('articulationDef', longName!) as ArticulationDef
    expect(longDef.relativeDuration).toBeCloseTo(1.4, 6)

    // Both units were merged into definitions of this transformer's own, so neither of the
    // names they were inserted under is left behind.
    expect(mpm.getDefinition('articulationDef', 'short')).toBeNull()
    expect(mpm.getDefinition('articulationDef', 'long')).toBeNull()
})
