/**
 * What each MPM element's attributes mean, as data.
 *
 * `view.ts` reads this table to turn an `Element` into one of `types.ts`'s records and back.
 * The record keys ARE the attribute names, so a row is only ever saying *how to spell a value*
 * — never how to rename it.
 *
 * A key absent from a row is not written. That is deliberate and load-bearing: transformers
 * carry working fields on their records (`endDate` on a fitted `<dynamics>`, above all) that
 * have no place in an MPM document, and the table is what keeps them out of it.
 */

/** How an attribute's text spells its value. */
export type AttrKind =
    /** `date`, `bpm`, `intensity` — parsed with `parseFloat`. */
    | 'number'
    /** `name.ref`, `noteid`, `controller` — verbatim. */
    | 'string'
    /** `loop` — `"true"` / `"false"`. */
    | 'boolean'
    /**
     * `volume`, `bpm` — a number, or a style-relative name (`"forte"`, `"Allegro"`). Numeric
     * text reads back as a number, anything else as the string it is.
     */
    | 'numberOrString'
    /** `noteoff.shift` — `"true"` / `"false"` / `"monophonic"`. */
    | 'noteOffShift'

export interface ChildShape {
    /** Local name of the child element. */
    readonly element: string
    /** Whether the property holds an array of children rather than a single one. */
    readonly list?: boolean
}

export interface ElementSchema {
    /** The record's `type` discriminant. Equal to the element's local name throughout MPM. */
    readonly type: string
    readonly attributes: Readonly<Record<string, AttrKind>>
    /** Child elements reached as record properties. */
    readonly children?: Readonly<Record<string, ChildShape>>
}

/** Attributes every dated instruction may carry. */
const DATED = {
    date: 'number',
    noteid: 'string',
    'name.ref': 'string',
    'xml:id': 'string',
    corresp: 'string',
} as const satisfies Record<string, AttrKind>

/**
 * What an articulation *does* to a note, as attributes.
 *
 * The same four sit on `<articulation>` and on `<articulationDef>`, and they mean the same thing
 * in both places — that is the whole of MPM's def mechanism: an instruction states the modifiers
 * inline, or names a def that states them. So they are named once rather than kept in step by
 * hand. (MPM defines more of these; these four are the ones mpmify reads and writes.)
 */
const ARTICULATION_MODIFIERS = {
    relativeDuration: 'number',
    relativeVelocity: 'number',
    absoluteDuration: 'number',
    absoluteDurationChange: 'number',
} as const satisfies Record<string, AttrKind>

const SCHEMAS = {
    tempo: {
        type: 'tempo',
        attributes: {
            ...DATED,
            bpm: 'numberOrString',
            beatLength: 'number',
            'transition.to': 'numberOrString',
            meanTempoAt: 'number',
        },
    },
    dynamics: {
        type: 'dynamics',
        attributes: {
            ...DATED,
            volume: 'numberOrString',
            'transition.to': 'numberOrString',
            protraction: 'number',
            curvature: 'number',
            subNoteDynamics: 'boolean',
        },
    },
    movement: {
        type: 'movement',
        attributes: {
            ...DATED,
            position: 'number',
            controller: 'string',
            'transition.to': 'number',
            protraction: 'number',
            curvature: 'number',
        },
    },
    articulation: {
        type: 'articulation',
        attributes: {
            ...DATED,
            ...ARTICULATION_MODIFIERS,
        },
    },
    asynchrony: {
        type: 'asynchrony',
        attributes: {
            ...DATED,
            'milliseconds.offset': 'number',
        },
    },
    /**
     * `frame.start`, `frameLength`, `noteoff.shift`, `time.unit`, `intensity` and the two
     * `transition.*` are not part of the `<ornament>` schema — they belong on the
     * `ornamentDef` its `@name.ref` points at. mpmify parks them on the instruction between
     * `InsertTemporalSpread` and `StylizeOrnamentation`, which is the step that moves them
     * into a def and deletes them again. See `StylizeOrnamentation.transform`.
     */
    ornament: {
        type: 'ornament',
        attributes: {
            ...DATED,
            'note.order': 'string',
            scale: 'number',
            frameLength: 'number',
            'frame.start': 'number',
            'noteoff.shift': 'noteOffShift',
            intensity: 'number',
            'transition.from': 'number',
            'transition.to': 'number',
            'time.unit': 'string',
        },
    },
    rubato: {
        type: 'rubato',
        attributes: {
            ...DATED,
            frameLength: 'number',
            loop: 'boolean',
            intensity: 'number',
            lateStart: 'number',
            earlyEnd: 'number',
        },
    },
    accentuationPattern: {
        type: 'accentuationPattern',
        attributes: {
            ...DATED,
            loop: 'boolean',
            scale: 'number',
        },
    },
    style: {
        type: 'style',
        attributes: {
            date: 'number',
            'name.ref': 'string',
            defaultArticulation: 'string',
            'xml:id': 'string',
        },
    },

    // ── definitions ───────────────────────────────────────────────
    articulationDef: {
        type: 'articulationDef',
        attributes: {
            name: 'string',
            'xml:id': 'string',
            ...ARTICULATION_MODIFIERS,
        },
    },
    accentuationPatternDef: {
        type: 'accentuationPatternDef',
        attributes: {
            name: 'string',
            'xml:id': 'string',
            length: 'number',
        },
        children: {
            children: { element: 'accentuation', list: true },
        },
    },
    accentuation: {
        type: 'accentuation',
        attributes: {
            'xml:id': 'string',
            beat: 'number',
            value: 'number',
            'transition.from': 'number',
            'transition.to': 'number',
        },
    },
    ornamentDef: {
        type: 'ornamentDef',
        attributes: {
            name: 'string',
            'xml:id': 'string',
        },
        children: {
            dynamicsGradient: { element: 'dynamicsGradient' },
            temporalSpread: { element: 'temporalSpread' },
        },
    },
    dynamicsGradient: {
        type: 'dynamicsGradient',
        attributes: {
            'xml:id': 'string',
            'transition.from': 'number',
            'transition.to': 'number',
        },
    },
    temporalSpread: {
        type: 'temporalSpread',
        attributes: {
            'xml:id': 'string',
            'frame.start': 'number',
            frameLength: 'number',
            'time.unit': 'string',
            'noteoff.shift': 'noteOffShift',
            intensity: 'number',
        },
    },
} as const satisfies Record<string, ElementSchema>

export const schemaOf = (localName: string): ElementSchema | undefined =>
    (SCHEMAS as Record<string, ElementSchema>)[localName]
