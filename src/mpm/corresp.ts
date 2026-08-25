/**
 * `@corresp` — the link from an MPM element to the argumentation that produced it.
 *
 * **This is not MPM.** The attribute appears nowhere in the ODD; it is mpmify's own, written by
 * `AbstractTransformer.run` so that a saved work file can say which call wrote which element.
 * That is exactly why it lives in a module of its own rather than in an options type: espressivo
 * writes MPM and nothing else, and `patchAttribute` only ever touches attributes an options type
 * names — so an element's `@corresp` survives every insert, patch and read it goes through.
 *
 * The value is a space-separated list of ids, in the order they were added.
 */
import { Attribute, Element } from 'espressivo'

const CORRESP = 'corresp'

/** The argumentation ids this element is attributed to, or an empty list. */
export const correspOf = (element: Element): string[] => {
    const value = element.getAttributeValue(CORRESP)
    return value ? value.split(' ').filter(Boolean) : []
}

/**
 * Attribute this element to `id` as well, if it is not attributed to it already.
 *
 * Additive because one element can be the work of more than one call — `InsertDynamicsGradient`
 * and `InsertTemporalSpread` write one `<ornament>` between them, and each wants its own name
 * on it.
 */
export const addCorresp = (element: Element, id: string): void => {
    const ids = correspOf(element)
    if (ids.includes(id)) return
    ids.push(id)

    const existing = element.getAttribute(CORRESP)
    if (existing) existing.setValue(ids.join(' '))
    else element.addAttribute(new Attribute(CORRESP, ids.join(' ')))
}
