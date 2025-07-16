import { InsertMetricalAccentuation } from "./accentuation";
import { InsertArticulation } from "./articulation";
import { MakeChoice } from "./choice/MakeChoice";
import { InsertDynamicsInstructions } from "./dynamics";
import { InsertTemporalSpread, InsertDynamicsGradient } from "./ornamentation";
import { InsertRubato } from "./rubato/InsertRubato";
import { ApproximateLogarithmicTempo, TranslatePhyiscalTimeToTicks } from "./tempo";
import { Transformer } from "./Transformer";

/**
 * The standard order of transformers.
 */
export const transformerOrder = [
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

export const getTransformerOrderIndex = (transformerClass: any): number => {
    return transformerOrder.indexOf(transformerClass);
}

/**
 * This function is meant to be passed to Array.sort()
 */
export const compareTransformers = (a: Transformer, b: Transformer) => {
    const aIndex = getTransformerOrderIndex(a.constructor);
    const bIndex = getTransformerOrderIndex(b.constructor);

    return aIndex - bIndex;
}
