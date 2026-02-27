import { InsertMetricalAccentuation, MergeMetricalAccentuations } from "./accentuation";
import { InsertArticulation } from "./articulation";
import { StylizeArticulation } from "./articulation/StylizeArticulation";
import { MakeChoice } from "./choice/MakeChoice";
import { InsertDynamicsInstructions } from "./dynamics";
import { InsertMetadata } from "./metadata";
import { Modify } from "./modification/Modify";
import { InsertTemporalSpread, InsertDynamicsGradient, StylizeOrnamentation } from "./ornamentation";
import { InsertPedal } from "./pedal/InsertPedalInstructions";
import { CombineAdjacentRubatos } from "./rubato/CombineAdjacentRubatos";
import { InsertRubato } from "./rubato/InsertRubato";
import { ApproximateLogarithmicTempo, TranslatePhyiscalTimeToTicks } from "./tempo";
import { Transformer } from "./Transformer";
import { getTransformerOrder, registerTransformer } from "./TransformerRegistry";

// Register all built-in transformers in their standard order.
registerTransformer(MakeChoice);
registerTransformer(Modify);
registerTransformer(InsertTemporalSpread);
registerTransformer(InsertDynamicsGradient);
registerTransformer(ApproximateLogarithmicTempo);
registerTransformer(TranslatePhyiscalTimeToTicks);
registerTransformer(StylizeOrnamentation);
registerTransformer(InsertRubato);
registerTransformer(CombineAdjacentRubatos);
registerTransformer(InsertDynamicsInstructions);
registerTransformer(InsertMetricalAccentuation);
registerTransformer(MergeMetricalAccentuations);
registerTransformer(InsertArticulation);
registerTransformer(StylizeArticulation);
registerTransformer(InsertPedal);
registerTransformer(InsertMetadata);

/**
 * This function is meant to be passed to Array.sort()
 */
export const compareTransformers = (a: Transformer, b: Transformer) => {
    const currentOrder = getTransformerOrder();
    const aIndex = currentOrder.indexOf(a.name);
    const bIndex = currentOrder.indexOf(b.name);

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
