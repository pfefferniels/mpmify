// @vitest-environment jsdom

import { describe, expect, test } from "vitest"
import { MSM, MsmNote } from "../../src/msm"
import { AccentuationPatternDef, Dynamics, MPM, Tempo } from "../../src/mpm"
import { InsertMetricalAccentuation } from "../../src/transformers/accentuation"
import { PULSES_PER_QUARTER } from "../../src/ppq"

/**
 * The loop in `InsertMetricalAccentuation` is driven entirely by the *residual* velocity — what
 * the rest of the MPM leaves unexplained — so a fixture that wants to steer it has to steer that
 * quantity rather than the recorded velocities directly.
 *
 * A single flat `<dynamics>` makes the two the same thing up to a constant: espressivo renders
 * every note at `volume`, so `residual = midi.velocity - volume` exactly, with no rounding to
 * work around. Everything below is written in terms of the residual and the fixture adds the
 * constant back.
 */
const VOLUME = 64

const note = (index: number, velocity: number): MsmNote => ({
    'xml:id': `n_${index}`,
    date: index * PULSES_PER_QUARTER,
    part: 1,
    pitchname: 'c',
    octave: 4,
    accidentals: 0,
    duration: PULSES_PER_QUARTER,
    'midi.pitch': 60,
    'midi.onset': index * 500,
    'midi.duration': 500,
    'midi.velocity': velocity,
} as MsmNote)

/**
 * The residual shape one bar carries, as a fraction of that bar's scale.
 *
 * The peak sits on beat 2 rather than on the downbeat on purpose. A cell's last sample is the
 * *next* bar's downbeat, so a bar whose strongest beat is its first would hand its own scale to
 * the bar before it and no cell's scale would be its own. With the peak inside the bar, each
 * cell's `calculateScale` reads back exactly the scale this fixture gave it — as long as the
 * downbeat fraction is small enough that a louder following bar still does not outweigh it.
 * At 0.3 that holds while no bar is more than three times the strength of the one before it,
 * which every list of scales below respects.
 *
 * Rounded to the nearest integer the shape is `[0, 1, 1, 0]` whatever the scale, which is what
 * `hasSameBeatStructure` compares, so every bar built from it is accepted as the same pattern.
 */
const SHAPE = [0.3, 1, 0.5, 0.2]

/**
 * One bar per entry of `scales`, each carrying `SHAPE` at that strength, then a closing downbeat
 * with no residual at all. The closing note ends the loop the way the end of a piece does: the
 * cell after the last bar has a scale of 0, and a scale of 0 is not a pattern.
 */
const fixture = (scales: number[]) => {
    const notes: MsmNote[] = []
    for (let bar = 0; bar < scales.length; bar++) {
        for (let beat = 0; beat < 4; beat++) {
            notes.push(note(bar * 4 + beat, VOLUME + SHAPE[beat] * scales[bar]))
        }
    }
    notes.push(note(scales.length * 4, VOLUME))

    const msm = new MSM(notes, { numerator: 4, denominator: 4 })

    const mpm = new MPM()
    mpm.insertInstruction<Tempo>({
        type: 'tempo', 'xml:id': 't1', date: 0, bpm: 120, beatLength: 0.25,
    }, 'global')
    mpm.insertInstruction<Dynamics>({
        type: 'dynamics', 'xml:id': 'd1', date: 0, volume: VOLUME,
    }, 'global')

    return { msm, mpm }
}

/** Call the protected `transform` method for testing */
const run = (msm: MSM, mpm: MPM, scaleTolerance: number) => {
    const transformer = new InsertMetricalAccentuation({
        scope: 'global',
        name: 'metre',
        from: 0,
        to: 4 * PULSES_PER_QUARTER,
        beatLength: 0.25,
        scaleTolerance,
    })
    type Transformable = { transform(msm: MSM, mpm: MPM): void }
    ;(transformer as unknown as Transformable).transform(msm, mpm)
}

const fitted = (mpm: MPM) => mpm
    .getInstructions('accentuationPattern', 'global')
    .find(p => p["name.ref"] === 'metre')!

describe('the fixture drives the loop it claims to', () => {
    // Everything below reads `@scale` as a mean over a known set of bars. That only means
    // anything if the loop really did take in the bars the test names, so establish it once.
    test('three bars of the same shape are folded into one looping pattern', () => {
        const { msm, mpm } = fixture([10, 20, 30])
        run(msm, mpm, 25)

        const pattern = fitted(mpm)
        expect(pattern.date).toBe(0)
        expect(pattern.loop).toBe(true)

        // The neutral pattern closing the loop marks where the fold stopped: after bar 3.
        const neutral = mpm.getInstructions('accentuationPattern', 'global')
            .find(p => p["name.ref"] === 'neutral')!
        expect(neutral.date).toBe(12 * PULSES_PER_QUARTER)

        // The definition is the prototype's shape, normalised by the prototype's own scale.
        const def = mpm.getDefinitions<AccentuationPatternDef>('accentuationPatternDef', 'global')
            .find(d => d.name === 'metre')!
        expect(def.children.map(a => a.beat)).toEqual([1, 2, 3, 4])
        expect(def.children.map(a => a.value)).toEqual(SHAPE)
    })
})

describe('@scale, the running mean over the cells the pattern covers', () => {
    // Issue #41. The accumulator counted the prototype as zero samples, so the first pass
    // replaced its scale instead of averaging it in and the reported figure was the mean of
    // the repeats alone: 25 here, the mean of 20 and 30, with the prototype's 10 gone.
    test('counts the cell the pattern was derived from', () => {
        const { msm, mpm } = fixture([10, 20, 30])
        run(msm, mpm, 25)

        expect(fitted(mpm).scale).toBe(20)
    })

    test('is the prototype\'s own scale when no repeat is taken in', () => {
        // A second bar well outside the tolerance breaks the loop on its first pass, so the
        // pattern covers the prototype alone and reports the prototype's own scale.
        const { msm, mpm } = fixture([10, 25])
        run(msm, mpm, 5)

        const pattern = fitted(mpm)
        expect(pattern.scale).toBe(10)
        expect(pattern.loop).toBeUndefined()
    })

    test('weights every cell equally, however many there are', () => {
        const { msm, mpm } = fixture([10, 20, 30, 40, 50])
        run(msm, mpm, 45)

        expect(fitted(mpm).scale).toBe(30)
    })
})

describe('the scale tolerance is measured against the prototype', () => {
    // Second-order finding of issue #41. The comparison used to run against the running mean,
    // which every accepted cell moves, so the acceptance window walked along with the data.
    test('a drifting run is cut where it leaves the prototype\'s window', () => {
        // Steps of 2 against a tolerance of 5. Measured against the prototype the run is cut
        // where it should be: bars of 12 and 14 are 2 and 4 away and join, 16 is 6 away and
        // does not, leaving a mean of 12 over three bars.
        //
        // Measured against the running mean it would not be. The mean lags the data by half a
        // step per bar, so the gap it sees grows at half the rate the real one does: 16 reads
        // as 4 away and 18 as 5, both inside the window. The fold would run two bars further
        // and report 14 — a pattern covering a bar 80% stronger than the one that defined it,
        // under a tolerance that said 50%.
        const { msm, mpm } = fixture([10, 12, 14, 16, 18, 20])
        run(msm, mpm, 5)

        const pattern = fitted(mpm)
        expect(pattern.scale).toBe(12)

        const neutral = mpm.getInstructions('accentuationPattern', 'global')
            .find(p => p["name.ref"] === 'neutral')!
        expect(neutral.date).toBe(12 * PULSES_PER_QUARTER)
    })

    test('a cell more than the tolerance from the prototype is refused', () => {
        const { msm, mpm } = fixture([10, 12, 30])
        run(msm, mpm, 5)

        // Bar 2 is within 5 of the prototype and joins; bar 3 is 20 away and does not.
        expect(fitted(mpm).scale).toBe(11)
    })
})
