// @vitest-environment jsdom

import { test } from "vitest"
import { allCases } from "./cases"
import { describe as describeErrors, roundTrip } from "./harness"
import { findViolations } from "./invariants"

/**
 * Prints what every case currently measures, so bounds can be re-recorded from evidence rather
 * than guessed at. Skipped unless asked for, because it is a report and not an assertion:
 *
 *     ROUNDTRIP_REPORT=1 npm run test:roundtrip:report
 */
test.skipIf(!process.env.ROUNDTRIP_REPORT)('round-trip report', () => {
    for (const spec of allCases) {
        try {
            const result = roundTrip(spec)
            const violations = findViolations(result.fittedXml)
            console.log(
                `${spec.name.padEnd(52)} ${describeErrors(result.errors)}`
                + (result.errors.missing ? `  MISSING ${result.errors.missing}` : '')
                + (violations.length
                    ? `\n    !! ${violations.map(v => `[${v.check}] ${v.detail}`).join('\n    !! ')}`
                    : ''))
        } catch (error) {
            console.log(`${spec.name.padEnd(52)} THREW ${(error as Error).message}`)
        }
    }
}, 120_000)
