import { MPM, Tempo } from "mpm-ts";
import { MSM } from "../msm";
import { BeatLengthBasis } from "./BeatLengthBasis";
import { AbstractTransformer, TransformationOptions } from "./Transformer";
import { CurvedTempoTransformer } from "./CurvedTempoTransformer";
import { SimpleTempoTransformer } from "./SimpleTempoTransformer";

export interface TempoTransformerOptions extends TransformationOptions {
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

    /**
     * Defines whether physical modifiers which are already present in the MPM
     * (e.g. because of a previous <ornamentation> or <asynchrony> interpolation)
     * should be translated into symbolic ones.
     */
    translatePhysicalModifiers: boolean

    mode: 'constant' | 'linear' | 'curved'
}

/**
 * Meta transformer. Based on the given mode it decides which exact transformer to use.
 */
export class TempoTransformer extends AbstractTransformer<TempoTransformerOptions> {
    constructor(options?: TempoTransformerOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            beatLength: 'denominator',
            epsilon: 4,
            precision: 0,
            translatePhysicalModifiers: true,
            mode: 'constant'
        })
    }

    public name() { return 'TempoTransformer' }

    transform(msm: MSM, mpm: MPM): string {
        if (this.options.mode === 'curved') {
            const options = { ...this.options }
            delete options.mode
            return new CurvedTempoTransformer(options)
                .setNext(this.nextTransformer)
                .transform(msm, mpm)
        }

        const options = { ...this.options } as any
        delete options.mode
        options.linearTransitions = this.options.mode === 'linear'
        return new SimpleTempoTransformer(options)
            .setNext(this.nextTransformer)
            .transform(msm, mpm)
    }
}


