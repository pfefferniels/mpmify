/**
 * What mpmify's transformers call an MPM instruction — which is now espressivo's own answer,
 * not a parallel one.
 *
 * These used to be twenty-odd record interfaces re-declaring every MPM attribute, plus a table
 * in `schema.ts` re-declaring how each one is spelled as text. espressivo already owns both:
 * `Add<X>Options` is the exact set of attributes its `add<X>` writes, and `get<X>OptionsOf`
 * reads an element back into one. So the instruction half of this file is a mapping from
 * mpmify's type names to those, and nothing else.
 *
 * Two things stayed:
 *
 * - **`Scope`.** MSM speaks it too, and espressivo's answer to the same question is a
 *   `Global | Part` object rather than an index. `MPM` converts.
 * - **The names.** mpmify says `tempo` where a `<dated>` child is called `tempoMap`, and
 *   `articulationDef` where a `<header>` collection is called `articulationStyles`. Both
 *   tables below are `satisfies`-checked against espressivo's own key types, so a name it
 *   renames stops compiling here rather than failing at runtime.
 */
import type {
    AddAccentuationPatternOptions,
    AddArticulationOptions,
    AddAsynchronyOptions,
    AddDynamicsOptions,
    AddMovementOptions,
    AddOrnamentOptions,
    AddRubatoOptions,
    AddTempoOptions,
    AccentuationPatternDef,
    ArticulationDef,
    Element,
    MapKind,
    OrnamentDef,
    StyleKind,
} from 'espressivo'

/**
 * A part can be specified as either a given part number or global. Used in both MSM and MPM.
 */
export type Scope = number | 'global'

// ── instructions ──────────────────────────────────────────────────

/** The espressivo options record each instruction type is written from and read back into. */
export interface OptionsOfType {
    tempo: AddTempoOptions
    dynamics: AddDynamicsOptions
    movement: AddMovementOptions
    articulation: AddArticulationOptions
    rubato: AddRubatoOptions
    ornament: AddOrnamentOptions
    accentuationPattern: AddAccentuationPatternOptions
    asynchrony: AddAsynchronyOptions
}

export type InstructionType = keyof OptionsOfType

/**
 * What a given instruction type is written from — so a caller states the type once.
 *
 * Not `OptionsOf`, which `Transformer.ts` already uses for the options of a *transformer*.
 */
export type InstructionOptions<K extends InstructionType> = OptionsOfType[K]

export const instructionTypes = [
    'articulation',
    'asynchrony',
    'dynamics',
    'movement',
    'ornament',
    'rubato',
    'tempo',
    'accentuationPattern',
] as const satisfies readonly InstructionType[]

/**
 * One instruction as it stands in the document: everything it says, plus where it is.
 *
 * A **snapshot**, not a live view. Under mpm-ts these records were the document and assigning
 * to one edited it; the espressivo port kept that with a proxy, which meant a value that looked
 * like data and was not. Reading is now reading and writing is `MPM.updateInstruction`, which
 * says at the call site that the document changed.
 *
 * `element` is the identity that survives the snapshot — what `updateInstruction` and
 * `removeInstruction` find the instruction by, and what {@link corresp} and the ornament draft
 * hang off. Do not read attributes off it directly; that is what the options are for.
 */
export type Instruction<K extends InstructionType> = InstructionOptions<K> & {
    readonly type: K
    readonly element: Element
    readonly scope: Scope
}

/** Any instruction, as a union over the types — not an intersection of all of them. */
export type AnyInstruction = { [K in InstructionType]: Instruction<K> }[InstructionType]

/** Which `<dated>` map each instruction type lives in. */
export const mapNames = {
    articulation: 'articulationMap',
    asynchrony: 'asynchronyMap',
    dynamics: 'dynamicsMap',
    movement: 'movementMap',
    ornament: 'ornamentationMap',
    rubato: 'rubatoMap',
    tempo: 'tempoMap',
    accentuationPattern: 'metricalAccentuationMap',
} as const satisfies Record<InstructionType, MapKind>

// ── definitions ───────────────────────────────────────────────────

/** The espressivo class each definition type is. */
export interface DefOfType {
    articulationDef: ArticulationDef
    ornamentDef: OrnamentDef
    accentuationPatternDef: AccentuationPatternDef
}

export type DefinitionType = keyof DefOfType
export type DefOf<T extends DefinitionType> = DefOfType[T]

export const definitionTypes = [
    'ornamentDef',
    'articulationDef',
    'accentuationPatternDef',
] as const satisfies readonly DefinitionType[]

/**
 * The style kind each definition type belongs to. espressivo names the `<header>` collection
 * from this (`collectionNameOfKind`), so mpmify never spells `articulationStyles` itself.
 */
export const styleKinds = {
    articulationDef: 'articulation',
    ornamentDef: 'ornamentation',
    accentuationPatternDef: 'metricalAccentuation',
} as const satisfies Record<DefinitionType, StyleKind>

/** A `<style>` switch: which `<styleDef>` is in force from a date. */
export interface Style {
    'xml:id': string
    date: number
    'name.ref': string
    defaultArticulation?: string
}

/**
 * The `<styleDef>` every mpmify-written definition goes into. mpmify has never written more
 * than one style per collection, and the `<style>` switches it emits all name this one.
 */
export const DEFAULT_STYLE_NAME = 'performance_style'

// ── metadata ──────────────────────────────────────────────────────

export type RelatedResourceSpec = {
    uri: string
    type: string
}

export interface Author {
    number: number
    text: string
}

export interface Comment {
    text: string
}

export interface TransformationInfo {
    'xml:id': string
    name: string
    cdata: string
    notes: string[]
}

/**
 * `<appInfo>` and its `<transformation>` children.
 *
 * **This is not MPM.** The ODD gives `<metadata>` exactly `author*`, `comment*` and one
 * optional `<relatedResources>` (`axelberndt/MPM`, `src/specs/metadata.xml`) — there is no
 * `appInfo` element in the schema, and the comment that used to sit here claiming otherwise was
 * wrong. mpmify writes it anyway, because the transformation record is what a work file is for;
 * it is written by hand, here, rather than through espressivo, which correctly has no class for
 * an element the format does not define.
 */
export interface AppInfo {
    version: string
    name: string
    url: string
    transformations: TransformationInfo[]
}

export interface Metadata {
    authors?: Author[]
    comments?: Comment[]
    relatedResources?: RelatedResourceSpec[]
    appInfo?: AppInfo
}
