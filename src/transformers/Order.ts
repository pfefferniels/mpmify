import { InsertMetricalAccentuation } from "./accentuation";
import { InsertArticulation } from "./articulation";
import { MakeChoice } from "./choice/MakeChoice";
import { InsertDynamicsInstructions } from "./dynamics";
import { InsertTemporalSpread, InsertDynamicsGradient } from "./ornamentation";
import { InsertRubato } from "./rubato/InsertRubato";
import { ApproximateLogarithmicTempo, TranslatePhyiscalTimeToTicks } from "./tempo";

/**
 * Defines the standard order of transformer execution.
 * This order ensures that transformers run in the correct sequence
 * to properly build up the musical performance markup.
 */
export const TRANSFORMER_ORDER = [
    MakeChoice,
    InsertTemporalSpread,
    InsertDynamicsGradient,
    ApproximateLogarithmicTempo,
    TranslatePhyiscalTimeToTicks,
    InsertRubato,
    InsertDynamicsInstructions,
    InsertMetricalAccentuation,
    InsertArticulation
] as const;

/**
 * Gets the execution order index for a given transformer class.
 * Returns -1 if the transformer is not in the standard order.
 */
export function getTransformerOrderIndex(transformerClass: any): number {
    return TRANSFORMER_ORDER.indexOf(transformerClass);
}

/**
 * Sorts an array of transformer instances according to the standard execution order.
 * Transformers not in the standard order will be placed at the end, maintaining their relative order.
 */
export function orderTransformers(transformers: Transformer[]): Transformer[] {
    return transformers.slice().sort((a, b) => {
        const aIndex = getTransformerOrderIndex(a.constructor);
        const bIndex = getTransformerOrderIndex(b.constructor);

        // If both transformers are in the standard order, sort by order index
        if (aIndex !== -1 && bIndex !== -1) {
            return aIndex - bIndex;
        }

        // If only one is in the standard order, it comes first
        if (aIndex !== -1 && bIndex === -1) {
            return -1;
        }
        if (aIndex === -1 && bIndex !== -1) {
            return 1;
        }

        // If neither is in the standard order, maintain their relative order
        return 0;
    });
}
