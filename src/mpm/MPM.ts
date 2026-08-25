/**
 * mpmify's handle on an MPM document.
 *
 * The document itself is espressivo's — `Mpm → Performance → Global | Part → Header | Dated`,
 * a mutable XML tree. This class is the layer mpmify's transformers work through: it resolves
 * a `Scope` to an environment, creates maps and style collections on demand, and hands back
 * instructions and definitions as the records of `types.ts`, which are live views over the
 * elements (see `view.ts`). There is one copy of the data — the tree — and no write-back step.
 *
 * It replaces mpm-ts's class of the same name, method for method, with two differences that
 * are fixes rather than translations:
 *
 * - `insertStyle` puts the `<style>` switch at its date instead of at the end of the map.
 *   Appending it meant meico's backwards scan for the style in force found nothing, so every
 *   `@name.ref` in that map was unresolvable. See old-bugs.md.
 * - Reading an MPM goes through espressivo, which reads `<accentuationPattern>` — mpm-ts's
 *   `parseMPM` had no case for it and silently returned none.
 */
import {
    AccentuationPatternDef as EspAccentuationPatternDef,
    ArticulationDef as EspArticulationDef,
    Attribute,
    Dated,
    Document,
    Element,
    Global,
    Mpm,
    MPM_NAMESPACE,
    OrnamentDef as EspOrnamentDef,
    Part,
    Performance,
    type AnyStyle,
    type GenericMap,
} from 'espressivo'
import {
    AnyDefinition,
    AnyInstruction,
    DEFAULT_STYLE_NAME,
    DefinitionType,
    InstructionOf,
    InstructionType,
    instructionTypes,
    mapNames,
    Metadata,
    Rubato,
    Scope,
    Style,
    styleNames,
    AccentuationPattern,
    AccentuationPatternDef,
    RelatedResource,
} from './types'
import { elementFrom, elementOf, viewOf } from './view'

/** espressivo answers `Result<T, E>` in places; this is the "or give up" reading of one. */
const unwrap = <T>(result: T | { ok: boolean; value?: T }, what: string): T => {
    if (result && typeof result === 'object' && 'ok' in result) {
        if (!result.ok || result.value === undefined) {
            throw new Error(`espressivo could not build a ${what}`)
        }
        return result.value
    }
    return result as T
}

/** The `<performance>` mpmify writes into. mpm-ts wrote exactly one, unnamed. */
const PERFORMANCE_NAME = 'unknown'
const PULSES_PER_QUARTER = 720

export class MPM {
    /** The espressivo document. The single source of truth for everything this class answers. */
    readonly document: Mpm
    private readonly performance: Performance

    constructor(document?: Mpm) {
        if (document) {
            this.document = document
            const existing = document.getPerformance(0)
            if (!existing) {
                const performance = unwrap(
                    Performance.fromName(PERFORMANCE_NAME, PULSES_PER_QUARTER),
                    'performance'
                )
                document.addPerformance(performance)
                this.performance = performance
            } else {
                this.performance = existing
            }
            return
        }

        this.document = new Mpm()
        this.performance = unwrap(
            Performance.fromName(PERFORMANCE_NAME, PULSES_PER_QUARTER),
            'performance'
        )
        this.document.addPerformance(this.performance)
    }

    /** Parse MPM source. Unlike mpm-ts's reader this reads every map the format defines. */
    static parse(xml: string): MPM {
        return new MPM(new Mpm(xml))
    }

    /** The document as MPM source. */
    toXML(): string {
        return this.document.writeMpm() ?? ''
    }

    setPerformanceName(performanceName: string) {
        this.performance.setName(performanceName)
    }

    /**
     * A copy of this document with the maps of these instruction types taken out.
     *
     * The point is to ask what the rest of the MPM explains. Rendering `without(['articulation'])`
     * and comparing against the recording gives the deviation articulation still has to account
     * for — the same quantity the transformers used to accumulate by subtracting their own share
     * from the MSM, obtained by construction instead of by bookkeeping.
     *
     * The document is deep-copied, so this never disturbs the one being fitted. It is a probe:
     * render it and throw it away.
     */
    without(types: readonly InstructionType[]): MPM {
        const root = this.document.getRootElement()
        if (!root) return new MPM()

        const copy = root.copy()
        const dropped = new Set<string>(types.map(type => mapNames[type]))

        for (const performance of copy.getChildElements('performance', MPM_NAMESPACE).toArray()) {
            const environments = [
                ...performance.getChildElements('global', MPM_NAMESPACE).toArray(),
                ...performance.getChildElements('part', MPM_NAMESPACE).toArray(),
            ]
            for (const environment of environments) {
                for (const dated of environment.getChildElements('dated', MPM_NAMESPACE).toArray()) {
                    for (const map of dated.getChildElements().toArray()) {
                        if (dropped.has(map.getLocalName())) dated.removeChild(map)
                    }
                }
            }
        }

        return new MPM(new Mpm(new Document(copy)))
    }

    // ── scopes and environments ───────────────────────────────────

    /**
     * Every scope the document has something in — `'global'` first, then parts by number.
     *
     * The replacement for mpm-ts's `mpm.doc.performance.parts` iteration. `<global>` always
     * exists in an espressivo performance, so it is always listed; a transformer looping over
     * scopes finds no instructions there and moves on, exactly as it did for a part mpm-ts had
     * never been asked to create.
     */
    scopes(): Scope[] {
        const scopes: Scope[] = this.performance.getGlobal() ? ['global'] : []
        for (const part of this.performance.getAllParts()) {
            scopes.push(part.getNumber() - 1)
        }
        return scopes
    }

    /**
     * The `<global>` or `<part>` a scope names, created if `create` and it is not there yet.
     *
     * A part's `@number` is `scope + 1` and its `@midi.channel` is `scope`, which is the
     * numbering mpm-ts's serializer wrote and what `MSM.notesInPart` assumes.
     */
    private environment(scope: Scope, create: boolean): Global | Part | null {
        if (scope === 'global') return this.performance.getGlobal()

        const existing = this.performance.getPart(scope + 1)
        if (existing || !create) return existing

        const part = unwrap(
            Part.fromValues(`part_${scope}`, scope + 1, scope, 0),
            `part ${scope}`
        )
        this.performance.addPart(part)
        return part
    }

    private dated(scope: Scope, create: boolean): Dated | null {
        const environment = this.environment(scope, create)
        if (!environment) return null
        return create ? environment.requireDated() : environment.getDated()
    }

    private map(type: InstructionType, scope: Scope, create: boolean): GenericMap | null {
        const dated = this.dated(scope, create)
        if (!dated) return null
        const name = mapNames[type]
        return dated.getMap(name) ?? (create ? dated.addMapByType(name) : null)
    }

    private header(scope: Scope, create: boolean) {
        const environment = this.environment(scope, create)
        return environment?.getHeader() ?? null
    }

    /**
     * The `<styleDef>` mpmify writes definitions of `definitionType` into, created on demand.
     * There has only ever been one per collection.
     */
    private styleDef(definitionType: DefinitionType, scope: Scope, create: boolean): AnyStyle | null {
        const header = this.header(scope, create)
        if (!header) return null

        const collection = styleNames[definitionType]
        const existing = header.getStyleDef(collection, DEFAULT_STYLE_NAME)
        if (existing || !create) return existing
        return header.addStyleDef(collection, DEFAULT_STYLE_NAME)
    }

    // ── instructions ──────────────────────────────────────────────

    /**
     * Every instruction in a map, as live views, in document order. `<style>` switches are
     * excluded — `getStyles` answers those.
     *
     * Naming a type gives back that type: the caller states its intent once, in the argument,
     * and does not have to repeat it as an assertion the compiler cannot check.
     *
     * @param type the instruction type to filter for; all types if omitted
     * @param scope the part to read; every scope if omitted
     */
    getInstructions<K extends InstructionType>(type: K, scope?: Scope): InstructionOf<K>[]
    getInstructions(type?: undefined, scope?: Scope): AnyInstruction[]
    getInstructions(type?: InstructionType, scope?: Scope): AnyInstruction[] {
        const scopes: Scope[] = scope !== undefined ? [scope] : this.scopes()
        const types = type ? [type] : instructionTypes

        const result: AnyInstruction[] = []
        for (const one of scopes) {
            for (const instructionType of types) {
                const map = this.map(instructionType, one, false)
                if (!map) continue
                for (const entry of map.getAllElements()) {
                    if (entry.value.getLocalName() === 'style') continue
                    // The one unchecked step: a proxy over an element is whatever the map it
                    // sits in says it is, which no signature can prove.
                    result.push(viewOf<AnyInstruction>(entry.value))
                }
            }
        }
        return result
    }

    /**
     * The instruction with this `xml:id`, or null. It searches every map, so it cannot know
     * which type it will find — callers narrow on `.type`.
     */
    findInstructionById(id: string): AnyInstruction | null {
        for (const scope of this.scopes()) {
            for (const type of instructionTypes) {
                const element = this.map(type, scope, false)?.getElementByID(id)
                if (element && element.getLocalName() !== 'style') return viewOf<AnyInstruction>(element)
            }
        }
        return null
    }

    /**
     * Insert an instruction into the map its type calls for, at its date.
     *
     * An instruction already at the same `@date` and `@noteid` is *merged into* rather than
     * duplicated — which is not an optimisation but the mechanism by which
     * `InsertDynamicsGradient` and `InsertTemporalSpread` describe one `<ornament>` between
     * them. Without `overwrite`, a field the existing instruction already has a truthy value
     * for is left alone.
     *
     * @returns the view of the instruction that now holds the values — the existing one when
     * a merge happened, so a caller can hold on to the element it wrote.
     */
    insertInstruction<T extends AnyInstruction>(instruction: T, scope: Scope, overwrite = false): T {
        const map = this.map(instruction.type, scope, true)!

        // Not `getAllElementsAt`, which answers with the NEXT entry when the date it is given
        // holds none — that would merge a new instruction into a later one. The type test keeps
        // a `<style>` switch sharing the date out of it as well.
        const existing = map
            .getAllElements()
            .find(entry =>
                entry.key === instruction.date &&
                entry.value.getLocalName() === instruction.type &&
                (entry.value.getAttributeValue('noteid') ?? undefined) === instruction.noteid
            )?.value

        if (existing) {
            const view = viewOf<Record<string, unknown>>(existing)
            for (const [key, value] of Object.entries(instruction)) {
                if (!overwrite && view[key]) continue
                view[key] = value
            }
            return view as T
        }

        const element = elementFrom(
            instruction.type,
            instruction as unknown as Record<string, unknown>,
            MPM_NAMESPACE
        )
        map.addElement(element)
        return viewOf<T>(element)
    }

    insertInstructions<T extends AnyInstruction>(instructions: T[], scope: Scope, overwrite = false): T[] {
        return instructions.map(instruction => this.insertInstruction(instruction, scope, overwrite))
    }

    /** Remove the instruction this view stands for, wherever in the document it is. */
    removeInstruction(instruction: AnyInstruction) {
        const element = elementOf(instruction)
        if (!element) return

        for (const scope of this.scopes()) {
            const map = this.map(instruction.type, scope, false)
            if (!map || map.getElementIndexOf(element) < 0) continue
            map.removeElement(element)
            return
        }
    }

    // ── style switches ────────────────────────────────────────────

    /**
     * Add a `<style>` switch to an instruction map.
     *
     * It goes in *before* anything else at its date, so the style is in force for the
     * instructions that share it. mpm-ts appended style switches to the end of the map
     * regardless of date; see the class comment.
     */
    insertStyle(style: Style, instructionType: InstructionType, scope: Scope): Style {
        const map = this.map(instructionType, scope, true)!
        const index = map.addStyleSwitch(style.date, style['name.ref'], style['xml:id'])
        const element = map.getElement(index)!
        const view = viewOf<Style>(element)
        if (style.defaultArticulation !== undefined) {
            view.defaultArticulation = style.defaultArticulation
        }
        return view
    }

    getStyles(instructionType: InstructionType, scope: Scope): Style[] {
        const map = this.map(instructionType, scope, false)
        if (!map) return []
        return map
            .getAllElements()
            .filter(entry => entry.value.getLocalName() === 'style')
            .map(entry => viewOf<Style>(entry.value))
    }

    // ── definitions ───────────────────────────────────────────────

    /**
     * Put a definition into the `<styleDef>` of its collection, replacing any of the same name.
     *
     * The element is built here and then handed to espressivo's def factory, which adopts it —
     * so the typed def and the view returned by `getDefinitions` are two readings of one
     * element, not two copies.
     */
    insertDefinition(definition: AnyDefinition, scope: Scope): void {
        const style = this.styleDef(definition.type, scope, true)
        if (!style) return

        const element = elementFrom(
            definition.type,
            definition as unknown as Record<string, unknown>,
            MPM_NAMESPACE
        )
        const def = parseDefinition(definition.type, element)
        if (!def) return

        // `AnyStyle` is a union of seven `Style<K>`; `addDef` is typed per kind. The kind and
        // the def come from the same `definition.type`, which is what makes this sound.
        ;(style as { addDef(def: unknown): void }).addDef(def)
    }

    insertDefinitions(definitions: AnyDefinition[], scope: Scope) {
        definitions.forEach(definition => this.insertDefinition(definition, scope))
    }

    getDefinitions<T extends AnyDefinition>(type: DefinitionType, scope?: Scope): T[] {
        const scopes: Scope[] = scope !== undefined ? [scope] : this.scopes()
        const result: T[] = []
        for (const one of scopes) {
            const header = this.header(one, false)
            const styles = header?.getAllStyleDefs(styleNames[type])
            if (!styles) continue
            for (const style of styles.values()) {
                for (const def of style.getAllDefs().values()) {
                    result.push(viewOf<T>(def.getXml()))
                }
            }
        }
        return result
    }

    /** The first definition of this type with this name, in any scope. */
    getDefinition(definitionType: DefinitionType, name: string): AnyDefinition | null {
        return this.getDefinitions(definitionType).find(def => def.name === name) ?? null
    }

    /**
     * Remove the definition this view stands for.
     *
     * Found by element identity rather than by name: a caller may have renamed the definition
     * through its view, which leaves espressivo's by-name index keyed on the old name.
     */
    removeDefinition(definition: AnyDefinition) {
        const element = elementOf(definition)
        if (!element) return

        for (const scope of this.scopes()) {
            const header = this.header(scope, false)
            const styles = header?.getAllStyleDefs(styleNames[definition.type])
            if (!styles) continue
            for (const style of styles.values()) {
                for (const [key, def] of style.getAllDefs()) {
                    if (def.getXml() !== element) continue
                    style.removeDef(key)
                    return
                }
            }
        }
    }

    // ── queries ───────────────────────────────────────────────────

    /**
     * The instructions in force at a date: those exactly at it, plus the last one before it
     * where that instruction is still running.
     *
     * Ported from mpm-ts, with its loop variable corrected — it read the *requested* type
     * rather than the one being looped over, so an untyped call classified every instruction
     * as whatever type the loop had reached. `InsertRubato`, the only caller, always names a
     * type and never saw it.
     */
    instructionsEffectiveAtDate<K extends InstructionType>(date: number, type: K, scope?: Scope): InstructionOf<K>[]
    instructionsEffectiveAtDate(date: number, type?: undefined, scope?: Scope): AnyInstruction[]
    instructionsEffectiveAtDate(date: number, type?: InstructionType, scope?: Scope): AnyInstruction[] {
        const scopes: Scope[] = scope !== undefined ? [scope] : this.scopes()
        const types = type ? [type] : instructionTypes

        const result: AnyInstruction[] = []
        for (const instructionType of types) {
            for (const one of scopes) {
                const instructions = this.getInstructions(instructionType, one)

                result.push(...instructions.filter(instruction => instruction.date === date))

                const ongoing = instructions.slice().reverse().find(i => i.date <= date)
                if (!ongoing) continue

                if (instructionType === 'tempo' || instructionType === 'dynamics' || instructionType === 'movement') {
                    result.push(ongoing)
                }
                else if (instructionType === 'rubato') {
                    const rubato = ongoing as Rubato
                    if (rubato.loop) result.push(ongoing)
                    if (date < (rubato.date + rubato.frameLength)) result.push(ongoing)
                }
                else if (instructionType === 'accentuationPattern') {
                    const pattern = ongoing as AccentuationPattern
                    const def = pattern['name.ref']
                        ? this.getDefinition('accentuationPatternDef', pattern['name.ref']) as AccentuationPatternDef | null
                        : null
                    if (def && date < pattern.date + def.length * 720 * 4 / 4) {
                        result.push(ongoing)
                    }
                }
            }
        }
        return result
    }

    // ── metadata ──────────────────────────────────────────────────

    /**
     * Replace the document's `<metadata>`.
     *
     * Written as elements rather than through espressivo's `Mpm.addMetadata`, for two reasons.
     * `<appInfo>` — which mpmify emits and MPM's own schema allows — has no class there at all;
     * and `Author`, `Comment` and `RelatedResource`, the types `addMetadata` takes, are not
     * exported from the package, so the method cannot be called from outside it. The spelling
     * below is the one espressivo's own `Metadata.parseData` reads back.
     *
     * One thing does not survive: `appInfo`'s `cdata` becomes ordinary text content. espressivo's
     * serializer has no CDATA node, where mpm-ts wrapped it in a section.
     */
    setMetadata(metadata: Metadata) {
        this.document.removeMetadata()
        const root = this.document.getRootElement()
        if (!root) return
        for (const child of root.getChildElements('metadata', MPM_NAMESPACE).toArray()) {
            root.removeChild(child)
        }
        if (metadata.length === 0) return

        const element = new Element('metadata', MPM_NAMESPACE)
        let resources: Element | null = null

        for (const entry of metadata) {
            if (isRelatedResource(entry)) {
                if (!resources) {
                    resources = new Element('relatedResources', MPM_NAMESPACE)
                    element.appendChild(resources)
                }
                const resource = new Element('resource', MPM_NAMESPACE)
                resource.addAttribute(attributeOf('uri', entry.uri))
                resource.addAttribute(attributeOf('type', entry.type))
                resources.appendChild(resource)
                continue
            }

            switch (entry.type) {
                case 'author': {
                    const author = new Element('author', MPM_NAMESPACE)
                    author.addAttribute(attributeOf('number', String(entry.number)))
                    author.appendChild(entry.text)
                    element.appendChild(author)
                    break
                }
                case 'comment': {
                    const comment = new Element('comment', MPM_NAMESPACE)
                    comment.appendChild(entry.text)
                    element.appendChild(comment)
                    break
                }
                case 'appInfo':
                    element.appendChild(appInfoElement(entry))
                    break
            }
        }

        // `<metadata>` precedes `<performance>` in the MPM schema.
        root.insertChild(element, 0)
    }
}

// ── helpers ───────────────────────────────────────────────────────

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'

const attributeOf = (name: string, value: string) =>
    name === 'xml:id'
        ? new Attribute('xml:id', XML_NAMESPACE, value)
        : new Attribute(name, value)

/**
 * Read a definition element with the espressivo class its name calls for. The class adopts
 * the element rather than copying it, which is what keeps the typed def and the view in step.
 */
const parseDefinition = (type: DefinitionType, element: Element) => {
    switch (type) {
        case 'articulationDef':
            return unwrapOrNull(EspArticulationDef.createArticulationDef(element))
        case 'accentuationPatternDef':
            return unwrapOrNull(EspAccentuationPatternDef.fromXml(element))
        case 'ornamentDef':
            return unwrapOrNull(EspOrnamentDef.createOrnamentDef(element))
    }
}

const unwrapOrNull = <T>(result: { ok: boolean; value?: T }): T | null =>
    result.ok && result.value !== undefined ? result.value : null

/**
 * A `RelatedResource` is `{ uri, type }`, where `type` names the resource kind (`mei`, `audio`)
 * rather than discriminating the union — which is why it needs a predicate of its own.
 */
const isRelatedResource = (entry: Metadata[number]): entry is RelatedResource =>
    'uri' in entry

/** `<appInfo>` and its `<transformation>` children, which espressivo has no class for. */
const appInfoElement = (appInfo: Extract<Metadata[number], { type: 'appInfo' }>): Element => {
    const element = new Element('appInfo', MPM_NAMESPACE)
    element.addAttribute(attributeOf('name', appInfo.name))
    element.addAttribute(attributeOf('version', appInfo.version))
    element.addAttribute(attributeOf('url', appInfo.url))

    for (const transformation of appInfo.children) {
        const child = new Element('transformation', MPM_NAMESPACE)
        child.addAttribute(attributeOf('name', transformation.name))
        child.addAttribute(attributeOf('xml:id', transformation['xml:id']))
        if (transformation.cdata) child.appendChild(transformation.cdata)
        for (const note of transformation.children) {
            const noteElement = new Element('note', MPM_NAMESPACE)
            noteElement.appendChild(note.text)
            child.appendChild(noteElement)
        }
        element.appendChild(child)
    }
    return element
}
