import { v4 } from "uuid";
import { MPM, Tempo } from "mpm-ts";
import { MSM } from "../msm";
import { BeatLengthBasis, calculateBeatLength, filterByBeatLength } from "./BeatLengthBasis";
import { AbstractTransformer, TransformationOptions } from "./Transformer";
import { physicalToSymbolic } from "./basicCalculations";

interface TempoWithEndDate extends Tempo {
    endDate: number
}

export const isDefined = (onset?: number) => {
    return onset !== undefined && !isNaN(onset)
}

type InterpolationPoint = {
    tstamp: number, // symbolical time
    beatLength: number
    milliseconds: number // physical time
    measuredBpm: number // tempo to the next interpolation point
}

const simulatedAnnealing = (points: InterpolationPoint[], initialTempo: TempoWithEndDate, initialTemperature: number = 120, coolingRate: number = 0.995, maxIterations: number = 10000): TempoWithEndDate => {
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

export interface InterpolateTempoMapOptions extends TransformationOptions {
    /**
     * The basis on which to calculate the beat lengths on. 
     * @todo It should be possible to define ranges in a piece
     * with different beat lengthes.
     */
    beatLength: BeatLengthBasis

    /**
     * Tolerance of the Dogulas-Peucker algorithm
     */
    epsilon: number

    /**
     * The number of digits to appear after the decimal point of a BPM value
     */
    precision: number
}

/**
 * Interpolates the global tempo and inserts it into the MPM
 */
export class InterpolateTempoMap extends AbstractTransformer<InterpolateTempoMapOptions> {
    constructor(options?: InterpolateTempoMapOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            beatLength: 'denominator',
            epsilon: 4,
            precision: 0
        })
    }

    public name() { return 'InterpolateTempoMap' }

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

        const points: InterpolationPoint[] = []
        const chords = Object.entries(msm.asChords())
        chords
            .filter(filterByBeatLength(this.options.beatLength, msm.timeSignature))
            .forEach(([date, chord], i) => {
                if (chord.length === 0) {
                    console.warn('Empty chord found. This is not supposed to happen.')
                    return
                }

                const firstOnset = chord[0]['midi.onset']
                if (chord.some(note => note["midi.onset"] !== firstOnset)) {
                    console.log(`Not all notes in the chord at ${chord[0].date}
                    occur at the same physical time. Make sure that a global physical
                    ornamentation map and/or asynchrony map are calculated before
                    applying this transformer.`)
                }

                // TODO consider beatLength in case of beat length basis = 'everything'
                // and deal with left-out beats.
                const [_, nextChord] = chords[i + 1] || [undefined, undefined]
                const nextOnset = nextChord?.at(0)['midi.onset'] || firstOnset + chord[0]['midi.duration']

                points.push({
                    tstamp: +date,
                    beatLength: this.options.beatLength === 'everything'
                        ? chord[0].duration
                        : calculateBeatLength(this.options.beatLength, msm.timeSignature) / 720 / 4,
                    milliseconds: firstOnset * 1000,
                    measuredBpm: nextOnset !== undefined ? 60 / (nextOnset - firstOnset) : 60
                })
            })

        linearDouglasPeucker(points, this.options?.epsilon || 0.1)

        mpm.insertInstructions(tempos, 'global')
        this.addTickOnsets(msm, mpm)
        this.addTickDurations(msm, mpm)

        return super.transform(msm, mpm)
    }

    /**
     * Translates MIDI onset times into tempo-dependent
     * ticks using the newly interpolated tempo curves.
     * Adds the variable `tickDate` on every MSM note 
     * and removes the variable `midi.onset`. 
     * @param msm The MSM to modify.
     * @param mpm The MPM to take the tempo instructions from. 
     *            It must contain a `tempoMap`.
     */
    addTickOnsets(msm: MSM, mpm: MPM) {
        const tempos = mpm.getInstructions<Tempo>('tempo', 'global')

        let currentMilliseconds = 0
        for (let i = 0; i < tempos.length; i++) {
            const tempo = tempos[i]
            const nextTempo = tempos[i + 1]

            console.log('within tempo instruction @', tempo.date, 'current start time=', currentMilliseconds)

            const tempoWithEndDate: TempoWithEndDate = {
                ...tempo,
                endDate: nextTempo?.date || tempo.date + tempo.beatLength * 4 * 720
            }

            msm.allNotes.forEach(n => {
                // are out of the scope of the current tempo instruction? 
                if (nextTempo && n.date >= nextTempo.date) return
                if (n.date < tempo.date) return

                const onsetMilliseconds = n["midi.onset"] * 1000

                // replace MIDI time with tick time.
                n.tickDate = approximateDate(onsetMilliseconds - currentMilliseconds, tempoWithEndDate)
            })

            currentMilliseconds += computeMillisecondsForTransition(tempoWithEndDate.endDate, tempoWithEndDate)
        }
    }

    /**
     * Translates MIDI durations into tick durations
     * using the new <tempo> instructions.
     * @todo Currently only consideres constant tempos.
     * Approximation of tempo curves still a todo.
     * @param msm 
     * @param mpm 
     */
    addTickDurations(msm: MSM, mpm: MPM) {
        const tempos = mpm.getInstructions<Tempo>('tempo', 'global')

        let currentFrameBeginMilliseconds = 0
        for (let i = 0; i < tempos.length; i++) {
            const tempo = tempos[i]
            const nextTempo = tempos[i + 1]

            const tempoWithEndDate: TempoWithEndDate = {
                ...tempo,
                endDate: nextTempo?.date || tempo.date + tempo.beatLength * 100 * 720
            }

            const endMilliseconds = computeMillisecondsForTransition(tempoWithEndDate.endDate, tempoWithEndDate)

            msm.allNotes
                .filter(n => n["midi.duration"])
                .forEach(n => {
                    const offsetMs = (n['midi.onset'] + n["midi.duration"]) * 1000 - currentFrameBeginMilliseconds
                    if (offsetMs > endMilliseconds) return
                    n.tickDuration = approximateDate(offsetMs, tempoWithEndDate) - n.tickDate
                    delete n["midi.duration"]
                    delete n["midi.onset"]
                })

            currentFrameBeginMilliseconds += endMilliseconds
        }
    }
}

const isTransition = (tempo: Tempo) => {
    return tempo["transition.to"] && tempo.meanTempoAt
}

const computeMillisecondsForTransition = (date: number, tempo: TempoWithEndDate): number => {
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

const getTempoAt = (date: number, tempo: TempoWithEndDate): number => {
    // no tempo
    if (!tempo.bpm) return 100.0;

    // constant tempo
    if (!tempo["transition.to"]) return tempo.bpm

    if (date === tempo.endDate) return tempo["transition.to"]

    const result = (date - tempo.date) / (tempo.endDate - tempo.date);
    const exponent = Math.log(0.5) / Math.log(tempo.meanTempoAt);
    return Math.pow(result, exponent) * (tempo["transition.to"] - tempo.bpm) + tempo.bpm;
}

const approximateDate = (targetMilliseconds: number, effectiveTempoInstruction: TempoWithEndDate, initialGuess: number = effectiveTempoInstruction.date, tolerance: number = 1): number => {
    if (!isTransition(effectiveTempoInstruction)) {
        return effectiveTempoInstruction.date + physicalToSymbolic(targetMilliseconds / 1000, effectiveTempoInstruction.bpm, effectiveTempoInstruction.beatLength)
    }

    let guess = initialGuess;
    let guessedMilliseconds = computeMillisecondsForTransition(guess, effectiveTempoInstruction);
    for (let i = 0; i < 1000 && Math.abs(guessedMilliseconds - targetMilliseconds) > tolerance; i++) {
        guess += 0.1 * (targetMilliseconds - guessedMilliseconds)
        guessedMilliseconds = computeMillisecondsForTransition(guess, effectiveTempoInstruction);
    }

    return Math.round(guess);
}

