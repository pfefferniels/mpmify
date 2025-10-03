import { v4 } from "uuid";
import { InsertDynamicsInstructions, InsertDynamicsGradient, InsertTemporalSpread, InsertRubato, ApproximateLogarithmicTempo, InsertMetricalAccentuation, InsertPedal, CombineAdjacentRubatos, StylizeOrnamentation, StylizeArticulation, TranslatePhyiscalTimeToTicks, MergeMetricalAccentuations, InsertArticulation, MakeChoice, compareTransformers, Modify } from "./transformers";
import { Transformer } from "./transformers/Transformer";
import { Argumentation } from "doubtful/inverse"

// export const beliefValues = [
// 'authentic',
// 'plausible',
// 'speculative',
// 'unfounded'
// ] as const;
// 
// export type BeliefValue = typeof beliefValues[number];


export interface Work {
    name: string;
    mpm: string;
    mei: string;
}

export type ArgumentationWithCalls = Argumentation & {
    calls: Omit<Transformer, 'run' | 'requires' | 'argumentation'>[];
}

export const getArgumentationsWithCalls = (transformers: Transformer[]): ArgumentationWithCalls[] => {
    const argumentations = new Map<string, ArgumentationWithCalls>();

    for (const transformer of transformers) {
        if (!argumentations.has(transformer.argumentation.id)) {
            argumentations.set(transformer.argumentation.id, {
                ...transformer.argumentation,
                calls: []
            });
        }
        argumentations.get(transformer.argumentation.id)!.calls.push({
            id: transformer.id,
            name: transformer.name,
            options: transformer.options,
            created: transformer.created
        });
    }

    return Array.from(argumentations.values());
}

export function exportWork(work: Work, transformers: Transformer[]): string {
    const argumentations = Map.groupBy(transformers, t => t.argumentation)

    // TODO: convert the order into a single-linked list (P134 continued)

    const jsonLd = {
        "@context": {
            "crm": "http://www.cidoc-crm.org/cidoc-crm/",
            "crminf": "http://www.cidoc-crm.org/extensions/crminf/",
            "lrm": "http://iflastandards.info/ns/lrm/lrmoo/",
            "id": "@id",
            "ids": "@id",
            "type": "@type",
            "name": "crm:P2_has_type",
            "expression": "lrm:R3_is_realised_in",
            "creation": "lrm:R16i_was_created_by",
            "argumentations": {
                "@id": "crm:P9_consists_of",
                "@type": "crminf:I1_Argumentation"
            },
            "calls": {
                "@id": "crm:P9_consists_of",
                "@type": "crmdig:D10_Software_Execution"
            },
            "author": "crm:P14_carried_out_by",
            "encoder": "crm:P14_carried_out_by",
            "note": "crm:P3_has_note",
            "incorporates": "crm:P15_was_influenced_by",
            "conclusion": {
                "@id": "crminf:J2_concluded_that",
                "@type": "crminf:I2_Belief"
            },
            "that": "crminf:J27_that_the_formal_meaning_of",
            "certainty": "crminf:J5_holds_to_be"
        },
        "@type": "Reconstruction",
        ...work,
        "creation": {
            incorporates:
                Array.from(
                    new Set(transformers
                        .filter((t): t is MakeChoice => t.name === 'MakeChoice')
                        .map(t => 'prefer' in t.options
                            ? [t.options.prefer]
                            : [t.options.velocity, t.options.timing])
                        .flat())
                ),
            argumentations: Array.from(argumentations.entries()).map(([argumentation, calls]) => {
                return {
                    ...argumentation,
                    calls: calls.map(({ argumentation, ...rest }) => rest)
                }
            })
        }
    }

    function replacer(key: string, value: any) {
        // ignore 'requires', its just an internal property
        if (key === 'requires') return undefined

        if (value instanceof Map) {
            return {
                dataType: 'Map',
                value: Array.from(value.entries()),
            }
        }
        else if (value instanceof Set) {
            return {
                dataType: 'Set',
                value: Array.from(value.values()),
            }
        }
        else {
            return value;
        }
    }

    return JSON.stringify(jsonLd, replacer, 2);
}


export function importWork(json: string): Transformer[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function reviver(_: string, value: any) {
        if (typeof value === 'object' && value !== null) {
            if (value.dataType === 'Map') {
                return new Map(value.value);
            }
            else if (value.dataType === 'Set') {
                return new Set(value.value);
            }
        }
        return value;
    }

    const imported = JSON.parse(json, reviver);

    const transformers =
        imported.creation.argumentations
            .map(a => a.calls.map(call => ({
                ...call,
                argumentation: a
            })))
            .flat()
            .map(t => {
                let transformer: Transformer | null = null;
                if (t.name === 'MakeChoice') {
                    transformer = new MakeChoice();
                }
                else if (t.name === 'Modify') {
                    transformer = new Modify(t.options);
                }
                else if (t.name === 'InsertDynamicsInstructions') {
                    transformer = new InsertDynamicsInstructions();
                }
                else if (t.name === 'InsertDynamicsGradient') {
                    transformer = new InsertDynamicsGradient();
                }
                else if (t.name === 'InsertTemporalSpread') {
                    transformer = new InsertTemporalSpread();
                }
                else if (t.name === 'InsertRubato') {
                    transformer = new InsertRubato();
                }
                else if (t.name === 'ApproximateLogarithmicTempo') {
                    transformer = new ApproximateLogarithmicTempo();
                }
                else if (t.name === 'InsertMetricalAccentuation') {
                    transformer = new InsertMetricalAccentuation();
                }
                //else if (t.name === 'InsertRelativeDuration') {
                //    transformer = new InsertRelativeDuration();
                //}
                //else if (t.name === 'InsertRelativeVolume') {
                //    transformer = new InsertRelativeVolume();
                //}
                else if (t.name === 'InsertPedal') {
                    transformer = new InsertPedal();
                }
                else if (t.name === 'CombineAdjacentRubatos') {
                    transformer = new CombineAdjacentRubatos();
                }
                else if (t.name === 'StylizeOrnamentation') {
                    transformer = new StylizeOrnamentation();
                }
                else if (t.name === 'StylizeArticulation') {
                    transformer = new StylizeArticulation();
                }
                else if (t.name === 'TranslatePhyiscalTimeToTicks') {
                    transformer = new TranslatePhyiscalTimeToTicks();
                }
                else if (t.name === 'MergeMetricalAccentuations') {
                    transformer = new MergeMetricalAccentuations();
                }
                else if (t.name === 'InsertArticulation') {
                    transformer = new InsertArticulation();
                }
                else {
                    return null;
                }

                if (!transformer) {
                    console.warn(`Unknown transformer name: ${t.name}`);
                    return null;
                }
                transformer.id = t.id || v4();
                transformer.options = t.options;
                transformer.argumentation = t.argumentation
                transformer.created = t.created
                return transformer;
            })
            .filter(t => t !== null)

    return transformers.sort(compareTransformers);
}
