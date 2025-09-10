import { InstructionType, MPM, Scope } from "mpm-ts";
import { MSM } from "../msm";
import { MPMRecording } from "./MPMRecording";
import { v4 } from "uuid";
import { Argumentation } from "../Work";

/**
 * 
 */
export interface TransformationOptions {
}

/**
 * The part on which the transformer is to be applied to.
 */
export interface ScopedTransformationOptions extends TransformationOptions {
    scope: Scope
}

/**
 * The Transformer interface declares a method for building the chain of transformations.
 * It also declares a method for executing a transformation.
 */
type TransformerConstructor = new (...args: any[]) => Transformer;

export interface Transformer {
    id: string
    readonly name: string
    options: TransformationOptions
    created: string[]
    run(msm: MSM, mpm: MPM): void
    readonly requires: Array<TransformerConstructor>
    argumentation: Argumentation
}

/**
 * The default chaining behavior.
 */
export abstract class AbstractTransformer<OptionsType extends TransformationOptions> implements Transformer {
    id: string = v4()
    abstract readonly name: string
    options: OptionsType
    created: string[] = []
    argumentation: Argumentation;

    abstract readonly requires: Array<TransformerConstructor>

    // this method should not be overridden
    public run(msm: MSM, mpm: MPM) {
        const mpmRecording = new MPMRecording(mpm)
        this.transform(msm, mpmRecording)
        this.created = mpmRecording.created

        this.insertMetadata(mpm)
    }

    protected abstract transform(msm: MSM, mpm: MPM);

    private insertMetadata(mpm: MPM) {
        this.created.forEach(id => {
            const instruction = mpm.getInstructions().find(i => i['xml:id'] === id)
            if (!instruction) {
                return
            }

            const newCorresp = this.argumentation?.id || this.id
            if (!instruction.corresp) {
                instruction.corresp = newCorresp
            }
            else if (!instruction.corresp.split(' ').includes(newCorresp)) {
                instruction.corresp += ' ' + newCorresp
            }
        })
    }
}

export type OptionsOf<T> = T extends AbstractTransformer<infer O> ? O : never;

export const generateId = (type: InstructionType, date: number, mpm: MPM) => {
    const instructions = mpm.getInstructions(type)
    const n = instructions.filter(i => i.date === date).length
    if (n === 0) return `${type}_${date}`
    return `${type}_${date}_${n}`
}
