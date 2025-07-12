import { Transformer } from "./transformers/Transformer";

export interface Argumentation {
    id: string;
    description: string;
    author?: string;
    encoder?: string;
}

export interface Work {
    name: string;
    expression: string;
}

export function exportWork(work: Work, transformers: Transformer[]): string {
    const argumentations = Map.groupBy(transformers, t => t.argumentation)

    const jsonLd = {
        "@context": {
            "crm": "http://www.cidoc-crm.org/cidoc-crm/",
            "crminf": "http://www.cidoc-crm.org/extensions/crminf/",
            "lrm": "http://iflastandards.info/ns/lrm/lrmoo/",
            "id": "@id",
            "type": "@type",
            "name": "crm:P2_has_title",
            "expression": "lrm:R3_is_realised_in",
            "creation": "lrm:R16i_was_created_by",
            "argumentations": "crm:P9_consists_of",
            "calls": "crm:P9_consists_of",
            "author": "crm:P14_carried_out_by",
            "encoder": "crm:P14_carried_out_by",
            "description": "crm:P3_has_note",
        },
        "@type": "Reconstruction",
        ...work, 
        "creation": {
            argumentations
        }
    }

    return JSON.stringify(jsonLd, null, 2);
}