import { InsertMetricalAccentuation, MergeMetricalAccentuations } from './accentuation/index.js';
import { InsertArticulation, MakeDefaultArticulation } from './articulation/index.js';
import { StylizeArticulation } from './articulation/StylizeArticulation.js';
import { InsertAsynchrony } from './asynchrony/InsertAsynchrony.js';
import { MakeChoice } from './choice/MakeChoice.js';
import { InsertDynamicsInstructions } from './dynamics/index.js';
import { InsertMetadata } from './metadata/index.js';
import { Modify } from './modification/Modify.js';
import {
  CompressOrnamentation,
  InsertTemporalSpread,
  InsertDynamicsGradient,
  StylizeOrnamentation,
} from './ornamentation/index.js';
import { InsertPedal } from './pedal/InsertPedalInstructions.js';
import { CombineAdjacentRubatos } from './rubato/CombineAdjacentRubatos.js';
import { InsertRubato } from './rubato/InsertRubato.js';
import {
  ApproximateLogarithmicTempo,
  InsertTempo,
  TranslatePhysicalTimeToTicks,
} from './tempo/index.js';
import type { Transformer } from './Transformer.js';
import {
  getTransformerOrder,
  isRegistered,
  registerAlias,
  registerTransformer,
} from './TransformerRegistry.js';

// Register all built-in transformers in their standard order.
registerTransformer(MakeChoice);
registerTransformer(Modify);
// The gradient before the spread, because the spread destroys what the gradient reads.
// `InsertDynamicsGradient` sorts a chord by `milliseconds.date` to find which way its ramp runs, and
// `InsertTemporalSpread` collapses every onset in the chord onto one date. Run the other way
// round, the direction is read off onsets that no longer differ and every arpeggio's ramp comes
// back reversed — a truth of 39/51.5/64 refitting as 64/51.5/39. `InsertDynamicsGradient`'s own
// doc comment has said so all along; the registry disagreed with it. See issue #32.
//
// The order carries a second weight the two transformers do not state. They share one
// `<ornament>` through `fillInAt`, which leaves a field the element already has alone — and
// espressivo's `addOrnamentV3` always writes `@scale`, at the spec's default of 0. So an
// `<ornament>` the spread wrote already has a scale, and the gradient's fitted one would be
// dropped into it silently. Gradient first, and the question does not arise.
registerTransformer(InsertDynamicsGradient);
registerTransformer(InsertTemporalSpread);
registerTransformer(ApproximateLogarithmicTempo);
// Also before `TranslatePhysicalTimeToTicks`, and for the same reason as the line below:
// `InsertTempo` calls `shiftToFirstOnset`, which rewrites `milliseconds.date` on every note.
registerTransformer(InsertTempo);
// Before `TranslatePhysicalTimeToTicks`, because it edits `milliseconds.date` and that transformer
// reads the physical domain to convert it. Unregistered, it sorted *after* everything known —
// `compareTransformers` ranks an unknown name last — so it ran on onsets the conversion had
// already been done against, and `requires: []` meant `validate` said nothing either. `requires`
// still cannot carry this: it asserts that a name appears *earlier* in the chain, which is the
// opposite relation. See issue #31.
registerTransformer(InsertAsynchrony);
registerTransformer(TranslatePhysicalTimeToTicks);
registerTransformer(StylizeOrnamentation);
// After `StylizeOrnamentation`, which is also what its `requires` says: it rounds the frames of
// the `<ornamentDef>`s that transformer writes, so there is nothing for it to round before.
registerTransformer(CompressOrnamentation);
registerTransformer(InsertRubato);
registerTransformer(CombineAdjacentRubatos);
registerTransformer(InsertDynamicsInstructions);
registerTransformer(InsertMetricalAccentuation);
registerTransformer(MergeMetricalAccentuations);
registerTransformer(InsertArticulation);
registerTransformer(StylizeArticulation);
registerTransformer(MakeDefaultArticulation);
registerTransformer(InsertPedal);
registerTransformer(InsertMetadata);

// The class name was misspelled for a long time and the misspelling reached saved work files.
registerAlias('TranslatePhyiscalTimeToTicks', 'TranslatePhysicalTimeToTicks');

/**
 * This function is meant to be passed to Array.sort()
 *
 * A name the registry has never seen sorts *after* everything known rather than before it:
 * `indexOf` answers -1, which used to place an unregistered transformer ahead of the chain it
 * depends on. `validate` reports the name separately, so the ordering here only has to be the
 * least surprising of the two possible wrong answers.
 */
export const compareTransformers = (a: Transformer, b: Transformer): number => {
  const currentOrder = getTransformerOrder();
  const rank = (name: string) => {
    const index = currentOrder.indexOf(name);
    return index === -1 ? currentOrder.length : index;
  };
  const aIndex = rank(a.name);
  const bIndex = rank(b.name);

  if (aIndex === bIndex) {
    if (
      'from' in a.options &&
      'from' in b.options &&
      typeof a.options.from === 'number' &&
      typeof b.options.from === 'number'
    ) {
      return a.options.from - b.options.from;
    }
  }

  return aIndex - bIndex;
};

export interface ValidationMessage {
  index: number;
  message: string;
}

export const validate = (chain: Transformer[]): ValidationMessage[] => {
  const messages: ValidationMessage[] = [];
  const done: string[] = [];
  for (const t of chain) {
    // An unregistered name cannot be rebuilt from a saved work file and is dropped by the
    // pipeline, so the chain would run without it and say nothing. Report it instead.
    if (!isRegistered(t.name)) {
      messages.push({
        index: chain.indexOf(t),
        message: `Transformer ${t.name} is not registered, so it cannot be ordered, saved or run`,
      });
    }
    for (const required of t.requires) {
      const instance = new required();
      if (!done.includes(instance.name)) {
        messages.push({
          index: chain.indexOf(t),
          message: `Transformer ${t.name} requires ${instance.name} to be present in the chain`,
        });
      }
    }
    done.push(t.name);
  }
  return messages;
};
