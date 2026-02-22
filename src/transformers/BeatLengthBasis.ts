/**
 * Calculation of tempo or dynamics can be done on the basis of
 * whole bar, half bar, the denominator or for every single given note.
 */

export type BeatLengthBasis = 'bar' | 'halfbar' | 'thirdbar' | 'denominator' | 'everything' | number;
