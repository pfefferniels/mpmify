# Transformer Ordering

This document describes the transformer ordering functionality added to resolve issue #21.

## Overview

The mpmify library now includes a standardized ordering system for transformers that ensures they execute in the correct sequence to properly build up musical performance markup.

## Standard Transformer Order

The transformers must be executed in this specific order:

1. **MakeChoice** - Makes choices for performance decisions
2. **InsertTemporalSpread** - Adds temporal spread to ornamentations  
3. **InsertDynamicsGradient** - Inserts dynamics gradients for ornamentations
4. **InsertTempoInstructions** - Analyzes timing and creates tempo instructions
5. **TranslateToTicks** - Converts physical time to symbolic tick time (renamed from TranslatePhysicalTimeToTicks)
6. **InsertRubato** - Adds rubato markings
7. **InsertDynamicsInstructions** - Adds dynamics instructions
8. **InsertMetricalAccentuation** - Adds metrical accentuation patterns
9. **InsertArticulation** - Adds articulation markings

## Usage

### Basic Ordering

```typescript
import { orderTransformers } from './transformers/TransformerOrdering';

const transformers = [
    new InsertArticulation(),
    new MakeChoice(), 
    new InsertRubato(),
    // ... other transformers in any order
];

const orderedTransformers = orderTransformers(transformers);
// Now transformers are in the correct execution order
```

### Execution Planning

```typescript
import { createExecutionPlan } from './transformers/TransformerOrdering';

const transformers = [/* your transformers */];
const plan = createExecutionPlan(transformers);

if (plan.validation.isValid) {
    // Execute transformers in order
    for (const transformer of plan.orderedTransformers) {
        transformer.run(msm, mpm);
    }
} else {
    console.error('Validation errors:', plan.validation.errors);
}
```

### Validation

```typescript
import { validateTransformerOrder } from './transformers/TransformerOrdering';

const validation = validateTransformerOrder(transformers);
if (!validation.isValid) {
    console.error('Missing dependencies:', validation.errors);
}
```

## API Reference

### `orderTransformers(transformers: Transformer[]): Transformer[]`

Sorts an array of transformer instances according to the standard execution order.

- **transformers**: Array of transformer instances to sort
- **Returns**: New array with transformers in correct order

### `getTransformerOrderIndex(transformerClass: any): number`

Gets the execution order index for a transformer class.

- **transformerClass**: The transformer class/constructor
- **Returns**: Index in the standard order, or -1 if not found

### `validateTransformerOrder(transformers: Transformer[]): { isValid: boolean; errors: string[] }`

Validates that transformers can be executed in the standard order.

- **transformers**: Array of transformer instances to validate
- **Returns**: Validation result with any error messages

### `createExecutionPlan(transformers: Transformer[]): { orderedTransformers: Transformer[]; validation: ValidationResult }`

Creates a complete execution plan with ordering and validation.

- **transformers**: Array of transformer instances
- **Returns**: Object with ordered transformers and validation results

## Changes Made

### New Files
- `src/transformers/TransformerOrdering.ts` - Main ordering functionality
- `src/transformers/tempo/InsertTempoInstructions.ts` - Missing transformer implementation
- `test/transformers/TransformerOrdering.test.ts` - Comprehensive test suite

### Renamed Files
- `TranslatePhysicalTimeToTicks.ts` → `TranslateToTicks.ts`
- `TranslatePhysicalTimeToTicks.test.ts` → `TranslateToTicks.test.ts`

### Updated Files
- All transformer files that imported the old `TranslatePhysicalTimeToTicks`
- Export files to include new functionality
- Work.ts to support new transformer names

## Testing

Run the transformer ordering tests:

```bash
npm test -- test/transformers/TransformerOrdering.test.ts
```

## Migration Guide

If you were using `TranslatePhysicalTimeToTicks`, update your imports:

```typescript
// Old
import { TranslatePhysicalTimeToTicks } from './transformers/tempo/TranslatePhysicalTimeToTicks';

// New  
import { TranslateToTicks } from './transformers/tempo/TranslateToTicks';
```

The class name and functionality remain the same, only the name has changed per the issue requirements.