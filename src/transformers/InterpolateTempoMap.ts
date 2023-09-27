import { v4 } from "uuid";
import { MPM, Tempo } from "mpm-ts";
import { MSM, MsmNote } from "../msm";
import { BeatLengthBasis, calculateBeatLength } from "./BeatLengthBasis";
import { AbstractTransformer, TransformationOptions } from "./Transformer";
import { physicalToSymbolic, symbolicToPhysical } from "./basicCalculations";

export const isDefined = (onset?: number) => {
    return !!onset && !isNaN(onset)
}

type InterpolationPoint = {
    tstamp: number,
    bpm: number,
    beatLength: number
}

const generatePowFunction = (start: InterpolationPoint, end: InterpolationPoint, maxIterations = 3000, tolerance = 0.01) => {
    let updatedBPM = start.bpm;
    let updatedMeanTempoAt = 0.5

    const computePowFunction = (startBPM: number, meanTempoAt: number) => {
        return (x: number) => Math.pow((x - start.tstamp) / (end.tstamp - start.tstamp), Math.log(0.5) / Math.log(meanTempoAt)) * (end.bpm - startBPM) + startBPM;
    }

    const computeStartBPMError = () => {
        let powFunction = computePowFunction(updatedBPM, updatedMeanTempoAt);
        let target = start.tstamp + (start.beatLength * updatedMeanTempoAt);
        return powFunction(target) - start.bpm;
    }

    const computeMeanTempoAtError = () => {
        let powFunction = computePowFunction(updatedBPM, updatedMeanTempoAt);
        const fullRange = end.bpm - updatedBPM
        const meanTempo = fullRange / 2
        const diff = powFunction(updatedMeanTempoAt * (end.tstamp - start.tstamp)) - meanTempo
        return diff / meanTempo
    }

    for (let i = 0; i < 1000; i++) {
        const error = computeStartBPMError()
        if (error < 0.1) break;
        updatedBPM -= error * 0.2
    }

    for (let i = 0; i < 100; i++) {
        const error = computeMeanTempoAtError()
        if (isNaN(error) || error < 0.2 || error > 0.8) break;
        // console.log('mean tempo error=', error)
        updatedMeanTempoAt -= error * 0.001
    }

    //console.log('done. best start bpm=', updatedBPM, 'best mean tempo at=', updatedMeanTempoAt)

    // Return the best approximation of powFunction after maxIterations
    return {
        startBPM: updatedBPM,
        meanTempoAt: updatedMeanTempoAt,
        powFunction: computePowFunction(updatedBPM, updatedMeanTempoAt)
    }
};


/**
 * Calculates the BPMs between time onsets.
 * 
 * @param arr The time onsets array.
 * @returns The array of BPMs, typically with one less element than
 * the input array. BPMs of value 0 are being filtered out.
 */
const asBPM = (arr: number[]) => {
    let result = []
    for (let i = 0; i < arr.length - 1; i++) {
        const diff = arr[i + 1] - arr[i]
        if (diff === 0) continue
        result.push(60 / diff)
    }
    return result
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

        const precision = this.options?.precision || 0

        // before starting to calculate the <tempo> instructions,
        // make sure to delete the arbitrary silence before the first note onset
        this.shiftToFirstOnset(msm)

        const tempos: Tempo[] = []

        function douglasPeucker(points: InterpolationPoint[], epsilon: number) {
            if (!points.length) {
                console.log('not enough notes present')
                return
            }

            const start = points[0]
            const end = points[points.length - 1]

            console.log('douglas peucker from', start, 'to', end)

            const fullDistance = end.tstamp - start.tstamp

            // In case of constant tempo no tempo curve needs to be 
            // interpolated.
            if (start.bpm !== end.bpm && fullDistance > start.beatLength) {
                // approximate a new tempo curve
                const { powFunction, meanTempoAt } = generatePowFunction(start, end)

                // find point of maximum distance from this curve
                let dmax = 0
                let index = 0
                for (let i = 1; i < points.length - 1; i++) {
                    const d = Math.abs(points[i].bpm - powFunction(points[i].tstamp + (points[i].beatLength * meanTempoAt)))
                    if (d > dmax) {
                        index = i
                        dmax = d
                    }
                }

                if (dmax > epsilon) {
                    douglasPeucker(points.slice(0, index + 1), epsilon)
                    douglasPeucker(points.slice(index + 1), epsilon)
                }
                else {
                    // Is there a <tempo> instruction already at the same date?
                    const lastTempoInstruction = tempos[tempos.length - 1]
                    if (lastTempoInstruction && lastTempoInstruction.date === start.tstamp) {
                        // attach the transition to it
                        lastTempoInstruction['transition.to'] = +powFunction(end.tstamp).toFixed(precision)
                        lastTempoInstruction['meanTempoAt'] = +meanTempoAt.toFixed(2)
                    }
                    else {
                        // otherwise create a new instruction
                        tempos.push({
                            'type': 'tempo',
                            'xml:id': 'tempo_' + v4(),
                            'date': start.tstamp,
                            'bpm': Math.abs(+powFunction(start.tstamp).toFixed(precision)),
                            'transition.to': +powFunction(end.tstamp).toFixed(precision),
                            'beatLength': start.beatLength / 720 / 4,
                            'meanTempoAt': +meanTempoAt.toFixed(2)
                        })
                    }

                    // add <tempo> at the target date of the transition
                    tempos.push({
                        'type': 'tempo',
                        'xml:id': 'tempo_' + v4(),
                        'date': end.tstamp,
                        'bpm': Math.abs(+powFunction(end.tstamp).toFixed(precision)),
                        'beatLength': end.beatLength / 720 / 4
                    })
                }
            }
            else {
                // Is there a <tempo> instruction already at the same date? No need
                // to insert a new one.
                const lastTempoInstruction = tempos[tempos.length - 1]
                if (!lastTempoInstruction || lastTempoInstruction.date !== start.tstamp) {
                    tempos.push({
                        'type': 'tempo',
                        'xml:id': 'tempo_' + v4(),
                        'date': start.tstamp,
                        'bpm': Math.abs(+start.bpm.toFixed(precision)),
                        'beatLength': start.beatLength / 720 / 4
                    })
                }
            }
        }

        let onsets: number[] = []
        let tstamps: number[] = []
        let beatLengths: number[] = []

        if (this.options?.beatLength === 'everything') {
            const chords = Object.entries(msm.asChords())
            chords.forEach(([date, chord], i) => {
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
                onsets.push(firstOnset)
                tstamps.push(+date)
                if (i === chords.length - 1) {
                    // in case of the last chord use its duration as the beat length
                    beatLengths.push(chord[0]['duration'])
                }
                else {
                    // otherwise use the distance to the next chord as beat length
                    const nextDefinedPosition = chords.slice(i + 1).find(([_, chordNotes]) =>
                        isDefined(chordNotes[0]['midi.onset']))?.at(0)
                    beatLengths.push(Number(nextDefinedPosition) - Number(date))
                }
            })
        }
        else {
            const beatLength = calculateBeatLength(this.options?.beatLength || 'bar', msm.timeSignature);

            for (let date = 0; date <= msm.lastDate(); date += beatLength) {
                const performedNotes = msm.notesAtDate(date, 'global')

                if (performedNotes[0] && performedNotes[0]['midi.onset'] !== undefined) {
                    onsets.push(performedNotes[0]["midi.onset"])
                    tstamps.push(date)
                    beatLengths.push(beatLength)
                }
                else {
                    // We singularly prolong the beat length until
                    // we find a succeeding event
                    beatLengths[beatLengths.length - 1] += beatLength
                }
            }

            // put a virtual onset at the offset of the last note, 
            // so that the tempo of the final note will be calculated
            // on the basis of its length.
            const performedNotes = msm.notesAtDate(msm.lastDate(), 'global')
            onsets.push(performedNotes[0]['midi.onset'] + performedNotes[0]['midi.duration'])
            tstamps.push(msm.lastDate() + performedNotes[0].duration)
            beatLengths.push(performedNotes[0].duration)
        }
        const bpms = asBPM(onsets)

        const points: InterpolationPoint[] = bpms.map((bpm, i) => ({
            tstamp: tstamps[i],
            bpm: bpm,
            beatLength: beatLengths[i]
        }))

        douglasPeucker(points, this.options?.epsilon || 4)

        mpm.insertInstructions(tempos, 'global')
        this.addTickDurations(msm, mpm)
        this.addTickOnsets(msm, mpm)

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

        let previousStartDate = 0
        for (let i = 0; i < tempos.length; i++) {
            const previousTempo = tempos[i - 1]
            const tempo = tempos[i]
            const nextTempo = tempos[i + 1]

            const startDate =
                previousStartDate +
                computeMilliseconds(tempo.date, previousTempo || tempo, tempos[i]?.date)
            previousStartDate = startDate

            msm.allNotes.forEach(n => {
                // are out of the scope of the current tempo instruction? 
                if (nextTempo && n.date >= nextTempo.date) return
                if (n.date < tempo.date) return

                const onsetMilliseconds = n["midi.onset"] * 1000

                // replace MIDI time with tick time.
                n.tickDate = tempo.date + approximateDate(onsetMilliseconds - startDate, tempo, nextTempo?.date)
                delete n["midi.onset"]
            })
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
        for (const note of msm.allNotes) {
            const tempos = mpm.instructionEffectiveInRange<Tempo>(note.date, note.date + note.duration, 'tempo', 'global')
            note.tickDuration = calculateTickDuration(note, tempos)
        }
    }
}

const isTransition = (tempo: Tempo) => {
    return tempo["transition.to"] && tempo.meanTempoAt
}

const computeMilliseconds = (date: number, tempo: Tempo, endDate?: number) => {
    if (isTransition(tempo)) {
        return computeMillisecondsForTransition(date, tempo, endDate || -1)
    }
    else {
        return computeMillisecondsForConstantTempo(date, tempo)
    }
}

const computeMillisecondsForConstantTempo = (date: number, tempo: Tempo) => {
    return ((15000.0 * (date - tempo.date)) / (tempo.bpm * tempo.beatLength * 720))
}

const computeMillisecondsForTransition = (date: number, tempo: Tempo, endDate: number): number => {
    const N = 2 * Math.floor((date - tempo.date) / (720 / 4));
    const adjustedN = (N === 0) ? 2 : N;

    const n = adjustedN / 2;
    const x = (date - tempo.date) / adjustedN;

    const resultConst = (date - tempo.date) * 5000 / (adjustedN * tempo.beatLength * 720);
    let resultSum = 1 / tempo.bpm + 1 / getTempoAt(date, tempo, endDate);

    for (let k = 1; k < n; k++) {
        resultSum += 2 / getTempoAt(tempo.date + 2 * k * x, tempo, endDate);
    }

    for (let k = 1; k <= n; k++) {
        resultSum += 4 / getTempoAt(tempo.date + (2 * k - 1) * x, tempo, endDate);
    }

    return resultConst * resultSum;
}

const getTempoAt = (date: number, tempo: Tempo, endDate): number => {
    // no tempo
    if (!tempo.bpm) return 100.0;

    // constant tempo
    if (!tempo["transition.to"]) return tempo.bpm

    if (date === endDate) return tempo["transition.to"]

    const result = (date - tempo.date) / (endDate - tempo.date);
    const exponent = Math.log(0.5) / Math.log(tempo.meanTempoAt);
    return Math.pow(result, exponent) * (tempo["transition.to"] - tempo.bpm) + tempo.bpm;
}

const approximateDate = (targetMilliseconds: number, effectiveTempoInstruction: Tempo, endDate, initialGuess: number = effectiveTempoInstruction.date, tolerance: number = 1): number => {
    if (!isTransition(effectiveTempoInstruction)) {
        return physicalToSymbolic(targetMilliseconds / 1000, effectiveTempoInstruction.bpm, effectiveTempoInstruction.beatLength)
    }

    let guess = initialGuess;
    let guessedMilliseconds = computeMillisecondsForTransition(guess, effectiveTempoInstruction, endDate);
    for (let i=0; i<1000 && Math.abs(guessedMilliseconds - targetMilliseconds) > tolerance; i++) {
        guess += 0.09 * (targetMilliseconds - guessedMilliseconds) 
        guessedMilliseconds = computeMillisecondsForTransition(guess, effectiveTempoInstruction, endDate);
    }

    return guess;
}

export function calculateTickDuration(note: MsmNote, tempos: Tempo[]) {
    tempos.sort((a, b) => a.date - b.date)
    let fullDuration = 0
    let remaining = note['midi.duration'] * 1000
    for (let i = 0; i < tempos.length; i++) {
        const startDate = Math.max(note.date, tempos[i].date)
        let localDuration = remaining
        if (i < tempos.length - 1) {
            localDuration = Math.min(symbolicToPhysical(tempos[i + 1].date - startDate, tempos[i].bpm, tempos[i].beatLength),
                localDuration)
        }

        fullDuration += approximateDate(localDuration, tempos[i], tempos[i + 1]?.date || -1)
        remaining -= localDuration
    }
    return fullDuration
}
