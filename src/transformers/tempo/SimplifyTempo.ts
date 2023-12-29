import { v4 } from "uuid";
import { MPM, Part, Tempo } from "mpm-ts";
import { MSM } from "../../msm";
import { AbstractTransformer, TransformationOptions } from "../Transformer";
import { isDefined } from "../../utils/isDefined";

interface TempoWithEndDate extends Tempo {
    endDate: number
}

type InterpolationPoint = {
    tstamp: number, // symbolical time
    beatLength: number
    milliseconds: number // physical time
    measuredBpm: number // tempo to the next interpolation point
}

const simulatedAnnealing = (points: InterpolationPoint[], initialTempo: TempoWithEndDate, initialTemperature: number = 150, coolingRate: number = 0.995, maxIterations: number = 10000): TempoWithEndDate => {
    let currentTempo = { ...initialTempo };
    let bestTempo = { ...initialTempo };
    let bestError = computeTotalError(points, currentTempo);
    let temperature = initialTemperature;

    for (let iteration = 0; iteration < maxIterations && temperature > 0.001; iteration++) {
        const neighboringTempo = generateNeighboringTempo(currentTempo);
        const currentError = computeTotalError(points, currentTempo);
        const neighborError = computeTotalError(points, neighboringTempo);

        if (Math.exp((currentError - neighborError) / temperature) > Math.random()) {
            currentTempo = { ...neighboringTempo };
        }

        if (neighborError < bestError) {
            bestError = neighborError;
            bestTempo = { ...neighboringTempo };
        }

        temperature *= coolingRate;
    }

    return bestTempo;
};

const generateNeighboringTempo = (tempo: TempoWithEndDate): TempoWithEndDate => {
    const randomVariation = (value: number, variation: number) => value + (Math.random() * 2 - 1) * variation;

    return {
        type: 'tempo',
        date: tempo.date,
        'xml:id': tempo["xml:id"],
        endDate: tempo.endDate,
        bpm: randomVariation(tempo.bpm, 2),
        'transition.to': randomVariation(tempo["transition.to"], 2),
        meanTempoAt: Math.min(Math.max(randomVariation(tempo.meanTempoAt, 0.05), 0.1), 1),
        beatLength: 0.25
    };
};

const computeTotalError = (points: InterpolationPoint[], tempo: TempoWithEndDate) => {
    let totalError = 0;

    for (const point of points) {
        const error = computeMillisecondsForTransition(point.tstamp, tempo) - point.milliseconds;
        totalError += Math.pow(error, 2);
    }

    return totalError;
}

export type SimplifactionMode = 'curved' | 'linear'

export interface SimplifyTempoOptions extends TransformationOptions {
    /**
     * On which part to apply the simplifaction of tempo instructions
     */
    part: Part

    /**
     * Tolerance of the Dogulas-Peucker algorithm
     */
    epsilon: number

    /**
     * Whether to interpolate linear or curved. In the former case, 
     * the @meanTempoAt attribute will always be 0.5.
     * @note Note that regardless of this parameter, the Douglas-Peucker
     * segmentation will always be based on lines rather than curves.
     */
    mode: SimplifactionMode
}

/**
 * Interpolates the global tempo and inserts it into the MPM
 */
export class SimplifyTempo extends AbstractTransformer<SimplifyTempoOptions> {
    constructor(options?: SimplifyTempoOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            epsilon: 4,
            part: 'global',
            mode: 'curved'
        })
    }

    public name() { return 'SimplifyTempo' }

    /**
     * Deletes the silence before the first note is being played 
     * 
     * @param msm MSM to perform the shifting on
     */
    private shiftToFirstOnset(msm: MSM) {
        const firstOnset = Math.min(...msm.allNotes.map(n => n["midi.onset"]).filter(isDefined))
        msm.allNotes.forEach(n => n["midi.onset"] -= firstOnset)
    }

    transform(msm: MSM, mpm: MPM): string {
        console.log(msm.allNotes.map(n => n['midi.onset']))
        if (!msm.timeSignature) {
            console.warn('A time signature must be given to interpolate a tempo map.')
            return super.transform(msm, mpm);
        }

        // const precision = this.options?.precision || 0

        // before starting to calculate the <tempo> instructions,
        // make sure to delete the arbitrary silence before the first note onset
        this.shiftToFirstOnset(msm)

        const tempos: Tempo[] = []

        function linearDouglasPeucker(points: InterpolationPoint[], epsilon: number) {
            const start = points[0]
            const end = points[points.length - 1]

            // console.log('douglas peucker from', start.tstamp, 'to', end.tstamp, 'length=', points.length)

            if (points.length === 0) {
                console.log('not enough notes present')
                return
            }
            else if (points.length === 1) {
                // insert a constant tempo for this single point

                return
            }
            else if (points.length === 2) {
                // insert a continuous, linear tempo transition from
                // the first to the second note

                return
            }

            // linear tempo curve
            const dy = points[points.length - 1].measuredBpm - points[0].measuredBpm
            const dx = points[points.length - 1].tstamp - points[0].tstamp
            const m = dy / dx
            const b = points[0].measuredBpm - (m * points[0].tstamp)
            const f = (x: number) => m * x + b

            // find the point of maximum distance from this line
            let dmax = 0
            let index = 0
            for (let i = 1; i < points.length - 1; i++) {
                const delta = Math.abs(f(points[i].tstamp) - points[i].measuredBpm)
                if (delta > dmax) {
                    index = i
                    dmax = delta
                }
            }

            // If the maximum distance is still above our tolerance,
            // split the curve at that point and restart the whole process
            // for both chunks.
            if (dmax > epsilon) {
                console.log(`[${0},${index + 1}] and [${index + 1},end]`)
                linearDouglasPeucker(points.slice(0, index + 1), epsilon)

                const rightPoints = points.slice(index)
                const initialTimePoint = rightPoints[0].milliseconds
                rightPoints.forEach(point => point.milliseconds -= initialTimePoint)

                linearDouglasPeucker(points.slice(index), epsilon)
                return
            }

            // Good enough? Approximate a new tempo curve
            const tempo = simulatedAnnealing(points, {
                type: 'tempo',
                'xml:id': `tempo_${v4()}`,
                date: start.tstamp,
                endDate: end.tstamp,
                beatLength: start.beatLength,

                // the following three values are just initial guesses
                bpm: points[0].measuredBpm,
                "transition.to": points[points.length - 1].measuredBpm,
                meanTempoAt: 0.5,
            })

            // Delete existing tempo instructions at the same date
            const existingTempoIndex = tempos.findIndex(t => t.date === tempo.date)
            if (existingTempoIndex !== -1) {
                tempos.splice(existingTempoIndex, 1)
            }

            const endDate = tempo.endDate
            delete tempo.endDate

            tempos.push(tempo)

            // add a tempo instruction at the end point
            tempos.push({
                type: 'tempo',
                'date': endDate,
                'xml:id': `tempo_${v4()}`,
                'bpm': tempo["transition.to"],
                'beatLength': tempo.beatLength,
            })
        }

        // take the existing tempo instructions, save them as 
        // `InterpolationPoint`s and remove them from the map
        // (as we are going to reinsert them.)

        const points = (mpm.getInstructions('tempo', this.options?.part || 'global') as Tempo[])
            .map(tempo => {
                const correspondingNote = msm.allNotes.find(note => note.date === tempo.date)
                if (!correspondingNote) {
                    console.log('no corresponding onset found for tempo instruction', tempo)
                }

                return {
                    tstamp: tempo.date,
                    beatLength: tempo.beatLength,
                    milliseconds: (correspondingNote["midi.onset"] || 0) * 1000,
                    measuredBpm: tempo.bpm
                } as InterpolationPoint
            })

        linearDouglasPeucker(points, this.options?.epsilon || 0.1)

        mpm.removeInstructions('tempo', this.options?.part || 'global')
        mpm.insertInstructions(tempos, this.options?.part || 'global')

        return super.transform(msm, mpm)
    }
}

export const getTempoAt = (date: number, tempo: TempoWithEndDate): number => {
    // no tempo
    if (!tempo.bpm) return 100.0;

    // constant tempo
    if (!tempo["transition.to"]) return tempo.bpm

    if (date === tempo.endDate) return tempo["transition.to"]

    const result = (date - tempo.date) / (tempo.endDate - tempo.date);
    const exponent = Math.log(0.5) / Math.log(tempo.meanTempoAt);
    return Math.pow(result, exponent) * (tempo["transition.to"] - tempo.bpm) + tempo.bpm;
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
