/**
 * A record-shaped, live view over one element of the espressivo MPM tree.
 *
 * mpmify's transformers read and write MPM instructions as plain records — `tempo.bpm`,
 * `ornament['frame.start'] = …`, `delete o['time.unit']`. Under mpm-ts those records *were*
 * the document. Under espressivo the document is an XML tree, and this module is what lets the
 * same code keep working against it: every property access is an attribute access on the
 * element, so there is exactly one copy of the data and no step that has to write it back.
 *
 * The mapping is almost an identity, because the record keys of `types.ts` are the MPM
 * attribute names. `schema.ts` supplies the only thing that is not identical: how a value is
 * spelled as text.
 *
 * Two rules the callers rely on:
 *
 * - **One view per element.** `viewOf` caches, so two reads of the same instruction give the
 *   same object and `includes`/`indexOf` behave as they did when the records were the model.
 * - **An absent attribute reads as `undefined`,** and assigning `undefined` removes it — the
 *   same thing an optional record property meant before.
 * - **Do not assign `date`.** espressivo's `GenericMap` keeps a `(date, element)` index built
 *   when the element was added, and writing the attribute through a view updates the XML
 *   without touching that key — every later lookup then answers from a stale date. Nothing in
 *   mpmify does this today. If you need to move an instruction, write the attribute and call
 *   `map.sort()`, which is the only thing that re-reads the keys off the elements.
 *
 * A key the schema does not name is neither read nor written. That is what keeps transformers'
 * working fields (`endDate` on a fitted `<dynamics>`) out of the document.
 */
import { Attribute, Element } from 'espressivo'
import { AttrKind, ElementSchema, schemaOf } from './schema'

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'

/** Reaches the element behind a view. Not a string key, so it cannot collide with an attribute. */
const XML = Symbol('mpmify.element')

const views = new WeakMap<Element, object>()

/** The element a view stands for, or `null` for anything that is not a view. */
export const elementOf = (value: unknown): Element | null => {
    if (typeof value !== 'object' || value === null) return null
    return ((value as Record<symbol, unknown>)[XML] as Element | undefined) ?? null
}

// ── value spelling ────────────────────────────────────────────────

const readValue = (text: string, kind: AttrKind): unknown => {
    switch (kind) {
        case 'number':
            return parseFloat(text)
        case 'boolean':
            return text === 'true'
        case 'noteOffShift':
            return text === 'monophonic' ? 'monophonic' : text === 'true'
        case 'numberOrString': {
            const n = parseFloat(text)
            return Number.isFinite(n) && String(n) === text.trim() ? n : text
        }
        default:
            return text
    }
}

const writeValue = (value: unknown, kind: AttrKind): string => {
    if (kind === 'boolean' || kind === 'noteOffShift') {
        return typeof value === 'string' ? value : value ? 'true' : 'false'
    }
    return String(value)
}

const setAttribute = (element: Element, name: string, text: string) => {
    // Write through the Attribute that is already there, if there is one. espressivo's
    // `addAttribute` is documented as remove-then-append, so re-setting an existing attribute
    // moves it to the END of the serialized order — an edited document would then differ from
    // the one it came from by attribute order alone, on every attribute any transformer touched.
    //
    // `getAttribute` matches on the qualified name as well as the local one, so the bare
    // `'xml:id'` finds the namespaced attribute — the same lookup `removeAttribute` below does.
    const existing = element.getAttribute(name)
    if (existing) {
        existing.setValue(text)
        return
    }

    element.addAttribute(
        name === 'xml:id'
            ? new Attribute('xml:id', XML_NAMESPACE, text)
            : new Attribute(name, text)
    )
}

const removeAttribute = (element: Element, name: string) => {
    const attribute = element.getAttribute(name)
    if (attribute) element.removeAttribute(attribute)
}

// ── building elements from records ────────────────────────────────

/**
 * A fresh element carrying every schema-known property of `record` that is not `undefined`,
 * in schema order — which is the order they serialize in.
 */
export const elementFrom = (
    localName: string,
    record: Record<string, unknown>,
    namespace: string
): Element => {
    const schema = schemaOf(localName)
    if (!schema) throw new Error(`No MPM schema for <${localName}>`)

    const element = new Element(localName, namespace)
    for (const [key, kind] of Object.entries(schema.attributes)) {
        const value = record[key]
        if (value === undefined || value === null) continue
        setAttribute(element, key, writeValue(value, kind))
    }
    for (const [key, shape] of Object.entries(schema.children ?? {})) {
        const value = record[key]
        if (value === undefined || value === null) continue
        const items = shape.list ? (value as Record<string, unknown>[]) : [value as Record<string, unknown>]
        for (const item of items) {
            element.appendChild(elementFrom(shape.element, item, namespace))
        }
    }
    return element
}

// ── the view itself ───────────────────────────────────────────────

const childElements = (element: Element, name: string): Element[] =>
    element.getChildElements(name, element.getNamespaceURI()).toArray()

const readProperty = (element: Element, schema: ElementSchema, key: string): unknown => {
    if (key === 'type') return schema.type

    const kind = schema.attributes[key]
    if (kind !== undefined) {
        const text = element.getAttributeValue(key)
        return text === null ? undefined : readValue(text, kind)
    }

    const shape = schema.children?.[key]
    if (shape === undefined) return undefined

    const found = childElements(element, shape.element)
    if (shape.list) return found.map(child => viewOf(child))
    return found.length ? viewOf(found[0]) : undefined
}

const writeProperty = (element: Element, schema: ElementSchema, key: string, value: unknown): void => {
    // `type` is the element's own name; a record carrying it round-trips rather than renaming it.
    if (key === 'type') return

    const kind = schema.attributes[key]
    if (kind !== undefined) {
        if (value === undefined || value === null) removeAttribute(element, key)
        else setAttribute(element, key, writeValue(value, kind))
        return
    }

    const shape = schema.children?.[key]
    if (shape === undefined) return

    for (const existing of childElements(element, shape.element)) element.removeChild(existing)
    if (value === undefined || value === null) return

    const namespace = element.getNamespaceURI()
    const items = shape.list ? (value as Record<string, unknown>[]) : [value as Record<string, unknown>]
    for (const item of items) {
        const child = elementOf(item)
        element.appendChild(child ?? elementFrom(shape.element, item, namespace))
    }
}

const presentKeys = (element: Element, schema: ElementSchema): string[] => {
    const keys = ['type']
    for (const key of Object.keys(schema.attributes)) {
        if (element.getAttribute(key) !== null) keys.push(key)
    }
    for (const [key, shape] of Object.entries(schema.children ?? {})) {
        if (shape.list || childElements(element, shape.element).length) keys.push(key)
    }
    return keys
}

/**
 * The view for `element`, created on first ask and reused after.
 *
 * The proxy target is a bare object that is never read: every trap answers from the element.
 * `ownKeys`/`getOwnPropertyDescriptor` are what make `{...instruction}` and `Object.entries`
 * see the attributes rather than that empty target.
 */
export const viewOf = <T>(element: Element): T => {
    const cached = views.get(element)
    if (cached) return cached as T

    const schema = schemaOf(element.getLocalName())
    if (!schema) throw new Error(`No MPM schema for <${element.getLocalName()}>`)

    const view = new Proxy({} as Record<string | symbol, unknown>, {
        get(_target, key) {
            if (key === XML) return element
            if (typeof key === 'symbol') return undefined
            return readProperty(element, schema, key)
        },
        set(_target, key, value) {
            if (typeof key !== 'symbol') writeProperty(element, schema, key, value)
            return true
        },
        deleteProperty(_target, key) {
            if (typeof key !== 'symbol') writeProperty(element, schema, key, undefined)
            return true
        },
        has(_target, key) {
            if (key === XML) return true
            if (typeof key === 'symbol') return false
            return presentKeys(element, schema).includes(key)
        },
        ownKeys() {
            return presentKeys(element, schema)
        },
        getOwnPropertyDescriptor(_target, key) {
            if (typeof key === 'symbol') return undefined
            if (!presentKeys(element, schema).includes(key)) return undefined
            return {
                configurable: true,
                enumerable: true,
                value: readProperty(element, schema, key),
                writable: true,
            }
        },
    })

    views.set(element, view)
    return view as T
}
