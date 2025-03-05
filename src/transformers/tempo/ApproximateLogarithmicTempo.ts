import { Point } from "./ConfigurableTempoTransformer";
import { v4 } from "uuid";
import { clamp } from "../../utils/utils";
import { TempoWithEndDate, computeMillisecondsAt } from "./tempoCalculations";
import { MSM } from "../../msm";
import { ConfigurableTempoTransformer, TempoSegmentWithPoints } from "./ConfigurableTempoTransformer";

/**
 * Inserts tempo instructions into the given part based on the
 * given beat length.
 */
export class ApproximateLogarithmicTempo extends ConfigurableTempoTransformer {
    name = 'ApproximateLogarithmicTempo'

    protected approximateTempo(segment: TempoSegmentWithPoints): TempoWithEndDate {
        if (segment.points.length < 2) {
            throw new Error('At least two points are required to approximate a tempo curve.');
        }

        return approximateTempo(
            segment.points,
            segment.startBPM,
            segment.endBPM,
            segment.meanTempoAt,
            segment.beatLength
        )
    }

    protected addTickOnsets(msm: MSM): void {
    }
}

const guessInitialTempo = (data: [number, number][], targetBeatLength: number): TempoWithEndDate => {
    if (data.length < 2) {
        throw new Error('At least two points are required to approximate a tempo curve.');
    }

    const targetBeatLengthTicks = targetBeatLength * 4 * 720
    const startBpm = (60000 / ((data[1][1] - data[0][1]) / ((data[1][0] - data[0][0]) / targetBeatLengthTicks)))

    const distanceMs = data[data.length - 1][1] - data[0][1]
    const distanceTicks = data[data.length - 1][0] - data[0][0]
    const endBpm = 60000 / (distanceMs / (distanceTicks / targetBeatLengthTicks))

    if (data.length === 2) {
        return {
            type: 'tempo' as 'tempo',
            'xml:id': `tempo_${v4()}`,
            'bpm': startBpm,
            'date': data[0][0],
            endDate: data[1][0],
            'beatLength': targetBeatLength
        }
    }

    // initial guess, which will then be refined to 
    // fit the actual onset times (in milliseconds)
    return {
        type: 'tempo' as 'tempo',
        'xml:id': `tempo_${v4()}`,
        'bpm': startBpm,
        date: data[0][0],
        endDate: data[data.length - 1][0],
        'transition.to': endBpm,
        meanTempoAt: 0.5,
        beatLength: targetBeatLength
    }
}

export const approximateTempo = (
    series: Point[],
    startBPM: number | undefined,
    endBPM: number | undefined,
    meanTempoAt: number | undefined,
    beatLength: number,
    initialTemperature: number = 500,
    coolingRate: number = 0.995,
    maxIterations: number = 1000,
    maxError: number = 10.0
): TempoWithEndDate => {
    const initialTempo = guessInitialTempo(series, beatLength)

    if (startBPM) initialTempo.bpm = startBPM
    if (endBPM) initialTempo["transition.to"] = endBPM
    if (meanTempoAt) initialTempo.meanTempoAt = meanTempoAt
    console.log('initial guess', initialTempo)

    let currentTempo = { ...initialTempo };
    let bestTempo = { ...initialTempo };
    let bestError = computeTotalError(currentTempo, series);
    let temperature = initialTemperature;

    for (let iteration = 0; iteration < maxIterations && temperature > 0.001; iteration++) {
        const neighboringTempo = generateNeighboringTempo(
            currentTempo,
            startBPM,
            endBPM,
            meanTempoAt
        );

        const currentError = computeTotalError(currentTempo, series);
        const neighborError = computeTotalError(neighboringTempo, series);

        if (Math.exp((currentError - neighborError) / temperature) > Math.random()) {
            currentTempo = { ...neighboringTempo };
        }

        if (neighborError < bestError) {
            bestError = neighborError;
            // console.log('new best error=', neighborError, 'for', neighboringTempo)
            bestTempo = neighboringTempo;
        }

        if (bestError < maxError) {
            break;
        }

        temperature *= coolingRate;
    }

    return bestTempo;
};

const generateNeighboringTempo = (
    tempo: TempoWithEndDate,
    startBPM?: number,
    endBPM?: number,
    meanTempoAt?: number
): TempoWithEndDate => {
    const variation = 0.2;
    const randomVariation = Math.random() * variation

    const isAcc = tempo.bpm < tempo["transition.to"]!

    let newBPM = startBPM || (tempo.bpm + (isAcc ? -randomVariation : randomVariation))
    const newTransitionTo = endBPM || (tempo["transition.to"]! + (isAcc ? randomVariation : -randomVariation))

    if (!startBPM && (isAcc && newTransitionTo < newBPM) || (!isAcc && newTransitionTo > newBPM)) {
        newBPM = (tempo.bpm + (isAcc ? -randomVariation : randomVariation))
    }

    let newMeanTempoAt = meanTempoAt || clamp(
        0.01,
        tempo.meanTempoAt + (Math.random() - 0.5) * 0.1,
        0.99
    )

    return {
        type: 'tempo',
        'xml:id': tempo["xml:id"],
        date: tempo.date,
        endDate: tempo.endDate,
        bpm: newBPM,
        'transition.to': newTransitionTo,
        meanTempoAt: newMeanTempoAt,
        beatLength: tempo.beatLength
    }
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
export const computeTotalError = (tempo: TempoWithEndDate, points: Point[]) => {
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

