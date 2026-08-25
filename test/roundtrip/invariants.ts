/**
 * Tier 0: what a fitted MPM must be true of regardless of how well it fits.
 *
 * These are asserted on **every** MPM every case produces, which is what makes them worth
 * having: they cost one parse, they need no ground truth, and between them they cover a
 * surprising share of the 2026-08 audit — #24 (open transitions), #28 (`@name.ref` pointing at
 * a definition that was never written), #30 (duplicate ids), #44/#45 (`NaN` written into an
 * attribute). A document that violates one of these is wrong before anyone measures it.
 */

const MAP_DEFINITIONS: Record<string, string> = {
    articulationMap: 'articulationDef',
    metricalAccentuationMap: 'accentuationPatternDef',
    ornamentationMap: 'ornamentDef',
}

/** Instruction elements whose `transition.to` needs a successor to render as a transition. */
const TRANSITIONING = new Set(['tempo', 'dynamics', 'movement'])

export interface Violation {
    check: string
    detail: string
}

const parse = (xml: string) => {
    const document = new DOMParser().parseFromString(xml, 'application/xml')
    const error = document.querySelector('parsererror')
    if (error) throw new Error(`MPM is not well-formed XML: ${error.textContent}`)
    return document
}

const localName = (element: Element) => element.localName ?? element.nodeName

export const findViolations = (xml: string): Violation[] => {
    const document = parse(xml)
    const violations: Violation[] = []
    const all = Array.from(document.querySelectorAll('*'))

    // ── ids are unique ────────────────────────────────────────────
    const seen = new Set<string>()
    for (const element of all) {
        const id = element.getAttribute('xml:id')
        if (!id) continue
        if (seen.has(id)) {
            violations.push({ check: 'unique xml:id', detail: `${id} is used more than once (#30)` })
        }
        seen.add(id)
    }

    // ── every attribute value is a value ──────────────────────────
    for (const element of all) {
        for (const attribute of Array.from(element.attributes)) {
            const value = attribute.value
            if (value === '' || value === 'undefined' || value === 'null'
                || value === 'NaN' || value === 'Infinity' || value === '-Infinity') {
                violations.push({
                    check: 'attribute values are values',
                    detail: `<${localName(element)} ${attribute.name}="${value}">`,
                })
            }
        }
    }

    // ── every @name.ref resolves ──────────────────────────────────
    const definedNames = (elementName: string) => new Set(
        Array.from(document.getElementsByTagName(elementName))
            .map(definition => definition.getAttribute('name'))
            .filter((name): name is string => !!name))

    const styleDefNames = definedNames('styleDef')

    for (const [mapName, definitionName] of Object.entries(MAP_DEFINITIONS)) {
        const maps = Array.from(document.getElementsByTagName(mapName))
        if (maps.length === 0) continue
        const available = definedNames(definitionName)

        for (const map of maps) {
            const styles = Array.from(map.children).filter(child => localName(child) === 'style')

            // Without a <style> switch nothing puts the styleDef in scope, so every @name.ref
            // in the map resolves to nothing and the instruction is inert. See old-bugs.md.
            const referencing = Array.from(map.children)
                .filter(child => localName(child) !== 'style' && child.hasAttribute('name.ref'))
            if (referencing.length > 0 && styles.length === 0) {
                violations.push({
                    check: 'a map that references definitions switches to a style',
                    detail: `${mapName} has ${referencing.length} @name.ref but no <style>`,
                })
            }

            for (const style of styles) {
                const reference = style.getAttribute('name.ref')
                if (reference && !styleDefNames.has(reference)) {
                    violations.push({
                        check: '@name.ref resolves',
                        detail: `<style name.ref="${reference}"> in ${mapName} names no <styleDef>`,
                    })
                }
                const fallback = style.getAttribute('defaultArticulation')
                if (fallback && !available.has(fallback)) {
                    violations.push({
                        check: '@name.ref resolves',
                        detail: `defaultArticulation="${fallback}" names no <${definitionName}> (#44)`,
                    })
                }
            }

            for (const instruction of referencing) {
                const reference = instruction.getAttribute('name.ref')!
                if (!available.has(reference)) {
                    violations.push({
                        check: '@name.ref resolves',
                        detail: `<${localName(instruction)} name.ref="${reference}"> names no <${definitionName}> (#28)`,
                    })
                }
            }

            // ── one style switch per date ─────────────────────────
            const dates = styles.map(style => style.getAttribute('date') ?? '0')
            const duplicated = dates.filter((date, index) => dates.indexOf(date) !== index)
            if (duplicated.length > 0) {
                violations.push({
                    check: 'one <style> per date',
                    detail: `${mapName} switches style twice at date ${duplicated[0]}`,
                })
            }
        }
    }

    // ── no transition without a successor ─────────────────────────
    for (const map of Array.from(document.querySelectorAll('*'))
        .filter(element => localName(element).endsWith('Map'))) {
        const instructions = Array.from(map.children)
            .filter(child => TRANSITIONING.has(localName(child)))
            .map(child => ({ element: child, date: Number(child.getAttribute('date') ?? 0) }))
            .sort((a, b) => a.date - b.date)

        for (const { element, date } of instructions) {
            if (!element.hasAttribute('transition.to')) continue
            const closed = instructions.some(other => other.date > date)
            if (!closed) {
                violations.push({
                    check: 'every transition is closed',
                    detail: `<${localName(element)} date="${date}"> has transition.to and no successor: `
                        + 'the renderer drops the transition and holds the start value (#24)',
                })
            }
        }
    }

    return violations
}

/** Throwing form, for use inside a test. */
export const assertWellFormed = (xml: string, label: string) => {
    const violations = findViolations(xml)
    if (violations.length === 0) return
    const report = violations.map(v => `  [${v.check}] ${v.detail}`).join('\n')
    throw new Error(`${label} violates ${violations.length} structural invariant(s):\n${report}`)
}
