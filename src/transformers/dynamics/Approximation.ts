import { v4 } from "uuid"
import { DynamicsWithEndDate } from "./InsertDynamicsInstructions"
import { Movement } from "../../mpm"
import { hashSeed, Random, seededRandom } from "../../utils/random"

export type DynamicsPoints = {
    date: number
    velocity: number
}

export type InnerControlPoints = {
    x1: number
    x2: number
}

// An absent `@curvature`/`@protraction` is not "no value" — it is the renderer's default, and
// for <dynamics> espressivo/meico fills both with 0.0 (`resolveDynamics` in
// `mpm/elements/maps/data/dynamics.ts`). Scoring a candidate as if the attributes were merely
// missing would fit against a curve the renderer never draws. They are named apart because the
// defaults are not shared: <movement> takes 0.4 for curvature.
const DEFAULT_CURVATURE = 0.0
const DEFAULT_PROTRACTION = 0.0

export const computeInnerControlPointsXPositions = (curvature: number, protraction: number): InnerControlPoints => {
    if (protraction == 0.0) {
        return {
            x1: curvature,
            x2: 1 - curvature
        }
    }

    return {
        x1: curvature + ((Math.abs(protraction) + protraction) / (2.0 * protraction) - (Math.abs(protraction) / protraction) * curvature) * protraction,
        x2: 1.0 - curvature + ((protraction - Math.abs(protraction)) / (2.0 * protraction) + (Math.abs(protraction) / protraction) * curvature) * protraction
    }
}

/**
 * compute parameter t of the Bézier curve that corresponds to time position date
 * @param date time position
 * @return
 */
const getTForDate = (instruction: { date: number, endDate: number} & InnerControlPoints, date: number) => {
    if (date === instruction.date)
        return 0.0;

    if (date === instruction.endDate)
        return 1.0;

    // values that are often required
    const frameLength = instruction.endDate - instruction.date;
    date = date - instruction.date;
    const u = (3.0 * instruction.x1) - (3.0 * instruction.x2) + 1.0;
    const v = (-6.0 * instruction.x1) + (3.0 * instruction.x2);
    const w = 3.0 * instruction.x1;

    // binary search for the t that is integer precise on the x-axis/time domain
    let t = 0.5;
    let diffX = ((((u * t) + v) * t + w) * t * frameLength) - date;

    // while the difference in the x-domain is >= 1.0
    for (let tt = 0.25; Math.abs(diffX) >= 1.0; tt *= 0.5) {
        if (diffX > 0.0) {
            // t is too big
            t -= tt;
        }
        else {
            // t is too small
            t += tt;
        }
        // compute difference
        diffX = ((((u * t) + v) * t + w) * t * frameLength) - date;
    }
    return t;
}

export const volumeAtDate = (instruction: DynamicsWithEndDate & InnerControlPoints, date: number) => {
    if (date < instruction.date) {
        return +instruction.volume
    }
    if (!instruction["transition.to"] || instruction.volume === instruction["transition.to"]) {
        return +instruction.volume;
    }
    if (date >= instruction.endDate) {
        return instruction["transition.to"]
    }

    const t = getTForDate(instruction, date);
    return ((((3.0 - (2.0 * t)) * t * t) * (instruction["transition.to"] - +instruction.volume)) + +instruction.volume);
}

export const positionAtDate = (instruction: Movement & { endDate: number } & InnerControlPoints, date: number) => {
    if (date < instruction.date) {
        return +instruction.position
    }
    if (instruction["transition.to"] === undefined || (instruction.position === instruction["transition.to"])) {
        return +instruction.position;
    }
    if (date >= instruction.endDate) {
        return instruction["transition.to"]
    }

    const t = getTForDate(instruction, date);

    return ((((3.0 - (2.0 * t)) * t * t) * (instruction["transition.to"] - +instruction.position)) + +instruction.position);
}

const computeError = (instruction: DynamicsWithEndDate, points: DynamicsPoints[]) => {
    const computedInstruction = {
        ...instruction,
        ...computeInnerControlPointsXPositions(
            instruction.curvature ?? DEFAULT_CURVATURE,
            instruction.protraction ?? DEFAULT_PROTRACTION
        )
    }

    let sum = 0;
    for (const point of points) {
        const assumed = volumeAtDate(computedInstruction, point.date)
        const real = point.velocity
        const error = Math.abs(assumed - real)
        sum += error
    }

    return sum
}

const generateNeighbour = (prev: DynamicsWithEndDate, random: Random) => {
    // Define the magnitude of the maximum possible change
    const maxProtractionChange = 0.05;
    const maxCurvatureChange = 0.05;

    // Generate random changes within the defined range
    const newProtraction = (prev.protraction ?? DEFAULT_PROTRACTION) + (random() * 2 - 1) * maxProtractionChange;
    const newCurvature = (prev.curvature ?? DEFAULT_CURVATURE) + (random() * 2 - 1) * maxCurvatureChange;

    // Ensure the new values are within valid bounds
    const validProtraction = Math.max(Math.min(newProtraction, 1.0), -1.0);
    const validCurvature = Math.max(Math.min(newCurvature, 1.0), 0.0);

    return {
        ...prev,
        protraction: validProtraction,
        curvature: validCurvature
    };
}

export const approximateDynamics = (points: DynamicsPoints[]): DynamicsWithEndDate | undefined => {
    if (points.length === 0) {
        console.warn('approximateDynamics requires at least one point')
        return
    }
    else if (points.length === 1) {
        return {
            type: 'dynamics',
            "xml:id": `dynamics_${v4()}`,
            date: points[0].date,
            endDate: points[0].date,
            volume: points[0].velocity,
        }
    }

    const equal = points[0].velocity === points[points.length - 1].velocity;
    if (points.length === 2 || equal) {
        return {
            type: 'dynamics',
            "xml:id": `dynamics_${v4()}`,
            date: points[0].date,
            endDate: points[points.length - 1].date,
            volume: points[0].velocity,
            "transition.to": equal ? undefined : points[points.length - 1].velocity,
            protraction: 0,
            curvature: 0.5
        }
    }

    const initial: DynamicsWithEndDate = {
        type: 'dynamics',
        "xml:id": `dynamics_${v4()}`,
        date: points[0].date,
        endDate: points[points.length - 1].date,
        volume: points[0].velocity,
        "transition.to": points[points.length - 1].velocity,
        protraction: 0,
        curvature: 0.5
    }

    // Seeded from the points, not from a clock: the same curve is fitted the same way every
    // time the chain is re-run.
    const random = seededRandom(hashSeed(JSON.stringify(points)));

    const maxIterations = 5000;
    const maxError = 5;
    let error = computeError(initial, points);
    let attempt = initial;
    let bestAttempt = attempt;
    let bestError = error;
    let temperature = 1.0; // Initial temperature
    const coolingRate = 0.99; // Cooling rate

    for (let i = 0; i < maxIterations && error > maxError; i++) {
        const neighbor = generateNeighbour(attempt, random);
        const neighborError = computeError(neighbor, points);

        if (neighborError < bestError) {
            bestAttempt = neighbor;
            bestError = neighborError;
        }

        const acceptanceProbability = Math.exp((error - neighborError) / temperature);
        if (neighborError < error || random() < acceptanceProbability) {
            attempt = neighbor;
            error = neighborError;
        }

        // Cool down the temperature
        temperature *= coolingRate;
    }

    return bestAttempt;
}
