// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM } from "../../src/msm"
import { ArticulationDef, MPM, Tempo } from "../../src/mpm"
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
 * The rest note is there to make the piece long enough to contain them — or it was. The tick
 * walk used to measure a duration only where the note's end fell inside a tempo's span, and the
 * span reaches to `msm.end`, the last symbolic offset in the score; two chord notes alone put
 * that at 720 ticks, one second, so the note held for two ended past the end of the piece and was
 * measured as nothing at all. That is issue #27, and the last window runs open now, so the rest
 * no longer changes what these two notes measure. It stays because it also gives the piece a
 * second date, and the assertions below were recorded against a score that had one.
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

test('it writes one <articulation> per note, each naming the definition', () => {
    // The two notes share a date, and used to share an instruction: `noteid="#note0 #note1"`.
    // `@noteid` is a single reference — espressivo strips the `#` and looks the rest up as an
    // id — so that instruction named no note and articulated none of them (issue #53).
    const msm = msmFixture()
    const mpm = atSixtyBpm()

    run(msm, mpm)

    const articulations = mpm.getInstructions('articulation', 'global')
    expect(articulations).toHaveLength(2)
    expect(articulations.map(a => a.noteid).sort()).toEqual(['#note0', '#note1'])
    expect(articulations.map(a => a['name.ref'])).toEqual(['my-articulation', 'my-articulation'])
    // One id each: they share a date, and `generateId` numbers by what the map already holds.
    expect(new Set(articulations.map(a => a['xml:id'])).size).toBe(2)
    // The measured values moved into the definition; the instructions only refer to it.
    expect(articulations.map(a => a.relativeDuration)).toEqual([undefined, undefined])
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
