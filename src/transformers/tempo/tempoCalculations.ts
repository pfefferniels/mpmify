import { Tempo } from "mpm-ts";

export interface WithEndDate {
    endDate: number
}

export type TempoWithEndDate = Tempo & WithEndDate

export const computeMillisecondsAt = (date: number, tempo: TempoWithEndDate) => {
    if (!tempo["transition.to"]) {
        return computeMillisecondsForConstantTempo(date, tempo)
    }

    return computeMillisecondsForTransition(date, tempo)
}

export const computeMillisecondsForConstantTempo = (date: number, tempo: TempoWithEndDate) => {
    return ((15000.0 * (date - tempo.date)) / (tempo.bpm * tempo.beatLength * 720));
}

export const computeMillisecondsForTransition = (date: number, tempo: TempoWithEndDate): number => {
    const N = 2 * Math.floor((date - tempo.date) / (720 / 4));
    const adjustedN = (N === 0) ? 2 : N;

    const n = adjustedN / 2;
    const x = (date - tempo.date) / adjustedN;

    const resultConst = (date - tempo.date) * 5000 / (adjustedN * tempo.beatLength * 720);
    let resultSum = 1 / tempo.bpm + 1 / getTempoAt(date, tempo);

    for (let k = 1; k < n; k++) {
        resultSum += 2 / getTempoAt(tempo.date + 2 * k * x, tempo);
    }

    for (let k = 1; k <= n; k++) {
        resultSum += 4 / getTempoAt(tempo.date + (2 * k - 1) * x, tempo);
    }

    return resultConst * resultSum;
}

export const getTempoAt = (date: number, tempo: TempoWithEndDate): number => {
    // no tempo
    if (!tempo.bpm) return 100.0;

    // constant tempo
    if (!tempo["transition.to"]) return tempo.bpm

    if (date >= tempo.endDate) return tempo["transition.to"]

    const result = (date - tempo.date) / (tempo.endDate - tempo.date);
    const exponent = Math.log(0.5) / Math.log(tempo.meanTempoAt || 0.5);
    return Math.pow(result, exponent) * (tempo["transition.to"] - tempo.bpm) + tempo.bpm;
}

