import { v4 } from "uuid";
import { clamp } from "../../utils/utils";
import { TempoWithEndDate, computeMillisecondsAt } from "./tempoCalculations";

export type Point = [number, number];

const simulatedAnnealing = (
    points: Point[],
    initialTempo: TempoWithEndDate,
    fixedStartBPM: boolean,
    initialTemperature: number = 500,
    coolingRate: number = 0.995,
    maxIterations: number = 1000,
): TempoWithEndDate => {
    let currentTempo = { ...initialTempo };
    // console.log('trying to optimize', currentTempo)
    let bestTempo = { ...initialTempo };
    let bestError = computeTotalError(currentTempo, points);
    // console.log('best error:', bestError)
    let temperature = initialTemperature;

    for (let iteration = 0; iteration < maxIterations && temperature > 0.001; iteration++) {
        const neighboringTempo = generateNeighboringTempo(currentTempo, fixedStartBPM);
        const currentError = computeTotalError(currentTempo, points);
        const neighborError = computeTotalError(neighboringTempo, points);
        // console.log('trying', neighborError, 'for', neighboringTempo)

        if (Math.exp((currentError - neighborError) / temperature) > Math.random()) {
            currentTempo = { ...neighboringTempo };
        }

        if (neighborError < bestError) {
            bestError = neighborError;
            // console.log('new best error=', neighborError, 'for', neighboringTempo)
            bestTempo = { ...neighboringTempo };
        }

        if (bestError < 10.0) {
            break;
        }

        temperature *= coolingRate;
    }

    return bestTempo;
};

const generateNeighboringTempo = (tempo: TempoWithEndDate, fixedStartBPM: boolean): TempoWithEndDate => {
    const variation = 0.2;
    const randomVariation = Math.random() * variation

    const isAcc = tempo.bpm < tempo["transition.to"]!

    // If the start point is fixed, do not apply 
    // any variation to it
    const newBPM = fixedStartBPM
        ? tempo.bpm 
        : tempo.bpm + (isAcc ? -randomVariation : randomVariation)
    const newTransitionTo = tempo["transition.to"]! + (isAcc ? randomVariation : -randomVariation)
    const newMeanTempoAt = clamp(
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
    };
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
    data: Point[],
    targetBeatLength: number = 0.25,
    fixedStartBPM?: number
): TempoWithEndDate => {
    console.log('approximating points', data, 'starting with', data[0][1])
    if (data.length <= 1) {
        throw new Error('At least 2 data points are required in order to approximate')
    }
    else if (data.length === 2) {
        return {
            type: 'tempo' as 'tempo',
            'xml:id': `tempo_${v4()}`,
            'bpm': 60000 / (data[1][1] - data[0][1]),
            'date': data[0][0],
            endDate: data[1][0],
            'beatLength': (data[1][0] - data[0][0]) / 720 / 4
        }
    }

    const beatLengthTicks = targetBeatLength * 4 * 720
    const startBpm = fixedStartBPM || (60000 / ((data[1][1] - data[0][1]) / ((data[1][0] - data[0][0]) / beatLengthTicks)))
    const endBpm = 60000 / ((data[data.length - 1][1] - data[data.length - 2][1]) / ((data[data.length - 1][0] - data[data.length - 2][0]) / beatLengthTicks))

    // initial guess, which will then be refined to 
    // fit the actual onset times (in milliseconds)
    // using a simulated annealing approach.
    const tmpTempo = {
        type: 'tempo' as 'tempo',
        'xml:id': `tempo_${v4()}`,
        'bpm': startBpm,
        date: data[0][0],
        endDate: data[data.length - 1][0],
        'transition.to': endBpm,
        meanTempoAt: 0.5,
        beatLength: targetBeatLength
    }

    return simulatedAnnealing(data, tmpTempo, !!fixedStartBPM)
}

export type Segment = {
    direction: 'rising' | 'falling',
    points: Point[],
    tempoPoints: Point[]
};

export const segmentCurve = (points: Point[]): Segment[] => {
    if (points.length < 3) {
        throw new Error('At least three points are required to form a curve.');
    }

    const diffPoints: Point[] = []
    for (let i = 0; i < points.length - 1; i++) {
        const yDiff = (points[i + 1][1] - points[i][1]) / 1000
        const xDiff = (points[i + 1][0] - points[i][0]) / 720

        diffPoints.push([points[i][0], 60 / (yDiff / xDiff)])
    }

    const segments: Segment[] = [];
    let currentSegment: Segment = {
        direction: diffPoints[1][1] > diffPoints[0][1] ? 'rising' : 'falling',
        points: [points[0]],
        tempoPoints: [diffPoints[0]]
    };

    // Function to add the current segment to segments and start a new one
    const startNewSegment = (point: Point, diffPoint: Point, direction: 'rising' | 'falling') => {
        // currentSegment.points.push(point)
        segments.push(currentSegment);

        currentSegment = {
            direction,
            points: [currentSegment.points[currentSegment.points.length - 1], point],
            tempoPoints: [currentSegment.tempoPoints[currentSegment.tempoPoints.length - 1], diffPoint]
        };
    };

    for (let i = 1; i < diffPoints.length; i++) {
        const [, previousTempo] = diffPoints[i - 1];
        const [, currentTempo] = diffPoints[i];

        if (currentTempo > previousTempo) { // The segment is rising
            if (currentSegment.direction === 'falling') {
                startNewSegment(points[i], diffPoints[i], 'rising');
            } else {
                currentSegment.points.push(points[i]);
                currentSegment.tempoPoints.push(diffPoints[i])
            }
        } else if (currentTempo < previousTempo) { // The segment is falling
            if (currentSegment.direction === 'rising') {
                startNewSegment(points[i], diffPoints[i], 'falling');
            } else {
                currentSegment.points.push(points[i]);
                currentSegment.tempoPoints.push(diffPoints[i])
            }
        } else {
            currentSegment.points.push(points[i]);
            currentSegment.tempoPoints.push(diffPoints[i])
        }
    }

    // Add the last segment to the list
    segments.push(currentSegment);

    return segments;
}

type WithSegment = {
    segment: Segment
}

export type TempoWithSegmentData = (TempoWithEndDate & WithSegment)

export const createTempoMapFromPoints = (points: Point[]) => {
    if (!points.length) {
        return []
    }

    const firstPoint = +`${points[0][1]}`
    points.forEach(point => point[1] = (point[1] - firstPoint) * 1000)

    const segments = segmentCurve(points);

    const instructions = segments
        .map(segment => {
            const segmentPoints = [...segment.points.map(p => [p[0], p[1]] as [number, number])]
            const firstPoint = +`${segmentPoints[0][1]}`
            segmentPoints.forEach(point => point[1] = (point[1] - firstPoint))
            // console.log('segment points=', segmentPoints)

            const instruction = approximateFromPoints(segmentPoints)
            return {
                ...instruction,
                // segment
            }
        })
        .filter(instruction => {
            // filter out impossible BPM values (they might come from low-quality alignments)
            return instruction.bpm > 0 && !isNaN(instruction.bpm) && Math.abs(instruction.bpm) !== Infinity
        })

    return instructions
}


