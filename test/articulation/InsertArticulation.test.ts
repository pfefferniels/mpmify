// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM } from "../../src/msm"
import { Articulation, ArticulationDef, MPM, Tempo } from "../../src/mpm"
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

/**
 * Two notes of a chord, one played half as long as written, one twice.
 *
 * The played lengths are stated as what was recorded rather than as tick figures, because the
 * fitter derives the tick figures from the recording and the tempo. At 60bpm with a quarter-note
 * beat, one second is one quarter note is 720 ticks — so 0.5s is the 360 ticks this used to
 * assert directly, and 2s is the 1440.
 *
 * The rest note is there to make the piece long enough to contain them. The tick walk measures a
 * duration only where the note's end falls inside a tempo's span, and the span reaches to
 * `msm.end` — the last symbolic offset in the score. Two chord notes alone put that at 720
 * ticks, one second, so the note held for two would end past the end of the piece and be
 * measured as nothing at all.
 */
const msmFixture = () => new MSM([
    {
        ...generateNote(0, 0.25, 'note0'),   // duration = 720 ticks
        'midi.onset': 0,
        'midi.duration': 0.5,                // → 360 ticks
        'midi.velocity': 50,
    },
    {
        ...generateNote(0, 0.25, 'note1'),   // duration = 720 ticks
        'midi.onset': 0,
        'midi.duration': 2,                  // → 1440 ticks
        'midi.velocity': 50,
    },
    {
        ...generateNote(1, 0.25, 'rest'),    // date 2880; not articulated, it only sets msm.end
        'midi.onset': 4,
        'midi.duration': 1,
        'midi.velocity': 50,
    }],
    { numerator: 1, denominator: 4 })

/** The tempo the recorded seconds above are read against. */
const atSixtyBpm = () => {
    const mpm = new MPM()
    mpm.insertInstruction<Tempo>({
        type: 'tempo', 'xml:id': 't1', date: 0, bpm: 60, beatLength: 0.25,
    }, 'global')
    return mpm
}

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
    const mpm = atSixtyBpm()

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
    const mpm = atSixtyBpm()

    run(msm, mpm)

    const def = mpm.getDefinition('articulationDef', 'my-articulation') as ArticulationDef
    expect(def).not.toBeNull()
    // 360/720 = 0.5 and 1440/720 = 2 → mean 1.25
    expect(def.relativeDuration).toBeCloseTo(1.25, 10)
})


// The <style> switch is now checked on every fitted MPM the round-trip suite produces: see
// the 'a map that references definitions switches to a style' invariant in
// test/roundtrip/invariants.ts.

// Removed with the accumulated residual: this asserted that the fit divided its own definition
// back out of every note it covered, so the next step would measure against what the document
// now said. Nothing is written back any more — a later step derives the residual from the
// document itself — so there is no intermediate value left to assert. What the mechanism was
// for is covered by test/roundtrip's tier-1 case 'a uniform legato comes back as one def at
// that relativeDuration', which renders the fit and compares it against the performance it was
// fitted to.
