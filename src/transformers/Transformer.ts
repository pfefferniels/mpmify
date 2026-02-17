import { InstructionType, MPM, Scope } from "mpm-ts";
import { MSM } from "../msm";
import { MPMRecording } from "./MPMRecording";
import { v4 } from "uuid";
import { WithActor, WithId, WithNote } from "../../../doubtful/dist/assumption/utils";

export const beliefValues = [
    'authentic',
    'plausible',
    'speculative',
    'unfounded'
] as const;

export type Certainty = typeof beliefValues[number];

export interface Argumentation<T extends string = 'simpleArgumentation'> extends WithActor, WithNote, WithId {
    type: T;
    conclusion: ActivityBelief;
}

export const activityMotivations = [
    'move',
    'intensify',
    'relax',
    'calm',
] as const;

export type ActivityMotivation = typeof activityMotivations[number];

/**
 * For now both, E7 and I2
 */
export interface ActivityBelief extends WithId, WithNote {
    motivation: ActivityMotivation
    certainty: Certainty
}

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

export const isRangeBased = (transformer: TransformationOptions): transformer is TransformationOptions & { from: number; to: number } => {
    return 'from' in transformer && 'to' in transformer;
}

export const isDateBased = (transformer: TransformationOptions): transformer is TransformationOptions & { date: number } => {
    return 'date' in transformer;
}

export const isNoteBased = (transformer: TransformationOptions): transformer is TransformationOptions & { noteIDs: string[] } => {
    return 'noteIDs' in transformer;
}

type Range = {
    from: number;
    to?: number;
}

export const getRange = (transformer: TransformationOptions | TransformationOptions[], msm: MSM): Range | undefined => {
    if (Array.isArray(transformer)) {
        const ranges = transformer
            .map(t => {
                return getRange(t.options, msm)
            })
            .filter(d => !!d)

        if (ranges.length === 0) {
            return null;
        }

        const from = Math.min(...ranges.map(({ from }) => from));
        const to = Math.max(...ranges.map(({ from, to }) => Math.max(from, to || 0)));
        return { from, to };
    }

    if (isRangeBased(transformer)) {
        return { from: transformer.from, to: transformer.to }
    }
    if (isDateBased(transformer)) {
        if ('length' in transformer && typeof transformer.length === 'number') {
            return { from: transformer.date, to: transformer.date + transformer.length }
        }
        return { from: transformer.date }
    }
    if (isNoteBased(transformer)) {
        const noteids = transformer.noteIDs
        const dates = noteids
            .map(id => msm.getByID(id)?.date)
            .filter((d): d is number => d !== undefined)
        if (dates.length === 0) {
            return null
        }
        return { from: Math.min(...dates), to: Math.max(...dates) }
    }
    if ('pedal' in transformer) {
        const pedals = msm.pedals.filter(p => p['xml:id'] === transformer.pedal)
        const dates = pedals
            .map(p => p.tickDate)
            .filter((d): d is number => d !== undefined)
        if (dates.length === 0) {
            return
        }
        return { from: Math.min(...dates) }
    }
}
