import { InsertMetricalAccentuation, MergeMetricalAccentuations } from "./accentuation";
import { InsertArticulation, MakeDefaultArticulation } from "./articulation";
import { StylizeArticulation } from "./articulation/StylizeArticulation";
import { MakeChoice } from "./choice/MakeChoice";
import { InsertDynamicsInstructions } from "./dynamics";
import { InsertMetadata } from "./metadata";
import { Modify } from "./modification/Modify";
import { InsertTemporalSpread, InsertDynamicsGradient, StylizeOrnamentation } from "./ornamentation";
import { InsertPedal } from "./pedal/InsertPedalInstructions";
import { CombineAdjacentRubatos } from "./rubato/CombineAdjacentRubatos";
import { InsertRubato } from "./rubato/InsertRubato";
import { ApproximateLogarithmicTempo, TranslatePhysicalTimeToTicks } from "./tempo";
import { Transformer } from "./Transformer";
import { getTransformerOrder, isRegistered, registerAlias, registerTransformer } from "./TransformerRegistry";

// Register all built-in transformers in their standard order.
registerTransformer(MakeChoice);
registerTransformer(Modify);
registerTransformer(InsertTemporalSpread);
registerTransformer(InsertDynamicsGradient);
registerTransformer(ApproximateLogarithmicTempo);
registerTransformer(TranslatePhysicalTimeToTicks);
registerTransformer(StylizeOrnamentation);
registerTransformer(InsertRubato);
registerTransformer(CombineAdjacentRubatos);
registerTransformer(InsertDynamicsInstructions);
registerTransformer(InsertMetricalAccentuation);
registerTransformer(MergeMetricalAccentuations);
registerTransformer(InsertArticulation);
registerTransformer(StylizeArticulation);
registerTransformer(MakeDefaultArticulation);
registerTransformer(InsertPedal);
registerTransformer(InsertMetadata);

// The class name was misspelled for a long time and the misspelling reached saved work files.
registerAlias('TranslatePhyiscalTimeToTicks', 'TranslatePhysicalTimeToTicks');

/**
 * This function is meant to be passed to Array.sort()
 *
 * A name the registry has never seen sorts *after* everything known rather than before it:
 * `indexOf` answers -1, which used to place an unregistered transformer ahead of the chain it
 * depends on. `validate` reports the name separately, so the ordering here only has to be the
 * least surprising of the two possible wrong answers.
 */
export const compareTransformers = (a: Transformer, b: Transformer) => {
    const currentOrder = getTransformerOrder();
    const rank = (name: string) => {
        const index = currentOrder.indexOf(name);
        return index === -1 ? currentOrder.length : index;
    };
    const aIndex = rank(a.name);
    const bIndex = rank(b.name);

    if (aIndex === bIndex) {
        if ('from' in a.options && 'from' in b.options && typeof a.options.from === 'number' && typeof b.options.from === 'number') {
            return a.options.from - b.options.from;
        }
    }

    return aIndex - bIndex;
}

export type ValidationMessage = {
    index: number
    message: string
}

export const validate = (chain: Transformer[]) => {
    const messages: ValidationMessage[] = []
    const done: string[] = []
    for (const t of chain) {
        // An unregistered name cannot be rebuilt from a saved work file and is dropped by the
        // pipeline, so the chain would run without it and say nothing. Report it instead.
        if (!isRegistered(t.name)) {
            messages.push({
                index: chain.indexOf(t),
                message: `Transformer ${t.name} is not registered, so it cannot be ordered, saved or run`
            })
        }
        for (const required of t.requires) {
            const instance = new required()
            if (!done.includes(instance.name)) {
                messages.push({
                    index: chain.indexOf(t),
                    message: `Transformer ${t.name} requires ${instance.name} to be present in the chain`
                })
            }
        }
        done.push(t.name)
    }
    return messages
}
