/**
 * mpmify's MPM layer: the record types the transformers speak, and the espressivo-backed
 * document they are views onto.
 */
export * from './types'
export { MPM } from './MPM'
export { elementOf } from './view'

import { MPM } from './MPM'

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
