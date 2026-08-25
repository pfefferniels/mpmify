import { expect } from "vitest"
import { Bound, Case, describe as describeErrors, roundTrip, RoundTripResult } from "./harness"
import { assertWellFormed } from "./invariants"

/**
 * What every render-tier case asserts, in one place.
 *
 * Three things, in this order, because each is only meaningful once the one before it holds:
 *
 * 1. the truth actually does something — otherwise the case round-trips the bare score;
 * 2. the fitted MPM is structurally sound — a document with a dangling `@name.ref` or a `NaN`
 *    is wrong regardless of how it measures;
 * 3. the rendered error stays inside the case's recorded bounds.
 */
export const expectCase = (spec: Case): RoundTripResult => {
    const result = roundTrip(spec)

    // (1) A truth MPM the renderer ignores would make this case a tautology.
    const moved = Math.max(
        result.exercised.onset.max,
        result.exercised.duration.max,
        result.exercised.velocity.max)
    expect(moved, `the truth MPM for "${spec.name}" renders the same as no MPM at all`)
        .toBeGreaterThan(0)

    // (2) Structure before measurement.
    assertWellFormed(result.fittedXml, `the MPM fitted for "${spec.name}"`)

    // (3) Every note the truth sounded has to come back.
    expect(result.errors.missing, `notes the refit failed to produce in "${spec.name}"`).toBe(0)
    expect(result.errors.matched).toBeGreaterThan(0)

    checkBound(spec, 'onset', result.errors.onset, spec.bounds.onset, result)
    checkBound(spec, 'duration', result.errors.duration, spec.bounds.duration, result)
    checkBound(spec, 'velocity', result.errors.velocity, spec.bounds.velocity, result)

    return result
}

const checkBound = (
    spec: Case,
    aspect: string,
    measured: { mean: number, max: number },
    bound: Bound | undefined,
    result: RoundTripResult,
) => {
    if (!bound) return
    const context = `${spec.name} — ${aspect}`
        + (spec.note ? ` (${spec.note})` : '')
        + `\n  measured: ${describeErrors(result.errors)}`

    if (bound.mean !== undefined) {
        expect(measured.mean, context).toBeLessThanOrEqual(bound.mean)
    }
    if (bound.max !== undefined) {
        expect(measured.max, context).toBeLessThanOrEqual(bound.max)
    }
}
