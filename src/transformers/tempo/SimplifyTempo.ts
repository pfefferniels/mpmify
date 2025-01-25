import { v4 } from "uuid";
import { clamp } from "../../utils/utils";
import { TempoWithEndDate, computeMillisecondsAt } from "./tempoCalculations";

export type Point = [number, number];

const simulatedAnnealing = (
    serieses: Point[][],
    initialTempos: TempoWithEndDate[],
    initialTemperature: number = 500,
    coolingRate: number = 0.995,
    maxIterations: number = 1000,
): TempoWithEndDate[] => {
    if (serieses.length !== initialTempos.length) {
        throw new Error('The number of serieses and initial tempos must match.')
    }

    let currentTempos = initialTempos.slice();
    let bestTempos = [...initialTempos];
    let bestError = currentTempos.reduce((acc, tempo, i) => acc + computeTotalError(tempo, serieses[i]), 0);
    let temperature = initialTemperature;

    for (let iteration = 0; iteration < maxIterations && temperature > 0.001; iteration++) {
        const neighboringTempos = generateNeighboringTempos(currentTempos);

        const currentError = currentTempos.reduce((acc, tempo, i) => acc + computeTotalError(tempo, serieses[i]), 0);
        const neighborError = neighboringTempos.reduce((acc, tempo, i) => acc + computeTotalError(tempo, serieses[i]), 0);
        // console.log('trying', neighborError, 'for', neighboringTempo)

        if (Math.exp((currentError - neighborError) / temperature) > Math.random()) {
            currentTempos = neighboringTempos;
        }

        if (neighborError < bestError) {
            bestError = neighborError;
            // console.log('new best error=', neighborError, 'for', neighboringTempo)
            bestTempos = neighboringTempos;
        }

        if (bestError < 10.0) {
            break;
        }

        temperature *= coolingRate;
    }

    return bestTempos;
};

const generateNeighboringTempos = (tempos: TempoWithEndDate[]): TempoWithEndDate[] => {
    const variation = 0.2;
    const randomVariation = Math.random() * variation

    const newTempos: TempoWithEndDate[] = [];

    let prevTransitionTo: number | undefined = undefined
    for (const tempo of tempos) {
        const isAcc = tempo.bpm < tempo["transition.to"]!

        // If the start point is fixed, do not apply 
        // any variation to it
        let newBPM = prevTransitionTo || (tempo.bpm + (isAcc ? -randomVariation : randomVariation))
        const newTransitionTo = tempo["transition.to"]! + (isAcc ? randomVariation : -randomVariation)

        if (isAcc && newTransitionTo < newBPM || !isAcc && newTransitionTo > newBPM) {
            newBPM = (tempo.bpm + (isAcc ? -randomVariation : randomVariation))
        }

        let newMeanTempoAt = clamp(
            0.01,
            tempo.meanTempoAt + (Math.random() - 0.5) * 0.1,
            0.99
        )

        newTempos.push({
            type: 'tempo',
            'xml:id': tempo["xml:id"],
            date: tempo.date,
            endDate: tempo.endDate,
            bpm: newBPM,
            'transition.to': newTransitionTo,
            meanTempoAt: newMeanTempoAt,
            beatLength: tempo.beatLength
        });

        prevTransitionTo = newTransitionTo
    }

    return newTempos
};

/**
 * Calculates the squared error between the computed milliseconds
 * at each point and the actual milliseconds provided in the points array. It 
 * then averages these squared errors to produce the total error.
 * 
 * @param tempo The candidate tempo to evaluate.
 * @param points Array representing the actual milliseconds as tuples [score time, physical time]
 * @returns The average squared error for the given tempo and points.
 */
const computeTotalError = (tempo: TempoWithEndDate, points: Point[]) => {
    let totalError = 0;

    for (const point of points) {
        const error = computeMillisecondsAt(point[0], tempo) - point[1];
        if (isNaN(error)) {
            continue
        }
        totalError += Math.pow(error, 2);
    }

    return totalError / points.length;
}

/**
 * Approximates a tempo curve from given data points.
 * 
 * @param data The points to approximate the tempo curve from, given as [score time, physical time].
 * @param targetBeatLength The target beat length for the tempo curve.
 * @param startBPM An optional parameter that can be passed when the curve
 * segment to be approximated is intended to continue from the previous curve segment.
 * @returns The approximated tempo curve.
 */
export const approximateFromPoints = (
    serieses_: Point[][],
    targetBeatLength: number = 0.25
): TempoWithEndDate[] => {
    const serieses = serieses_.filter(series => series.length > 1)
    if (serieses.some(series => series.length <= 1)) {
        console.warn('Some serieses have less than two points. Ignoring them.')
    }

    const initialGuesses: TempoWithEndDate[] = []

    for (let i = 0; i < serieses.length; i++) {
        const data = serieses[i]

        const targetBeatLengthTicks = targetBeatLength * 4 * 720
        const startBpm = (60000 / ((data[1][1] - data[0][1]) / ((data[1][0] - data[0][0]) / targetBeatLengthTicks)))

        const distanceMs = data[data.length - 1][1] - data[0][1]
        const distanceTicks = data[data.length - 1][0] - data[0][0]
        const endBpm = 60000 / (distanceMs / (distanceTicks / targetBeatLengthTicks))

        const lastGuess = initialGuesses[i - 1]
        const previousEndBpm = lastGuess ? lastGuess["transition.to"] : undefined
        const meanConnection = previousEndBpm ? (previousEndBpm + startBpm) / 2 : undefined

        if (data.length === 2) {
            initialGuesses.push({
                type: 'tempo' as 'tempo',
                'xml:id': `tempo_${v4()}`,
                'bpm': meanConnection || startBpm,
                'date': data[0][0],
                endDate: data[1][0],
                'beatLength': targetBeatLength
            })
            continue
        }


        // initial guess, which will then be refined to 
        // fit the actual onset times (in milliseconds)
        // using a simulated annealing approach.
        initialGuesses.push({
            type: 'tempo' as 'tempo',
            'xml:id': `tempo_${v4()}`,
            'bpm': meanConnection || startBpm,
            date: data[0][0],
            endDate: data[data.length - 1][0],
            'transition.to': endBpm,
            meanTempoAt: 0.5,
            beatLength: targetBeatLength
        })
    }

    return simulatedAnnealing(serieses, initialGuesses)
}
