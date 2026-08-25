/**
 * The record shapes mpmify's transformers speak.
 *
 * These were mpm-ts's `Dated.ts` / `Header.ts` types; they moved here unchanged when the
 * document model became espressivo's. Every key is the MPM attribute name it stands for —
 * `'name.ref'`, `'transition.to'`, `'xml:id'` — which is what lets `view.ts` map a record
 * property straight onto an attribute of the live element it wraps.
 *
 * Nothing here is a data holder any more. A value of one of these types is a *view* over an
 * `Element` in the espressivo tree: reading a property reads the attribute, writing one writes
 * it. See `view.ts`.
 */

/**
 * A part can be specified as either a given part number or global. Used in both MSM and MPM.
 */
export type Scope = number | 'global'

interface Typed<T extends string> {
    type: T
}

interface WithXmlId {
    'xml:id': string
}

interface WithCorresp {
    /** Space-separated argumentation ids; written by `AbstractTransformer.run`. */
    corresp?: string
}

export interface Style extends WithXmlId, Typed<'style'> {
    date: number
    'name.ref': string
    defaultArticulation?: string
}

export interface DatedInstruction<T extends string> extends Typed<T>, WithCorresp {
    date: number

    // optionally, a particular note can be specified
    noteid?: string

    // all instructions can be referencing a definition
    'name.ref'?: string
}

/** Maps the <dynamics> element of MPM */
export interface Dynamics extends DatedInstruction<'dynamics'>, WithXmlId {
    'volume': number | string
    'transition.to'?: number
    'protraction'?: number
    'curvature'?: number
}

/** Maps the <movement> element of MPM */
export interface Movement extends DatedInstruction<'movement'>, WithXmlId {
    'position': number
    'controller': 'sustain' | 'soft'
    'transition.to'?: number
    'protraction'?: number
    'curvature'?: number
}

/** Maps the <tempo> element of MPM */
export interface Tempo extends DatedInstruction<'tempo'>, WithXmlId {
    'bpm': number
    'beatLength': number
    'transition.to'?: number
    'meanTempoAt'?: number
}

/** Maps the <asynchrony> element of MPM */
export interface Asynchrony extends DatedInstruction<'asynchrony'>, WithXmlId {
    'milliseconds.offset': number
}

/** Maps the <articulation> element of MPM */
export interface Articulation extends DatedInstruction<'articulation'>, WithXmlId {
    relativeDuration?: number
    relativeVelocity?: number
    absoluteDuration?: number
    absoluteDurationChange?: number
}

export type NoteOffShift = boolean | 'monophonic'

/** Maps the <ornament> element of MPM */
export interface Ornament extends DatedInstruction<'ornament'>, WithXmlId {
    'name.ref': string
    'note.order'?: string
    'frameLength'?: number
    'frame.start'?: number
    'noteoff.shift'?: NoteOffShift,
    'intensity'?: number
    'transition.from'?: number
    'transition.to'?: number
    'time.unit'?: 'ticks' | 'milliseconds'
    'scale'?: number
}

/** Maps the <rubato> element of MPM */
export interface Rubato extends DatedInstruction<'rubato'>, WithXmlId {
    frameLength: number
    loop?: boolean
    intensity?: number
    lateStart?: number
    earlyEnd?: number
}

/** Maps the <accentuationPattern> element of MPM */
export interface AccentuationPattern extends DatedInstruction<'accentuationPattern'>, WithXmlId {
    'name.ref': string
    loop?: boolean
    scale: number
}

export type AnyInstruction =
    | Articulation
    | Asynchrony
    | Dynamics
    | Movement
    | Ornament
    | Rubato
    | Tempo
    | AccentuationPattern

/**
 * The instruction a given `InstructionType` names — so that a method taking the type as an
 * argument can return the record it stands for, rather than leaving the caller to assert it.
 */
export type InstructionOf<K extends InstructionType> = Extract<AnyInstruction, { type: K }>

export const instructionTypes = [
    'articulation',
    'asynchrony',
    'dynamics',
    'movement',
    'ornament',
    'rubato',
    'tempo',
    'accentuationPattern'
] as const

export type InstructionType = typeof instructionTypes[number]

/** Which `<dated>` map each instruction type lives in. */
export const mapNames = {
    'articulation': 'articulationMap',
    'asynchrony': 'asynchronyMap',
    'dynamics': 'dynamicsMap',
    'movement': 'movementMap',
    'ornament': 'ornamentationMap',
    'rubato': 'rubatoMap',
    'tempo': 'tempoMap',
    'accentuationPattern': 'metricalAccentuationMap'
} as const

// ── Definitions (the <header> side) ────────────────────────────────

export interface Definition<T extends string> extends Typed<T> {
    name: string
}

export interface DynamicsGradient extends Typed<'dynamicsGradient'> {
    'transition.from': number
    'transition.to': number
}

export interface TemporalSpread extends Typed<'temporalSpread'> {
    'frame.start': number
    frameLength: number
    'time.unit': 'ticks' | 'milliseconds'
    'noteoff.shift': NoteOffShift
    intensity?: number
}

export interface OrnamentDef extends Definition<'ornamentDef'> {
    dynamicsGradient?: DynamicsGradient
    temporalSpread?: TemporalSpread
}

export interface ArticulationDef extends Definition<'articulationDef'> {
    relativeDuration?: number
    relativeVelocity?: number
    absoluteDuration?: number
    absoluteDurationChange?: number
}

export interface Accentuation extends Typed<'accentuation'> {
    beat: number
    value: number
    'transition.from': number
    'transition.to': number
}

export interface AccentuationPatternDef extends Definition<'accentuationPatternDef'> {
    children: Accentuation[]
    length: number
}

export type AnyDefinition =
    | OrnamentDef
    | ArticulationDef
    | AccentuationPatternDef

export const definitionTypes = ['ornamentDef', 'articulationDef', 'accentuationPatternDef'] as const
export type DefinitionType = typeof definitionTypes[number]

/** Which `<header>` collection each definition type lives in. */
export const styleNames = {
    ornamentDef: 'ornamentationStyles',
    articulationDef: 'articulationStyles',
    accentuationPatternDef: 'metricalAccentuationStyles'
} as const

/**
 * The `<styleDef>` every mpmify-written definition goes into. mpmify has never written more
 * than one style per collection, and the `<style>` switches it emits all name this one.
 */
export const DEFAULT_STYLE_NAME = 'performance_style'

// ── Metadata ──────────────────────────────────────────────────────

export type RelatedResource = {
    uri: string
    type: string
}

export interface Author extends Typed<'author'> {
    number: number
    text: string
}

export interface Comment extends Typed<'comment'> {
    text: string
}

export interface Note extends Typed<'note'> {
    text: string
}

export interface TransformationInfo extends Typed<'transformation'> {
    'xml:id': string
    name: string
    cdata: string
    children: Note[]
}

export interface AppInfo extends Typed<'appInfo'> {
    version: string
    name: string
    url: string

    children: TransformationInfo[]
}

export type Metadata = (Author | Comment | RelatedResource | AppInfo)[]
