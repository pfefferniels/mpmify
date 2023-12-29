/**
 * Calculation of tempo or dynamics can be done on the basis of
 * whole bar, half bar, the denominator or for every single given note.
 */

import { TimeSignature, MsmNote } from "../msm";

export const beatLengthBasis = ['bar', 'halfbar', 'thirdbar', 'denominator', 'everything'] as const;
export type BeatLengthBasis = typeof beatLengthBasis[number];

export const calculateBeatLength = (beatLength: Omit<'everything', BeatLengthBasis>, timeSignature: TimeSignature) => {
    let result = 720;
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

export const splitByBeatLength = (beatLengthBasis: BeatLengthBasis, timeSignature: TimeSignature) => {
    return (
        prev: [string, MsmNote[]][][],
        [date, chord]: [string, MsmNote[]]) => {
        if (beatLengthBasis === 'everything') {
            prev.push([[date, chord]])
        }

        if (+date % calculateBeatLength(beatLengthBasis, timeSignature) === 0) {
            prev.push([[date, chord]])
        }
        else {
            const lastChunk = prev[prev.length - 1]
            if (!lastChunk) return prev 

            lastChunk.push([date, chord])
        }
        return prev
    }
}