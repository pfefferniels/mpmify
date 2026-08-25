import { Element, GenericMap } from "espressivo"

/**
 * The three calls this makes on a map, which the caller names because it knows which map it is
 * holding. There is deliberately no table of instruction types behind this.
 */
export interface FillIn<O> {
    /** The element name to match on, so a `<style>` switch sharing the date is not filled in. */
    readonly localName: string
    readonly add: (options: O) => number
    readonly read: (index: number) => O | null
    readonly update: (index: number, patch: Partial<O>) => boolean
}

/**
 * The instruction of this kind already at this date, filled in with whatever it does not yet
 * say — or a new one, if there is none.
 *
 * Two places need this, and both are cases where **two transformers describe one element**:
 *
 * - `InsertDynamicsGradient` and `InsertTemporalSpread` each fit half of one `<ornament>`, a
 *   velocity ramp and a roll. Written separately they would be two `<ornament>`s at one date,
 *   and the renderer would apply both.
 * - `InsertDynamicsInstructions` closes each fitted transition with a `<dynamics>` at the end of
 *   its window, and the next segment's fit lands on that same date. One element carries the
 *   closing volume and the next curve; two make the closer shadow the curve.
 *
 * It used to be the behaviour of a general `MPM.insertInstruction`, which merged *any*
 * instruction at a matching date. That made a contract between named transformers look like a
 * property of the format, and left every other caller wondering whether its insert would
 * silently land inside an existing element. Here it is a call, at the two sites that mean it.
 *
 * A field the existing instruction already has a value for is left alone: the earlier
 * transformer's measurement wins, which is what the old `overwrite = false` default meant.
 */
export const fillInAt = <O extends { date: number; noteid?: string }>(
    map: GenericMap,
    options: O,
    ops: FillIn<O>,
): Element => {
    const existing = findAt(map, ops.localName, options.date, options.noteid)
    if (existing === null) return map.getElement(ops.add(options))!

    const index = map.getElementIndexOf(existing)
    const current = ops.read(index) as Record<string, unknown> | null
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(options)) {
        if (current?.[key]) continue
        patch[key] = value
    }
    ops.update(index, patch as Partial<O>)
    return existing
}

/**
 * Not `getAllElementsAt`, which answers with the NEXT entry when the date it is given holds
 * none — that would fill in a later instruction instead of writing a new one here.
 */
const findAt = (
    map: GenericMap,
    localName: string,
    date: number,
    noteid?: string,
): Element | null => {
    for (const { key, value } of map.getAllElements()) {
        if (key !== date || value.getLocalName() !== localName) continue
        if ((value.getAttributeValue('noteid') ?? undefined) !== noteid) continue
        return value
    }
    return null
}
