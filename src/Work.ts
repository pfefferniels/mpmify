import { v4 } from "uuid";
import { MakeChoice, compareTransformers } from "./transformers";
import { Argumentation, TransformationOptions, Transformer } from "./transformers/Transformer";
import { createTransformer } from "./transformers/TransformerRegistry";

export interface Work {
    name: string;
    mpm: string;
    mei: string;
}

export type ImportResult = {
    transformers: Transformer[];
    secondary?: Record<string, unknown>;
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

export function exportWork(work: Work, transformers: Transformer[], secondary?: Record<string, unknown>): string {
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
                    calls: calls.map(({ argumentation: _, ...rest }) => rest)
                }
            })
        },
        ...(secondary !== undefined && { secondary })
    }

    function replacer(key: string, value: unknown) {
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


/** One entry of a saved argumentation's `calls`. Everything but the name may be absent. */
type SerializedCall = {
    name: string;
    id?: string;
    options?: TransformationOptions;
    created?: string[];
}

type SerializedArgumentation = Argumentation & { calls: SerializedCall[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The argumentations of a parsed work file.
 *
 * This is the only place mpmify reads a document it did not write in this process, and it used
 * to reach straight through `imported.creation.argumentations`. A file that was truncated, or
 * written by something that is not mpmify, therefore surfaced as `Cannot read properties of
 * undefined` — true, but silent about which part of the file was missing. Each step now says
 * what it expected to find.
 *
 * The narrowing is checked down to `calls` being a list and each call naming a transformer;
 * below that the cast stands in for a schema, because the option shapes are the transformers'
 * own and this module does not know them.
 */
const readArgumentations = (imported: Record<string, unknown>): SerializedArgumentation[] => {
    const creation = imported.creation;
    if (!isRecord(creation)) {
        throw new Error('Not a work file: no "creation" object at the top level');
    }

    const argumentations = creation.argumentations;
    if (!Array.isArray(argumentations)) {
        throw new Error('Not a work file: "creation.argumentations" is missing or not a list');
    }

    return argumentations.map((argumentation, index) => {
        if (!isRecord(argumentation) || !Array.isArray(argumentation.calls)) {
            throw new Error(`Work file argumentation ${index} has no "calls" list`);
        }
        for (const call of argumentation.calls) {
            if (!isRecord(call) || typeof call.name !== 'string') {
                throw new Error(`Work file argumentation ${index} has a call with no name`);
            }
        }
        return argumentation as unknown as SerializedArgumentation;
    });
}

export function importWork(json: string): ImportResult {
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

    const imported: unknown = JSON.parse(json, reviver);
    if (!isRecord(imported)) {
        throw new Error('Not a work file: expected a JSON object');
    }

    const transformers = readArgumentations(imported)
        .flatMap(argumentation => argumentation.calls.map(call => ({ call, argumentation })))
        .map(({ call, argumentation }) => {
            const transformer = createTransformer(call.name);
            if (!transformer) {
                console.warn(`Unknown transformer name: ${call.name}`);
                return null;
            }
            transformer.id = call.id || v4();
            if (call.options !== undefined) transformer.options = call.options;
            transformer.argumentation = argumentation;
            transformer.created = call.created ?? [];
            return transformer;
        })
        .filter((transformer): transformer is Transformer => transformer !== null)

    return {
        transformers: transformers.sort(compareTransformers),
        ...(imported.secondary !== undefined && { secondary: imported.secondary as Record<string, unknown> })
    };
}
