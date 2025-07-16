import { Transformer } from "./Transformer";
import { MakeChoice } from "./choice/MakeChoice";
import { InsertTemporalSpread } from "./ornamentation/InsertTemporalSpread";
import { InsertDynamicsGradient } from "./ornamentation/InsertDynamicsGradient";
import { InsertTempoInstructions } from "./tempo/InsertTempoInstructions";
import { TranslateToTicks } from "./tempo/TranslateToTicks";
import { InsertRubato } from "./rubato/InsertRubato";
import { InsertDynamicsInstructions } from "./dynamics/InsertDynamicsInstructions";
import { InsertMetricalAccentuation } from "./accentuation/InsertMetricalAccentuation";
import { InsertArticulation } from "./articulation/InsertArticulation";

/**
 * Defines the standard order of transformer execution.
 * This order ensures that transformers run in the correct sequence
 * to properly build up the musical performance markup.
 */
export const TRANSFORMER_ORDER = [
    MakeChoice,
    InsertTemporalSpread,
    InsertDynamicsGradient,
    InsertTempoInstructions,
    TranslateToTicks,
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

/**
 * Validates that the given transformers can be executed in the standard order.
 * Checks for missing dependencies and circular dependencies.
 */
export function validateTransformerOrder(transformers: Transformer[]): { 
    isValid: boolean; 
    errors: string[] 
} {
    const errors: string[] = [];
    const transformerMap = new Map<any, Transformer>();
    
    // Build a map of constructor to transformer instance
    for (const transformer of transformers) {
        transformerMap.set(transformer.constructor, transformer);
    }
    
    // Check each transformer's requirements
    for (const transformer of transformers) {
        for (const requiredClass of transformer.requires) {
            if (!transformerMap.has(requiredClass)) {
                errors.push(`Transformer ${transformer.name} requires ${requiredClass.name} but it is not present`);
                continue;
            }
            
            const currentIndex = getTransformerOrderIndex(transformer.constructor);
            const requiredIndex = getTransformerOrderIndex(requiredClass);
            
            // If both are in the standard order, check that the required transformer comes first
            if (currentIndex !== -1 && requiredIndex !== -1 && requiredIndex >= currentIndex) {
                errors.push(`Transformer ${transformer.name} requires ${requiredClass.name} but it comes later in the execution order`);
            }
        }
    }
    
    return {
        isValid: errors.length === 0,
        errors
    };
}

/**
 * Creates a properly ordered execution plan for the given transformers.
 * Returns the transformers in execution order along with validation results.
 */
export function createExecutionPlan(transformers: Transformer[]): {
    orderedTransformers: Transformer[];
    validation: { isValid: boolean; errors: string[] };
} {
    const orderedTransformers = orderTransformers(transformers);
    const validation = validateTransformerOrder(orderedTransformers);
    
    return {
        orderedTransformers,
        validation
    };
}