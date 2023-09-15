import { MSM } from "../msm";
import { MPM } from "../mpm";

/**
 * 
 */
export interface TransformationOptions {
}

/**
 * The Transformer interface declares a method for building the chain of transformations.
 * It also declares a method for executing a transformation.
 */
export interface Transformer {
    setNext(transformer: Transformer): Transformer
    transform(msm: MSM, mpm: MPM): string
    setOptions(options: TransformationOptions): void
    name(): string
}

/**
 * The default chaining behavior.
 */
export abstract class AbstractTransformer<OptionsType extends TransformationOptions> implements Transformer {
    public nextTransformer?: Transformer
    public options?: OptionsType

    public setNext(transformer: Transformer): Transformer {
        this.nextTransformer = transformer;
        return this;
    }

    public transform(msm: MSM, mpm: MPM): string {
        if (this.nextTransformer) {
            return this.nextTransformer.transform(msm, mpm)
        }

        return 'done'
    }

    public setOptions(options: OptionsType) {
        this.options = options
    }

    abstract name(): string
}
