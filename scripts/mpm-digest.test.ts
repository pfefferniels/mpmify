// @vitest-environment jsdom

/**
 * A structural digest of what the chain produces, for the espressivo-integration migration.
 *
 * Not an assertion — a recorder. `MIGRATION_DIGEST=1 npx vitest run scripts/mpm-digest.test.ts`
 * writes one line per instruction element of every round-trip case to
 * `scripts/mpm-digest.txt`: case, scope, element name, and every attribute as `name=value`
 * sorted by name.
 *
 * Sorted, because the point is to compare the documents across a change that deliberately moves
 * attribute order — mpmify wrote `date xml:id bpm beatLength`, espressivo's `addTempo` writes
 * `date bpm transition.to meanTempoAt beatLength xml:id`. Sorting takes the one difference that
 * is expected out of the comparison and leaves every difference that is not.
 *
 * The chain is deterministic (`test/determinism.test.ts` folds it twice and compares), so a
 * digest taken before and after the migration must match line for line.
 */
import { describe, test } from "vitest"
import { writeFileSync } from "fs"
import { join } from "path"
import { allCases } from "../test/roundtrip/cases"
import { roundTrip } from "../test/roundtrip/harness"

const OUT = join(__dirname, 'mpm-digest.txt')

/**
 * `corresp` carries a fresh `v4()` per run — it points at the argumentation call that wrote the
 * element, and the round-trip harness does not pin those the way `test/determinism.test.ts`
 * does. Each distinct id becomes `#0`, `#1`, … in first-seen order, so *which elements share an
 * argumentation* is still compared and the random part is not.
 */
const canonicalIds = (attributes: string[], seen: Map<string, string>): string[] =>
    attributes.map(a => a.replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        id => {
            const known = seen.get(id)
            if (known !== undefined) return known
            const fresh = `#${String(seen.size)}`
            seen.set(id, fresh)
            return fresh
        },
    ))

/** Every element of an MPM document, as `path :: name attr=value …` with attributes sorted. */
const digest = (xml: string): string[] => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const lines: string[] = []
    const seen = new Map<string, string>()

    const walk = (element: Element, path: string) => {
        const here = `${path}/${element.localName}`
        const attributes = canonicalIds(
            [...element.attributes].map(a => `${a.name}="${a.value}"`).sort(),
            seen,
        )
        // Containers carry no information of their own; only leaves and named things are listed.
        if (attributes.length > 0) lines.push(`${here} ${attributes.join(' ')}`)
        for (const child of [...element.children]) walk(child, here)
    }

    const root = doc.documentElement
    if (root) walk(root, '')
    return lines
}

describe('mpm digest', () => {
    test.runIf(process.env.MIGRATION_DIGEST)('records what the chain writes', () => {
        const lines: string[] = []
        for (const spec of allCases) {
            lines.push(`### ${spec.name}`)
            const result = roundTrip(spec)
            lines.push(...digest(result.fittedXml).map(l => `  ${l}`))
        }
        writeFileSync(OUT, lines.join('\n') + '\n')
        console.log(`wrote ${String(lines.length)} lines to ${OUT}`)
    }, 300_000)
})
