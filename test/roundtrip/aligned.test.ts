// @vitest-environment jsdom

import { beforeAll, describe, expect, test } from "vitest"
import { AlignedRun, runAligned } from "./aligned"
import { describe as describeErrors } from "./harness"
import { assertWellFormed } from "./invariants"

/**
 * The round trip on a real recording — issue #51.
 *
 * The rest of this directory states its ground truth as an MPM, which makes the truth exact and
 * a perfect fit possible in principle. This case does not: the truth is a Welte roll, and the
 * chain fitting it is the one a person actually wrote for this passage, call for call. What it
 * measures is therefore not "can the fitter invert the renderer" but "does the pipeline still
 * reproduce a performance it has been used on" — which is the property all four criticals of the
 * 2026-08 audit broke while every unit test stayed green.
 *
 * The bounds are recorded from measurement, not chosen. Whatever they admit above zero is a
 * measured gap, and the notes below say what is inside them today. Tightening one is what fixed
 * looks like; loosening one without a reason is the regression this file exists to catch.
 */

/**
 * Measured at e059ca7, then given headroom for platforms whose floats anneal differently.
 * `ROUNDTRIP_REPORT=1 npm run test:roundtrip:report` prints what they currently are.
 */
const BOUNDS = {
    /**
     * Onset. Measured mean 30.9 ms, max 115.4 — against 3950 ms of departure from the bare
     * score, so the tempo and rubato maps account for 99% of the timing.
     */
    onset: { mean: 45, max: 160 },
    /**
     * Sounding duration. Measured mean 289 ms, max 2425 — by far the worst aspect, and most of
     * it is one defect: `InsertArticulation` writes every note it covers into a single
     * `<articulation noteid="#a #b">`, and espressivo reads `@noteid` as one reference
     * (`ArticulationMap` strips the `#` and looks the rest up as an id), so an articulation
     * covering more than one note articulates nothing. Three of this chain's fifteen do.
     * Splitting them into one element per note takes the mean to 160 ms and the max to 780.
     */
    duration: { mean: 400, max: 3400 },
    /** Velocity. Measured mean 1.64, max 8.5, against a bare-score departure of 63. */
    velocity: { mean: 2.3, max: 12 },
}

/**
 * The share of each aspect's departure from the bare score that the fitted MPM accounts for.
 *
 * The absolute bounds above cannot say this on their own: 400 ms of duration error would be a
 * catastrophe on a passage that only departs by 450, and unremarkable on one that departs by
 * ten seconds. Measured 0.99 / 0.36 / 0.97.
 */
const EXPLAINED = { onset: 0.97, duration: 0.25, velocity: 0.95 }

/** What `asMSM` finds in the fixture: 58 aligned notes, less two the MSM conversion doubles. */
const NOTES = 56

let run: AlignedRun

beforeAll(() => { run = runAligned() }, 120_000)

describe('an aligned recording, fitted and rendered back', () => {
    test('the chain runs in full', () => {
        // `importWork` warns and drops a call it cannot build, and a dropped call is a chain
        // that quietly fits less than the fixture says it does.
        expect(run.calls.ran, 'calls in chain.json that did not survive the import')
            .toBe(run.calls.declared)
    })

    test('the fixture still carries a performance', () => {
        // Every number below is a difference from the recording. A fixture that lost its
        // `<when>` elements would compare the score against itself and pass everything.
        expect(run.exercised.onset.mean).toBeGreaterThan(1000)
        expect(run.exercised.velocity.mean).toBeGreaterThan(10)
        expect(run.errors.matched).toBe(NOTES)
    })

    test('every note the recording holds comes back out of the render', () => {
        expect(run.errors.missing, `notes the render failed to produce\n  ${describeErrors(run.errors)}`)
            .toBe(0)
    })

    test('the fitted MPM is structurally sound', () => {
        assertWellFormed(run.mpmXml, 'the MPM fitted for the aligned fixture')
    })

    for (const aspect of ['onset', 'duration', 'velocity'] as const) {
        test(`${aspect} error stays inside its recorded bound`, () => {
            const context = `${aspect}\n  measured: ${describeErrors(run.errors)}`
            expect(run.errors[aspect].mean, context).toBeLessThanOrEqual(BOUNDS[aspect].mean)
            expect(run.errors[aspect].max, context).toBeLessThanOrEqual(BOUNDS[aspect].max)
        })

        test(`the MPM accounts for the ${aspect} the recording departs by`, () => {
            const context = `${aspect}: bare score off by ${run.exercised[aspect].mean.toFixed(1)},`
                + ` the fit by ${run.errors[aspect].mean.toFixed(1)}`
            expect(run.explained[aspect], context).toBeGreaterThanOrEqual(EXPLAINED[aspect])
        })
    }
})
