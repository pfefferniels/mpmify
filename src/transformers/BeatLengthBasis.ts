/**
 * Calculation of tempo or dynamics can be done on the basis of
 * whole bar, half bar, the denominator or for every single given note.
 */

import { TimeSignature, MsmNote, ChordMap } from "../msm";

export const beatLengthBasis = ['bar', 'halfbar', 'thirdbar', 'denominator', 'everything'] as const;
export type BeatLengthBasis = typeof beatLengthBasis[number] | number;

export const calculateBeatLength = (beatLength: number | Omit<'everything', BeatLengthBasis>, timeSignature: TimeSignature) => {
    let result = 720;
    if (typeof beatLength === 'number') return beatLength * 4 * 720
    switch (beatLength) {
        case 'denominator':
            result = (4 / timeSignature.denominator);
            break;
        case 'bar':
            result = (4 / timeSignature.denominator) * timeSignature.numerator;
            break;
        case 'halfbar':
            result = (4 / timeSignature.denominator) * 0.5 * timeSignature.numerator;
            break;
        case 'thirdbar':
            result = (4 / timeSignature.denominator) * (1 / 3) * timeSignature.numerator;
            console.log('thirdbar=', result)
            break;
        case 'everything':
            throw new Error('calculating a regular beat length is not possible for value "everything"')
    }
    return result * 720;
}

export const filterByBeatLength = (beatLengthBasis: BeatLengthBasis, timeSignature: TimeSignature) => {
    return ([date, _]: [string, MsmNote[]]) => {
        if (beatLengthBasis === 'everything') return true
        return (+date % calculateBeatLength(beatLengthBasis, timeSignature) === 0)
    }
}

export const splitByBeatLength = (
    chords: ChordMap,
    beatLengthBasis: BeatLengthBasis,
    timeSignature: TimeSignature) => {
    if (beatLengthBasis === 'everything') return [chords]
    const newMaps = []
    let currentMap = new Map()
    for (const [date, chord] of chords) {
        if (date !== 0 && date % calculateBeatLength(beatLengthBasis, timeSignature) === 0) {
            newMaps.push(new Map(currentMap))
            currentMap = new Map()
        }
        currentMap.set(date, chord)
    }
    return newMaps
}
