import { InsertMetricalAccentuation } from "./accentuation";
import { InsertArticulation } from "./articulation";
import { MakeChoice } from "./choice/MakeChoice";
import { InsertDynamicsInstructions } from "./dynamics";
import { Modify } from "./modification/Modify";
import { InsertTemporalSpread, InsertDynamicsGradient, StylizeOrnamentation } from "./ornamentation";
import { InsertPedal } from "./pedal/InsertPedalInstructions";
import { InsertRubato } from "./rubato/InsertRubato";
import { ApproximateLogarithmicTempo, TranslatePhyiscalTimeToTicks } from "./tempo";
import { Transformer } from "./Transformer";

/**
 * The standard order of transformers.
 */
export const transformerOrder = [
    new MakeChoice().name,
    new Modify().name,
    new InsertTemporalSpread().name,
    new InsertDynamicsGradient().name,
    new ApproximateLogarithmicTempo().name,
    new TranslatePhyiscalTimeToTicks().name,
    new StylizeOrnamentation().name,
    new InsertRubato().name,
    new InsertDynamicsInstructions().name,
    new InsertMetricalAccentuation().name,
    new InsertArticulation().name,
    new InsertPedal().name
] as const;

/**
 * This function is meant to be passed to Array.sort()
 */
export const compareTransformers = (a: Transformer, b: Transformer) => {
    const aIndex = transformerOrder.indexOf(a.name);
    const bIndex = transformerOrder.indexOf(b.name);

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

