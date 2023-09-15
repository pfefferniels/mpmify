import { v4 } from "uuid";
import { MPM, Tempo } from "../mpm";
import { MSM } from "../msm";
import { BeatLengthBasis, calculateBeatLength } from "./BeatLengthBasis";
import { AbstractTransformer, TransformationOptions } from "./Transformer";
import { calculateSymbolicNoteDuration } from "./basicCalculations";

export const isDefined = (onset?: number) => {
    return !!onset && !isNaN(onset)
}

type InterpolationPoint = {
    tstamp: number,
    bpm: number,
    beatLength: number
}

const generatePowFunction = (start: InterpolationPoint, end: InterpolationPoint, meanTempoAt: number, maxIterations = 1000, tolerance = 0.01): ((x: number) => number) => {
    let iteration = 0;
    let updatedBPM = start.bpm;

    const computePowFunction = (bpm: number) => (x: number) => Math.pow((x - start.tstamp) / (end.tstamp - start.tstamp), Math.log(0.5) / Math.log(meanTempoAt)) * (end.bpm - bpm) + bpm;

    while (iteration < maxIterations) {
        let powFunction = computePowFunction(updatedBPM);
        let target = start.tstamp + start.beatLength;
        let diff = powFunction(target) - start.bpm;

        if (Math.abs(diff) < tolerance) {
            return powFunction;
        }

        // Update updatedBPM and recompute powFunction
        updatedBPM -= diff;
        iteration++;
    }

    // Return the best approximation of powFunction after maxIterations
    return computePowFunction(updatedBPM);
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

        let tempos: Tempo[] = []

        function douglasPeucker(points: InterpolationPoint[], epsilon: number) {
            if (!points.length) {
                console.log('not enough notes present')
                return
            }

            const start = points[0]
            const end = points[points.length - 1]

            const meanTempo = (start.bpm + end.bpm) / 2


            // search for BPM value closest to meanTempo
            let optimal = Number.MAX_SAFE_INTEGER
            let meanTempoAtQstamp = 0;
            for (let i = 1; i < points.length - 1; i++) {
                const distance = Math.abs(points[i].bpm - meanTempo)
                if (distance < optimal) {
                    optimal = distance
                    meanTempoAtQstamp = points[i].tstamp
                }
            }
            const fullDistance = end.tstamp - start.tstamp

            // In case of constant tempo no tempo curve needs to be 
            // interpolated.
            if (start.bpm !== end.bpm && fullDistance > start.beatLength) {
                const meanTempoAt = (meanTempoAtQstamp - start.tstamp) / fullDistance

                // create a new tempo curve
                const powFunction = generatePowFunction(start, end, meanTempoAt)

                // find point of maximum distance from this curve
                let dmax = 0
                let index = 0
                for (let i = 1; i < points.length - 1; i++) {
                    const d = Math.abs(points[i].bpm - powFunction(points[i].tstamp))
                    if (d > dmax) {
                        index = i
                        dmax = d
                    }
                }

                if (dmax > epsilon) {
                    douglasPeucker(points.slice(0, index + 1), epsilon)
                    douglasPeucker(points.slice(index), epsilon)
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

                    // update the MSM bpm values accordingly
                    msm.allNotes.forEach(n => {
                        if (n.date >= start.tstamp) {
                            n['bpm'] = Math.abs(+powFunction(n.date))
                            n['bpm.beatLength'] = start.beatLength / 720 / 4

                        }
                    })

                    // add <tempo> at the target date of the transition
                    tempos.push({
                        'type': 'tempo',
                        'xml:id': 'tempo_' + v4(),
                        'date': end.tstamp,
                        'bpm': Math.abs(+powFunction(end.tstamp).toFixed(precision)),
                        'beatLength': end.beatLength / 720 / 4
                    })

                    // update the MSM bpm values accordingly
                    msm.allNotes.forEach(n => {
                        if (n.date >= end.tstamp) {
                            n['bpm'] = Math.abs(+powFunction(end.tstamp))
                            n['bpm.beatLength'] = end.beatLength
                        }
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
                msm.allNotes.forEach(n => {
                    if (n.date >= start.tstamp) {
                        n['bpm'] = Math.abs(+start.bpm)
                        n['bpm.beatLength'] = start.beatLength / 720 / 4
                    }
                })
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
            console.log('beatLength=', beatLength)

            for (let date = 0; date <= msm.lastDate(); date += beatLength) {
                const performedNotes = msm.notesAtDate(date, 'global')
                console.log('performed notes=', performedNotes)

                if (performedNotes[0] && performedNotes[0]['midi.onset']) {
                    onsets.push(performedNotes[0]["midi.onset"])
                    console.log('onsets=', onsets)
                    tstamps.push(date)
                    beatLengths.push(beatLength)

                    // put a virtual onset at the offset of the last note, 
                    // so that the tempo of the final note will be calculated
                    // on the basis of its length.
                    if (date === msm.lastDate()) {
                        onsets.push(performedNotes[0]['midi.onset'] + performedNotes[0]['midi.duration'])
                        tstamps.push(date + performedNotes[0].duration)
                        beatLengths.push(performedNotes[0].duration)
                    }
                }
                else {
                    // We singularly prolong the beat length until
                    // we find a succeeding event
                    beatLengths[beatLengths.length - 1] += beatLength
                }
            }
        }
        const bpms = asBPM(onsets)

        const points: InterpolationPoint[] = bpms.map((bpm, i) => ({
            tstamp: tstamps[i],
            bpm: bpm,
            beatLength: beatLengths[i]
        }))

        douglasPeucker(points, this.options?.epsilon || 4)

        mpm.insertInstructions(tempos, 'global')
        this.reduceMidiOnset(msm)
        this.calculateTickDurations(msm, mpm)
        return super.transform(msm, mpm)
    }

    /**
     * Substracts the calculated onsets from the original onsets, 
     * so that only the difference remains for further transformations.
     * 
     * @param msm MSM to perform the onset reduction on
     */
    reduceMidiOnset(msm: MSM) {
        const chords = Object.entries(msm.asChords('global'))
        let perfDate = 0
        chords.forEach(([date, chord], i) => {
            if (i === 0) return

            const dateDiff = +date - (+chords[i - 1][0])
            const bpm = chords[i - 1][1][0].bpm
            const bpmBeatLength = chords[i - 1][1][0]["bpm.beatLength"]
            if (!bpm) {
                console.log('No BPM found.')
                return
            }

            perfDate += ((60 / ((bpmBeatLength || 0.25) * 4)) / bpm) * (dateDiff / 720)

            chord.forEach(note => {
                note['midi.onset'] -= perfDate
            })
        })
    }

    /**
     * Translates MIDI durations into tick durations
     * using the new <tempo> instructions.
     * @todo Currently only consideres constant tempos.
     * Approximation of tempo curves still a todo.
     * @param msm 
     * @param mpm 
     */
    calculateTickDurations(msm: MSM, mpm: MPM) {
        for (const note of msm.allNotes) {
            const tempos = mpm.instructionEffectiveInRange<Tempo>(note.date, note.date + note.duration, 'tempo', 'global')
            note.tickDuration = calculateSymbolicNoteDuration(note, tempos)
        }
    }
}

