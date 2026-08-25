import { addCorresp, InstructionType, MPM, Scope } from "../mpm";
import { MSM } from "../msm";
import { MPMRecording } from "./MPMRecording";
import { Residual } from "../residual";
import { v4 } from "uuid";
type WithId = { id: string };
type WithActor = { actor?: { name: string; sameAs: string[]; role?: string } };
type WithNote = { note?: string };

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
    continue?: string;  // id of the predecessor argumentation in the chain
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

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TransformerConstructor = new (...args: any[]) => Transformer;

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

    /**
     * Assigned by whoever builds the chain — `importWork` off a saved file, the desk when the
     * user creates or edits one — never by the transformer itself, which is why there is no
     * initializer here and why `run` reads it through `?.`.
     *
     * Declared as definitely assigned rather than optional because the contract holds on every
     * transformer that reaches a chain, and `Transformer.argumentation` is consumed as required
     * downstream. The window in which it is genuinely absent is between `new` and the caller's
     * next statement.
     */
    argumentation!: Argumentation;

    abstract readonly requires: Array<TransformerConstructor>

    protected constructor(options: OptionsType) {
        this.options = options
    }

    // this method should not be overridden
    public run(msm: MSM, mpm: MPM) {
        const mpmRecording = new MPMRecording(mpm)
        this.transform(msm, mpmRecording)
        this.created = mpmRecording.created

        this.insertMetadata(mpm)
    }

    protected abstract transform(msm: MSM, mpm: MPM): void

    private insertMetadata(mpm: MPM) {
        this.created.forEach(id => {
            const instruction = mpm.findInstructionById(id)
            if (!instruction) {
                return
            }

            addCorresp(instruction.element, this.argumentation?.id || this.id)
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

/**
 * The span of score a transformer acts on.
 *
 * @param residual required only for a pedal-based transformer, whose span is measured in ticks
 * off the score grid and so has to be derived. Every other kind answers from its own options.
 * Omitting it where it is needed throws rather than returning `undefined`: the pedal branch used
 * to drop any pedal it could not place and then report no range at all, which reads exactly like
 * a chain that happens not to touch a pedal.
 */
export const getRange = (
    transformer: TransformationOptions | Transformer[],
    msm: MSM,
    residual?: Residual
): Range | undefined => {
    if (Array.isArray(transformer)) {
        const ranges = transformer
            .map(t => {
                return getRange(t.options, msm, residual)
            })
            .filter(d => !!d)

        if (ranges.length === 0) {
            return undefined;
        }

        const from = Math.min(...ranges.map(({ from }) => from));
        const to = Math.max(...ranges.map(({ from, to }) => Math.max(from, to ?? from)));
        if (to <= from) return { from };
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
            return undefined
        }
        return { from: Math.min(...dates), to: Math.max(...dates) }
    }
    if ('pedal' in transformer) {
        const pedalId = (transformer as TransformationOptions & { pedal?: string }).pedal
        const pedals = pedalId
            ? msm.pedals.filter(p => p['xml:id'] === pedalId)
            : msm.pedals

        const direction = 'direction' in transformer ? (transformer as TransformationOptions & { direction?: string }).direction : undefined
        const start = 'start' in transformer ? (transformer as TransformationOptions & { start?: number }).start ?? 0 : 0
        const duration = 'duration' in transformer ? (transformer as TransformationOptions & { duration?: number }).duration ?? 0 : 0

        if (!residual) {
            throw new Error(
                'getRange needs a residual to place a pedal: its position on the score grid is '
                + 'derived from the MPM, not carried on the pedal. Pass deriveResidual(msm, mpm).')
        }

        const ranges = pedals
            .map(p => {
                const placed = residual.ofPedal(p)
                if (placed?.tickDate === undefined || placed.tickDuration === undefined) return undefined
                const base = direction === 'up' ? placed.tickDate + placed.tickDuration : placed.tickDate
                return { from: base + start, to: base + start + duration }
            })
            .filter((r): r is { from: number; to: number } => r !== undefined)

        if (ranges.length === 0) {
            return
        }
        return { from: Math.min(...ranges.map(r => r.from)), to: Math.max(...ranges.map(r => r.to)) }
    }
}
