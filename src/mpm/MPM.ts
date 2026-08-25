/**
 * mpmify's handle on an MPM document.
 *
 * The document is espressivo's — `Mpm → Performance → Global | Part → Header | Dated` — and so,
 * now, is everything written into it. This class resolves a {@link Scope} to an environment,
 * creates maps and style collections on demand, and routes each instruction type to the
 * espressivo map that owns it. It holds no model of MPM itself: the attribute an instruction
 * has, how it is spelled, and where it goes in the element are all questions espressivo answers.
 *
 * That is the difference from the version this replaces. That one carried a record type per
 * instruction and a table of attribute spellings (`types.ts` + `schema.ts`, 487 lines), and made
 * the records live by proxying every property access onto the element. All three are gone:
 * espressivo's `Add<X>Options` is the record, its `get<X>OptionsOf` is the read, and its
 * `update<X>At` is the write.
 *
 * Reads are therefore **snapshots**. `getInstructions` hands back what the document says at the
 * moment it is asked; changing it is {@link updateInstruction}, which says so at the call site.
 *
 * Two attributes mpmify writes are not MPM and are not routed through espressivo: `@corresp`
 * (see `corresp.ts`) and the ornament draft fields (see `ornamentDraft.ts`). Both survive
 * everything here, because espressivo only ever touches an attribute one of its options types
 * names.
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

/** The `<performance>` mpmify writes into. mpm-ts wrote exactly one, unnamed. */
const PERFORMANCE_NAME = 'unknown'

/** The espressivo map class an instruction type is written through. */
type MapFor<K extends InstructionType> = MapOfKind[(typeof mapNames)[K]]

/**
 * How one instruction type is read and written — three calls per row, all espressivo's.
 *
 * A total mapped type over {@link InstructionType}, so a ninth type added to `OptionsOfType`
 * fails to compile here rather than falling through a `switch` at runtime. It is also the whole
 * of what mpmify knows about the difference between instruction types: everything else in this
 * class is written once, against a row.
 */
interface MapOps<K extends InstructionType> {
    readonly add: (map: MapFor<K>, options: InstructionOptions<K>) => number
    readonly read: (map: MapFor<K>, index: number) => InstructionOptions<K> | null
    readonly update: (map: MapFor<K>, index: number, patch: Partial<InstructionOptions<K>>) => boolean
}

const MAP_OPS: { readonly [K in InstructionType]: MapOps<K> } = {
    tempo: {
        add: (map, options) => map.addTempo(options),
        read: (map, index) => map.getTempoOptionsOf(index),
        update: (map, index, patch) => map.updateTempoAt(index, patch),
    },
    dynamics: {
        add: (map, options) => map.addDynamics(options),
        read: (map, index) => map.getDynamicsOptionsOf(index),
        update: (map, index, patch) => map.updateDynamicsAt(index, patch),
    },
    movement: {
        add: (map, options) => map.addMovement(options),
        read: (map, index) => map.getMovementOptionsOf(index),
        update: (map, index, patch) => map.updateMovementAt(index, patch),
    },
    articulation: {
        add: (map, options) => map.addArticulation(options),
        read: (map, index) => map.getArticulationOptionsOf(index),
        update: (map, index, patch) => map.updateArticulationAt(index, patch),
    },
    rubato: {
        add: (map, options) => map.addRubato(options),
        read: (map, index) => map.getRubatoOptionsOf(index),
        update: (map, index, patch) => map.updateRubatoAt(index, patch),
    },
    ornament: {
        add: (map, options) => map.addOrnamentV3(options),
        read: (map, index) => map.getOrnamentOptionsOf(index),
        update: (map, index, patch) => map.updateOrnamentAt(index, patch),
    },
    accentuationPattern: {
        add: (map, options) => map.addAccentuationPattern(options),
        read: (map, index) => map.getAccentuationPatternOptionsOf(index),
        update: (map, index, patch) => map.updateAccentuationPatternAt(index, patch),
    },
    asynchrony: {
        add: (map, options) => map.addAsynchrony(options),
        read: (map, index) => map.getAsynchronyOptionsOf(index),
        update: (map, index, patch) => map.updateAsynchronyAt(index, patch),
    },
}

/**
 * Refuse a non-finite number before it becomes an attribute.
 *
 * `String(NaN)` is `'NaN'`, and `'NaN'` is a perfectly well-formed attribute value: the document
 * stays schema-valid and says something no renderer can act on, several steps after the fit that
 * produced it. espressivo will not refuse it — RULE E1 freezes its interior at logs-and-returns,
 * and throwing there would be a divergence — so the guard belongs on this side of the boundary,
 * which is also where the number was computed.
 */
const checkFinite = (type: string, options: Readonly<Record<string, unknown>>): void => {
    for (const [key, value] of Object.entries(options)) {
        if (typeof value === 'number' && !Number.isFinite(value)) {
            throw new Error(
                `Refusing to write <${type} @${key}>="${String(value)}": an MPM attribute must be `
                + 'a finite number. Whatever computed it produced NaN or an infinity — look '
                + 'there, not here.'
            )
        }
    }
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

    /** The espressivo map an instruction type lives in, typed as the class that owns it. */
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
        const options = MAP_OPS[type].read(map, index)
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

    /**
     * The element already at this date that a new instruction of this type would merge into.
     *
     * Not `getAllElementsAt`, which answers with the NEXT entry when the date it is given holds
     * none — that would merge a new instruction into a later one. The name test keeps a
     * `<style>` switch sharing the date out of it as well.
     */
    private mergeTarget(type: InstructionType, map: MapFor<InstructionType>, date: number, noteid?: string): number {
        for (let index = 0; index < map.size(); ++index) {
            const entry = map.getElement(index)
            if (!entry || entry.getLocalName() !== type) continue
            const entryDate = entry.getAttributeValue('date')
            if (entryDate === null || parseFloat(entryDate) !== date) continue
            if ((entry.getAttributeValue('noteid') ?? undefined) !== noteid) continue
            return index
        }
        return -1
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
     * @returns the instruction that now holds the values — the existing one when a merge
     * happened, so a caller can hold on to the element it wrote.
     */
    insertInstruction<K extends InstructionType>(
        type: K,
        options: InstructionOptions<K>,
        scope: Scope,
        overwrite = false,
    ): Instruction<K> {
        checkFinite(type, options as unknown as Readonly<Record<string, unknown>>)

        const map = this.map(type, scope, true)!
        const ops = MAP_OPS[type]
        const date = (options as { date: number }).date
        const noteid = (options as { noteid?: string }).noteid

        const existingIndex = this.mergeTarget(type, map, date, noteid)
        if (existingIndex >= 0) {
            const current = ops.read(map, existingIndex) as unknown as Readonly<Record<string, unknown>> | null
            const patch: Record<string, unknown> = {}
            for (const [key, value] of Object.entries(options)) {
                if (!overwrite && current && current[key]) continue
                patch[key] = value
            }
            ops.update(map, existingIndex, patch as Partial<InstructionOptions<K>>)
            return this.at(type, map, existingIndex, scope)!
        }

        return this.at(type, map, ops.add(map, options), scope)!
    }

    insertInstructions<K extends InstructionType>(
        type: K,
        options: readonly InstructionOptions<K>[],
        scope: Scope,
        overwrite = false,
    ): Instruction<K>[] {
        return options.map(one => this.insertInstruction(type, one, scope, overwrite))
    }

    /**
     * Change what an instruction says. A field the patch omits is left alone, one it carries as
     * `undefined` has its attribute removed.
     *
     * @returns a fresh snapshot, since the one that was passed in is now stale.
     */
    updateInstruction<K extends InstructionType>(
        instruction: Instruction<K>,
        patch: Partial<InstructionOptions<K>>,
    ): Instruction<K> {
        checkFinite(instruction.type, patch as unknown as Readonly<Record<string, unknown>>)

        const map = this.map(instruction.type, instruction.scope, false)
        const index = map?.getElementIndexOf(instruction.element) ?? -1
        if (!map || index < 0) return instruction

        MAP_OPS[instruction.type].update(map, index, patch)
        return this.at(instruction.type, map, index, instruction.scope)!
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
