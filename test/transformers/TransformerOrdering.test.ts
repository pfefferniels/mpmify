// @vitest-environment jsdom

import { expect, test, describe } from "vitest";
import { 
    orderTransformers, 
    getTransformerOrderIndex, 
    validateTransformerOrder,
    createExecutionPlan,
    TRANSFORMER_ORDER 
} from "../../src/transformers/TransformerOrdering";
import { MakeChoice } from "../../src/transformers/choice/MakeChoice";
import { InsertTemporalSpread } from "../../src/transformers/ornamentation/InsertTemporalSpread";
import { InsertDynamicsGradient } from "../../src/transformers/ornamentation/InsertDynamicsGradient";
import { InsertTempoInstructions } from "../../src/transformers/tempo/InsertTempoInstructions";
import { TranslateToTicks } from "../../src/transformers/tempo/TranslateToTicks";
import { InsertRubato } from "../../src/transformers/rubato/InsertRubato";
import { InsertDynamicsInstructions } from "../../src/transformers/dynamics/InsertDynamicsInstructions";
import { InsertMetricalAccentuation } from "../../src/transformers/accentuation/InsertMetricalAccentuation";
import { InsertArticulation } from "../../src/transformers/articulation/InsertArticulation";

describe('Transformer Ordering', () => {
    test('TRANSFORMER_ORDER contains all required transformers in correct order', () => {
        expect(TRANSFORMER_ORDER).toEqual([
            MakeChoice,
            InsertTemporalSpread,
            InsertDynamicsGradient,
            InsertTempoInstructions,
            TranslateToTicks,
            InsertRubato,
            InsertDynamicsInstructions,
            InsertMetricalAccentuation,
            InsertArticulation
        ]);
    });

    test('getTransformerOrderIndex returns correct indices', () => {
        expect(getTransformerOrderIndex(MakeChoice)).toBe(0);
        expect(getTransformerOrderIndex(InsertTemporalSpread)).toBe(1);
        expect(getTransformerOrderIndex(InsertDynamicsGradient)).toBe(2);
        expect(getTransformerOrderIndex(InsertTempoInstructions)).toBe(3);
        expect(getTransformerOrderIndex(TranslateToTicks)).toBe(4);
        expect(getTransformerOrderIndex(InsertRubato)).toBe(5);
        expect(getTransformerOrderIndex(InsertDynamicsInstructions)).toBe(6);
        expect(getTransformerOrderIndex(InsertMetricalAccentuation)).toBe(7);
        expect(getTransformerOrderIndex(InsertArticulation)).toBe(8);
    });

    test('getTransformerOrderIndex returns -1 for unknown transformers', () => {
        class UnknownTransformer {}
        expect(getTransformerOrderIndex(UnknownTransformer)).toBe(-1);
    });

    test('orderTransformers sorts transformers correctly', () => {
        // Create transformer instances in random order
        const transformers = [
            new InsertArticulation(),
            new MakeChoice(),
            new InsertRubato({ scope: 'global' }),
            new InsertTemporalSpread(),
            new TranslateToTicks()
        ];

        const ordered = orderTransformers(transformers);
        
        // Check that they are now in the correct order
        expect(ordered[0]).toBeInstanceOf(MakeChoice);
        expect(ordered[1]).toBeInstanceOf(InsertTemporalSpread);
        expect(ordered[2]).toBeInstanceOf(TranslateToTicks);
        expect(ordered[3]).toBeInstanceOf(InsertRubato);
        expect(ordered[4]).toBeInstanceOf(InsertArticulation);
    });

    test('orderTransformers maintains relative order for unknown transformers', () => {
        class UnknownTransformerA {
            name = 'UnknownA';
            requires = [];
            created = [];
            options = {};
            argumentation = { id: 'test', description: 'test' };
            run = () => {};
        }
        
        class UnknownTransformerB {
            name = 'UnknownB';
            requires = [];
            created = [];
            options = {};
            argumentation = { id: 'test', description: 'test' };
            run = () => {};
        }

        const transformers = [
            new UnknownTransformerA(),
            new MakeChoice(),
            new UnknownTransformerB(),
            new InsertTemporalSpread()
        ];

        const ordered = orderTransformers(transformers);
        
        // Known transformers should come first, in order
        expect(ordered[0]).toBeInstanceOf(MakeChoice);
        expect(ordered[1]).toBeInstanceOf(InsertTemporalSpread);
        
        // Unknown transformers should maintain their relative order
        expect(ordered[2]).toBeInstanceOf(UnknownTransformerA);
        expect(ordered[3]).toBeInstanceOf(UnknownTransformerB);
    });

    test('validateTransformerOrder detects missing dependencies', () => {
        // Create a transformer that requires another transformer that's not present
        const transformer = new InsertArticulation();
        // Note: InsertArticulation requires TranslateToTicks, but we're not including it
        
        const validation = validateTransformerOrder([transformer]);
        
        expect(validation.isValid).toBe(false);
        expect(validation.errors).toHaveLength(1);
        expect(validation.errors[0]).toContain('TranslateToTicks');
    });

    test('validateTransformerOrder passes with correct dependencies', () => {
        const transformers = [
            new MakeChoice(),
            new TranslateToTicks(),
            new InsertArticulation()
        ];
        
        const validation = validateTransformerOrder(transformers);
        
        expect(validation.isValid).toBe(true);
        expect(validation.errors).toHaveLength(0);
    });

    test('createExecutionPlan returns ordered transformers and validation', () => {
        const transformers = [
            new InsertArticulation(),
            new MakeChoice(),
            new TranslateToTicks()
        ];
        
        const plan = createExecutionPlan(transformers);
        
        expect(plan.orderedTransformers).toHaveLength(3);
        expect(plan.orderedTransformers[0]).toBeInstanceOf(MakeChoice);
        expect(plan.orderedTransformers[1]).toBeInstanceOf(TranslateToTicks);
        expect(plan.orderedTransformers[2]).toBeInstanceOf(InsertArticulation);
        
        expect(plan.validation.isValid).toBe(true);
    });
});