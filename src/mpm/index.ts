/**
 * mpmify's MPM layer: espressivo's document, and the thin routing that puts a {@link Scope} and
 * an instruction type in front of it.
 *
 * There is no record model here any more. `types.ts` names espressivo's `Add<X>Options` as the
 * shape of each instruction, and the two modules beside it hold the only two things mpmify
 * writes that MPM does not define — `@corresp` and the ornament draft.
 */
export * from './types'
export { MPM } from './MPM'
export * from './corresp'
export * from './ornamentDraft'

/**
 * The espressivo classes a transformer builds a definition with, re-exported so that writing an
 * `<articulationDef>` does not mean importing from two packages at once.
 */
export {
    AccentuationPatternDef,
    ArticulationDef,
    FrameDomain,
    NoteOffShift,
    OrnamentDef,
} from 'espressivo'

import type { AnyResult, OkOf } from 'espressivo'
import { MPM } from './MPM'

/**
 * The value of one of espressivo's `Result`-returning factories, or a throw naming the reason.
 *
 * The def factories are total over the documents mpmify hands them — a name it just generated,
 * a length it just computed — so a failure here is a bug in the caller and not a case to branch
 * on. Written once so that no transformer has to decide what to do about a `Result` it cannot
 * meaningfully recover from.
 */
export const definitionOf = <R extends AnyResult>(result: R): OkOf<R> => {
    if (!result.ok) {
        throw new Error(`espressivo refused to build a definition: ${JSON.stringify(result.error)}`)
    }
    return result.value as OkOf<R>
}

/**
 * Read MPM source.
 *
 * Be aware that espressivo's parser *repairs*: it fills in `pulsesPerQuarter`, gives
 * `accentuationPatternDef` a `length`, re-sorts every map by date and drops duplicate maps. A
 * round trip is therefore normalising, not faithful.
 */
export const parseMPM = (xml: string): MPM => MPM.parse(xml)

/** Serialize an MPM document. */
export const exportMPM = (mpm: MPM): string => mpm.toXML()
