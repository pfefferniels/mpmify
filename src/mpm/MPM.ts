/**
 * mpmify's handle on an MPM document.
 *
 * The document is espressivo's — `Mpm → Performance → Global | Part → Header | Dated` — and so
 * is everything written into it. What is left here is what espressivo cannot answer, and it is
 * four things:
 *
 * 1. **A {@link Scope} is not an espressivo idea.** It is how mpmify and MSM name a part —
 *    `'global'` or an index — and turning one into a `<global>` or a numbered `<part>`, then
 *    into its `<dated>`, then into the map, creating each on the way, is the four steps
 *    {@link requireMap} takes so that no transformer repeats them.
 * 2. **espressivo reads by index and by type.** `getTempoOptionsOf(3)` is the shape it offers;
 *    "every `<tempo>` in scope S" is the question mpmify asks. {@link getInstructions} is that
 *    adapter, and the `READ` table above is the only thing left in this file that knows one
 *    instruction type from another.
 * 3. **The two sweeps.** {@link audit} answers what a transformer changed, what it left
 *    unnamed, and what it wrote as `NaN` — all by looking at the document afterwards rather
 *    than by intercepting anything.
 * 4. **What MPM does not define**: `@corresp` (see `corresp.ts`), the ornament draft (see
 *    `ornamentDraft.ts`) and `<appInfo>` — plus mpmify's one-`<styleDef>`-per-collection
 *    convention, which is what {@link ensureDefaultStyle} is.
 *
 * **Writing does not go through this class.** `requireMap(type, scope)` hands back espressivo's
 * own `TempoMap` / `DynamicsMap` / …, and a transformer calls `addTempo`, `updateTempoAt`,
 * `removeElement` on it directly. There used to be a generic `insertInstruction` here, with a
 * table dispatching it to the eight `add<X>` methods; it existed only because
 * `AbstractTransformer` collected its `created` list by intercepting every write. That list is
 * derived now, so the funnel is gone and so is the table's write half.
 *
 * Reads are **snapshots**. `getInstructions` hands back what the document says at the moment it
 * is asked; an earlier version proxied every property onto the element, which made
 * `tempo.bpm = 72` edit the document and a value that looks like data silently not be.
 *
 * The non-MPM attributes survive everything here, because espressivo only ever touches an
 * attribute one of its options types names.
 */
import {
    Attribute,
    collectionNameOfKind,
    Dated,
    Document,
    Element,
    Global,
    Mpm,
    MPM_NAMESPACE,
    Part,
    Performance,
    type AnyStyle,
    type MapOfKind,
} from 'espressivo'
import {
    AnyInstruction,
    DEFAULT_STYLE_NAME,
    DefOf,
    DefinitionType,
    Instruction,
    InstructionType,
    instructionTypes,
    mapNames,
    Metadata,
    InstructionOptions,
    Scope,
    Style,
    styleKinds,
    TransformationInfo,
} from './types'
import { PULSES_PER_QUARTER, PULSES_PER_WHOLE } from '../ppq'
import { v4 } from 'uuid'

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

/** `NaN`, `Infinity` and `-Infinity` as an attribute would be spelled. See {@link MPM.audit}. */
const NON_FINITE = /([\w.:]+)="(-?Infinity|NaN)"/g

/** The `<performance>` mpmify writes into. mpm-ts wrote exactly one, unnamed. */
const PERFORMANCE_NAME = 'unknown'

/** The espressivo map class an instruction type is written through. */
type MapFor<K extends InstructionType> = MapOfKind[(typeof mapNames)[K]]

/**
 * How one instruction type is read back out of its map.
 *
 * espressivo's readers are per-type and index-based — `getTempoOptionsOf(3)` — and mpmify's
 * question is "every instruction of type T in scope S". This table is the adapter between the
 * two, and it is the ONLY thing left here that knows one instruction type from another. Writing
 * needs no such table: a transformer that is inserting a `<tempo>` holds a `TempoMap` and calls
 * `addTempo` on it.
 *
 * A total mapped type over {@link InstructionType}, so a ninth type added to `OptionsOfType`
 * fails to compile here rather than falling through a `switch` at runtime.
 */
const READ: { readonly [K in InstructionType]: (map: MapFor<K>, index: number) => InstructionOptions<K> | null } = {
    tempo: (map, index) => map.getTempoOptionsOf(index),
    dynamics: (map, index) => map.getDynamicsOptionsOf(index),
    movement: (map, index) => map.getMovementOptionsOf(index),
    articulation: (map, index) => map.getArticulationOptionsOf(index),
    rubato: (map, index) => map.getRubatoOptionsOf(index),
    ornament: (map, index) => map.getOrnamentOptionsOf(index),
    accentuationPattern: (map, index) => map.getAccentuationPatternOptionsOf(index),
    asynchrony: (map, index) => map.getAsynchronyOptionsOf(index),
}

/**
 * What one walk of the document says about it: what every instruction currently is, and the two
 * things that are always bugs.
 *
 * `unnamed` — an instruction with no `@xml:id` gets no `@corresp`, cannot be named in a work
 * file, and has its span silently dropped by `deriveSegments`. That happened, and cost nine
 * `<tempo>` elements.
 *
 * `nonFinite` — `String(NaN)` is `'NaN'`, and `'NaN'` is a perfectly well-formed attribute
 * value: the document stays schema-valid and says something no renderer can act on, several
 * steps after the fit that produced it. espressivo will not refuse it (its RULE E1 freezes the
 * interior at logs-and-returns), so the guard is mpmify's. A sweep rather than a check on the
 * way in, which is what lets writes go straight through an espressivo map.
 */
export interface InstructionAudit {
    readonly fingerprints: Map<string, string>
    readonly unnamed: string[]
    readonly nonFinite: string[]
}

export class MPM {
    /** The espressivo document. The single source of truth for everything this class answers. */
    readonly document: Mpm
    private readonly performance: Performance

    constructor(document?: Mpm) {
        if (document) {
            this.document = document
            this.performance = document.getPerformance(0) ?? this.freshPerformance()
            return
        }

        this.document = new Mpm()
        this.performance = this.freshPerformance()
    }

    private freshPerformance(): Performance {
        const performance = unwrap(
            Performance.fromName(PERFORMANCE_NAME, PULSES_PER_QUARTER),
            'performance'
        )
        this.document.addPerformance(performance)
        return performance
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

        const copy = new MPM(new Mpm(new Document(root.copy())))
        for (const performance of copy.document.getAllPerformances()) {
            const environments: (Global | Part | null)[] = [
                performance.getGlobal(),
                ...performance.getAllParts(),
            ]
            for (const environment of environments) {
                const dated = environment?.getDated()
                if (!dated) continue
                for (const type of types) dated.removeMap(mapNames[type])
            }
        }
        return copy
    }

    /**
     * Every instruction in the document, by `xml:id`, as the text of its element.
     *
     * What `AbstractTransformer.run` diffs to find out what a transformer did. Comparing the
     * serialized element rather than a set of ids catches an instruction that was *changed* as
     * well as one that was added, which the interception it replaces could not: that recorded
     * what went through a generic `insertInstruction` and nothing else, so a transformer which
     * only edited an instruction went unattributed for it.
     *
     * An instruction with no `@xml:id` cannot appear here. {@link audit} is what notices.
     */
    fingerprints(): Map<string, string> {
        const result = new Map<string, string>()
        for (const instruction of this.getInstructions()) {
            if (instruction.id !== undefined) result.set(instruction.id, instruction.element.toXML())
        }
        return result
    }

    /**
     * One pass over every instruction, answering the three questions `AbstractTransformer.run`
     * asks after a transformer has run.
     *
     * One pass and not three, because each of them is a full walk of the document and `run` is
     * called once per transformer in the chain.
     */
    audit(): InstructionAudit {
        const fingerprints = new Map<string, string>()
        const unnamed: string[] = []
        const nonFinite: string[] = []

        for (const instruction of this.getInstructions()) {
            const xml = instruction.element.toXML()

            if (instruction.id === undefined) {
                unnamed.push(`<${instruction.type}> at ${String(instruction.date)}`)
            } else {
                fingerprints.set(instruction.id, xml)
            }

            // Read off the serialized text, not off the parsed options, and not for free: the
            // attributes that most need this are the ones a fitter computes, and two of those —
            // `@bpm` and `@volume` — may hold a style-relative NAME as well as a number, so
            // espressivo reads `bpm="NaN"` back as the string `'NaN'` and a test on the parsed
            // value sees a perfectly ordinary string. The text says what the document says.
            for (const [, name, value] of xml.matchAll(NON_FINITE)) {
                nonFinite.push(`<${instruction.type} @${name}>="${value}"`)
            }
        }

        return { fingerprints, unnamed, nonFinite }
    }

    // ── scopes and environments ───────────────────────────────────

    /**
     * Every scope the document has something in — `'global'` first, then parts by number.
     *
     * `<global>` always exists in an espressivo performance, so it is always listed; a
     * transformer looping over scopes finds no instructions there and moves on.
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

        const part = unwrap(Part.fromValues(`part_${scope}`, scope + 1, scope, 0), `part ${scope}`)
        this.performance.addPart(part)
        return part
    }

    private dated(scope: Scope, create: boolean): Dated | null {
        const environment = this.environment(scope, create)
        if (!environment) return null
        return create ? environment.requireDated() : environment.getDated()
    }

    /**
     * The espressivo map an instruction type lives in, in this scope, or null if there is none.
     *
     * **This is the method to reach for.** It is what mpmify adds that espressivo cannot: a
     * `Scope` is mpmify's and MSM's way of naming a part, and turning one into a `<global>` or a
     * numbered `<part>`, then into its `<dated>`, then into the map — creating each on the way
     * if asked — is four steps no transformer should repeat. What comes back is espressivo's own
     * `TempoMap`, `DynamicsMap` and so on, with its whole surface: `addTempo`,
     * `getTempoOptionsOf`, `updateTempoAt`, `getTempoAt`, `getAllElements`, `sort`.
     */
    mapOf<K extends InstructionType>(type: K, scope: Scope): MapFor<K> | null {
        return this.map(type, scope, false)
    }

    /** {@link mapOf}, creating the part, the `<dated>` and the map if they are not there yet. */
    requireMap<K extends InstructionType>(type: K, scope: Scope): MapFor<K> {
        return this.map(type, scope, true)!
    }

    private map<K extends InstructionType>(type: K, scope: Scope, create: boolean): MapFor<K> | null {
        const dated = this.dated(scope, create)
        if (!dated) return null

        const kind = mapNames[type]
        const existing = dated.getMapOfKind(kind)
        if (existing || !create) return existing

        dated.addMapByType(kind)
        return dated.getMapOfKind(kind)
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

        const collection = collectionNameOfKind(styleKinds[definitionType])
        if (collection === null) return null

        const existing = header.getStyleDef(collection, DEFAULT_STYLE_NAME)
        if (existing || !create) return existing
        return header.addStyleDef(collection, DEFAULT_STYLE_NAME)
    }

    // ── instructions ──────────────────────────────────────────────

    /** The snapshot for the entry at `index`, or null if it is not an instruction of that type. */
    private at<K extends InstructionType>(
        type: K,
        map: MapFor<K>,
        index: number,
        scope: Scope,
    ): Instruction<K> | null {
        const options = READ[type](map, index)
        const element = map.getElement(index)
        if (options === null || element === null) return null
        return { ...options, type, element, scope }
    }

    /**
     * Every instruction of a type, as snapshots, in document order. `<style>` switches are
     * excluded — `getStyles` answers those.
     *
     * Naming a type gives back that type: the caller states its intent once, in the argument,
     * and does not have to repeat it as an assertion the compiler cannot check. Naming none
     * gives every type, which is what a caller wanting the whole document asks for.
     *
     * @param type the instruction type to read; all types if omitted
     * @param scope the part to read; every scope if omitted
     */
    getInstructions<K extends InstructionType>(type: K, scope?: Scope): Instruction<K>[]
    getInstructions(type?: undefined, scope?: Scope): AnyInstruction[]
    getInstructions(type?: InstructionType, scope?: Scope): AnyInstruction[] {
        const scopes: Scope[] = scope !== undefined ? [scope] : this.scopes()
        const types = type ? [type] : instructionTypes

        const result: AnyInstruction[] = []
        for (const one of scopes) {
            for (const instructionType of types) {
                const map = this.map(instructionType, one, false)
                if (!map) continue
                for (let index = 0; index < map.size(); ++index) {
                    // The one uncorrelated step: `instructionType` is a loop variable over the
                    // union, so nothing ties it to the map it just produced. The pairing is
                    // `mapNames`', one line above.
                    const instruction = this.at(instructionType, map, index, one) as
                        AnyInstruction | null
                    if (instruction) result.push(instruction)
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
                const map = this.map(type, scope, false)
                const element = map?.getElementByID(id)
                if (!map || !element) continue
                // `type` is a loop variable over the union, so nothing correlates it with the
                // map it just produced. The pairing is `mapNames`', one line above.
                const found = this.at(type, map, map.getElementIndexOf(element), scope) as
                    AnyInstruction | null
                if (found) return found
            }
        }
        return null
    }

    /** Remove the instruction this snapshot stands for, wherever in the document it is. */
    removeInstruction(instruction: AnyInstruction) {
        for (const scope of this.scopes()) {
            const map = this.map(instruction.type, scope, false)
            if (!map || map.getElementIndexOf(instruction.element) < 0) continue
            map.removeElement(instruction.element)
            return
        }
    }

    // ── style switches ────────────────────────────────────────────

    /**
     * Add a `<style>` switch to an instruction map.
     *
     * It goes in *before* anything else at its date, so the style is in force for the
     * instructions that share it. mpm-ts appended style switches to the end of the map
     * regardless of date, which meant meico's backwards scan for the style in force found
     * nothing and every `@name.ref` in that map was unresolvable. See old-bugs.md.
     */
    insertStyle(style: Style, instructionType: InstructionType, scope: Scope): Style {
        const map = this.map(instructionType, scope, true)!
        const index = map.addStyleSwitch(style.date, style['name.ref'], style['xml:id'])
        const element = map.getElement(index)!
        if (style.defaultArticulation !== undefined) {
            element.addAttribute(new Attribute('defaultArticulation', style.defaultArticulation))
        }
        return this.styleAt(element)
    }

    private styleAt(element: Element): Style {
        return {
            'xml:id': element.getAttributeValue('xml:id') ?? '',
            date: parseFloat(element.getAttributeValue('date') ?? '0'),
            'name.ref': element.getAttributeValue('name.ref') ?? '',
            defaultArticulation: element.getAttributeValue('defaultArticulation') ?? undefined,
        }
    }

    /**
     * The `<style date="0">` switch that puts mpmify's own `<styleDef>` in scope for a map,
     * creating it only if the map has none.
     *
     * A `<style>` switch is what makes a `@name.ref` resolvable: without one in the map, meico's
     * backwards scan finds no style and every definition the header holds is unreachable. Six
     * transformers needed one and six wrote the same literal, of which four guarded on the map
     * being empty of styles and two did not — a latent duplicate, since neither this class nor
     * espressivo's `addStyleSwitch` deduplicates. Asking for the switch rather than inserting
     * one makes that unrepresentable, and lets the second caller amend what the first wrote
     * instead of shadowing it.
     *
     * @param extras fields to set on the switch, whether it was just created or already there.
     * `defaultArticulation` is the only one any caller has ever needed.
     */
    ensureDefaultStyle(
        instructionType: InstructionType,
        scope: Scope,
        extras: Pick<Style, 'defaultArticulation'> = {},
    ): Style {
        const map = this.map(instructionType, scope, true)!
        const existing = map
            .getAllElements()
            .find(entry =>
                entry.value.getLocalName() === 'style' &&
                entry.key === 0 &&
                entry.value.getAttributeValue('name.ref') === DEFAULT_STYLE_NAME
            )?.value

        const element = existing ?? map.getElement(
            map.addStyleSwitch(0, DEFAULT_STYLE_NAME, v4())
        )!

        if (extras.defaultArticulation !== undefined) {
            const attribute = element.getAttribute('defaultArticulation')
            if (attribute) attribute.setValue(extras.defaultArticulation)
            else element.addAttribute(new Attribute('defaultArticulation', extras.defaultArticulation))
        }

        return this.styleAt(element)
    }

    getStyles(instructionType: InstructionType, scope: Scope): Style[] {
        const map = this.map(instructionType, scope, false)
        if (!map) return []
        return map
            .getAllElements()
            .filter(entry => entry.value.getLocalName() === 'style')
            .map(entry => this.styleAt(entry.value))
    }

    // ── definitions ───────────────────────────────────────────────

    /**
     * Put a definition into the `<styleDef>` of its collection, replacing any of the same name.
     *
     * The def is espressivo's own class, built by the caller and adopted here — so the object
     * the caller holds and the one the document serializes are one thing, and a later setter
     * call on it edits the document.
     */
    insertDefinition<T extends DefinitionType>(type: T, definition: DefOf<T>, scope: Scope): void {
        const style = this.styleDef(type, scope, true)
        if (!style) return
        // `AnyStyle` is a union of seven `Style<K>`; `addDef` is typed per kind. The kind and
        // the def come from the same `type`, which is what makes this sound.
        ;(style as { addDef(def: unknown): void }).addDef(definition)
    }

    getDefinitions<T extends DefinitionType>(type: T, scope?: Scope): DefOf<T>[] {
        const scopes: Scope[] = scope !== undefined ? [scope] : this.scopes()
        const collection = collectionNameOfKind(styleKinds[type])
        if (collection === null) return []

        const result: DefOf<T>[] = []
        for (const one of scopes) {
            const styles = this.header(one, false)?.getAllStyleDefs(collection)
            if (!styles) continue
            for (const style of styles.values()) {
                for (const def of style.getAllDefs().values()) result.push(def as DefOf<T>)
            }
        }
        return result
    }

    /** The first definition of this type with this name, in any scope. */
    getDefinition<T extends DefinitionType>(type: T, name: string): DefOf<T> | null {
        return this.getDefinitions(type).find(def => def.getName() === name) ?? null
    }

    /**
     * Remove the definition this object stands for.
     *
     * Found by element identity rather than by name: a caller may have renamed the definition
     * through its setter, which leaves espressivo's by-name index keyed on the old name.
     */
    removeDefinition<T extends DefinitionType>(type: T, definition: DefOf<T>) {
        const collection = collectionNameOfKind(styleKinds[type])
        if (collection === null) return

        for (const scope of this.scopes()) {
            const styles = this.header(scope, false)?.getAllStyleDefs(collection)
            if (!styles) continue
            for (const style of styles.values()) {
                for (const [key, def] of style.getAllDefs()) {
                    if (def.getXml() !== definition.getXml()) continue
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
     */
    instructionsEffectiveAtDate<K extends InstructionType>(
        date: number,
        type: K,
        scope?: Scope,
    ): Instruction<K>[] {
        const scopes: Scope[] = scope !== undefined ? [scope] : this.scopes()

        const result: Instruction<K>[] = []
        for (const one of scopes) {
            const instructions = this.getInstructions(type, one)
            result.push(...instructions.filter(instruction => instruction.date === date))

            const ongoing = instructions.slice().reverse().find(i => i.date <= date)
            if (!ongoing) continue

            // `Instruction<K>` for a generic `K` is not a discriminated union, so `.type` does
            // not narrow it. Widening to the union first is what makes the three arms readable.
            const running = ongoing as AnyInstruction

            if (running.type === 'tempo' || running.type === 'dynamics' || running.type === 'movement') {
                result.push(ongoing)
            }
            else if (running.type === 'rubato') {
                if (running.loop) result.push(ongoing)
                // `@frameLength` is optional on the instruction — absent, the `rubatoDef` it
                // names supplies one. Reading that would mean resolving the def here; treating
                // absence as a zero-length frame keeps the old reading, which computed `NaN` and
                // so fell through the same way.
                if (date < running.date + (running.frameLength ?? 0)) result.push(ongoing)
            }
            else if (running.type === 'accentuationPattern') {
                const def = this.getDefinition(
                    'accentuationPatternDef',
                    running.accentuationPatternDefName
                )
                // `@length` is in bars; this reads them as whole notes, which is the 4/4 the
                // expression's `* 4 / 4` was spelling out. Unchanged, just named.
                if (def && date < running.date + def.getLength() * PULSES_PER_WHOLE / 4) {
                    result.push(ongoing)
                }
            }
        }
        return result
    }

    // ── metadata ──────────────────────────────────────────────────

    /**
     * Replace the document's `<metadata>`.
     *
     * `<author>`, `<comment>` and `<relatedResources>` are the three the ODD gives `<metadata>`,
     * and they go through espressivo's classes. `<appInfo>` is written by hand below because it
     * is **not MPM** — see the type's own comment — and espressivo correctly has no class for an
     * element the format does not define.
     *
     * One thing does not survive: `appInfo`'s `cdata` becomes ordinary text content, since
     * espressivo's serializer has no CDATA node.
     */
    setMetadata(metadata: Metadata) {
        this.document.removeMetadata()
        const root = this.document.getRootElement()
        if (!root) return
        for (const child of root.getChildElements('metadata', MPM_NAMESPACE).toArray()) {
            root.removeChild(child)
        }

        const element = new Element('metadata', MPM_NAMESPACE)
        let wrote = false

        for (const author of metadata.authors ?? []) {
            const child = new Element('author', MPM_NAMESPACE)
            child.addAttribute(new Attribute('number', String(author.number)))
            child.appendChild(author.text)
            element.appendChild(child)
            wrote = true
        }
        for (const comment of metadata.comments ?? []) {
            const child = new Element('comment', MPM_NAMESPACE)
            child.appendChild(comment.text)
            element.appendChild(child)
            wrote = true
        }
        if (metadata.appInfo) {
            element.appendChild(appInfoElement(metadata.appInfo))
            wrote = true
        }
        if (metadata.relatedResources?.length) {
            const resources = new Element('relatedResources', MPM_NAMESPACE)
            for (const resource of metadata.relatedResources) {
                const child = new Element('resource', MPM_NAMESPACE)
                child.addAttribute(new Attribute('uri', resource.uri))
                child.addAttribute(new Attribute('type', resource.type))
                resources.appendChild(child)
            }
            element.appendChild(resources)
            wrote = true
        }

        if (!wrote) return
        // `<metadata>` precedes `<performance>` in the MPM schema.
        root.insertChild(element, 0)
    }
}

// ── helpers ───────────────────────────────────────────────────────

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'

/** `<appInfo>` and its `<transformation>` children. Not MPM; see `types.ts`. */
const appInfoElement = (appInfo: NonNullable<Metadata['appInfo']>): Element => {
    const element = new Element('appInfo', MPM_NAMESPACE)
    element.addAttribute(new Attribute('name', appInfo.name))
    element.addAttribute(new Attribute('version', appInfo.version))
    element.addAttribute(new Attribute('url', appInfo.url))

    for (const transformation of appInfo.transformations) {
        element.appendChild(transformationElement(transformation))
    }
    return element
}

const transformationElement = (transformation: TransformationInfo): Element => {
    const element = new Element('transformation', MPM_NAMESPACE)
    element.addAttribute(new Attribute('name', transformation.name))
    element.addAttribute(new Attribute('xml:id', XML_NAMESPACE, transformation['xml:id']))
    if (transformation.cdata) element.appendChild(transformation.cdata)
    for (const note of transformation.notes) {
        const child = new Element('note', MPM_NAMESPACE)
        child.appendChild(note)
        element.appendChild(child)
    }
    return element
}
