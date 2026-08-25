import { describe, expect, test } from 'vitest';
import { StylizeArticulation } from '../../src/transformers/articulation/StylizeArticulation';
import { StylizeOrnamentation } from '../../src/transformers/ornamentation/StylizeOrnamentation';

/**
 * A tolerance of `0` is a request, not a missing argument.
 *
 * Both transformers fold their caller's options into defaults with `||`, so a legitimate `0`
 * fell back to the default — and `0` is meaningful here: it asks dbscan for exact matches only,
 * which is what the `noteoff.shift` dimension of `StylizeOrnamentation.generateClusters` already
 * does deliberately. `StylizeOrnamentation` went further and never read two of its three options
 * at all (issue #33).
 *
 * The `StylizeArticulation` half is the more pressing one: #25 reported that transformer as a
 * no-op after `InsertArticulation`, and a caller diagnosing that by asking for exact matches got
 * 0.01 instead, with nothing to say so.
 */
describe('StylizeArticulation options', () => {
  test('defaults stand when nothing is passed', () => {
    expect(new StylizeArticulation().options).toEqual({
      volumeTolerance: 0.01,
      relativeDurationTolerance: 0.2,
    });
  });

  test('a tolerance of 0 is kept', () => {
    expect(
      new StylizeArticulation({ volumeTolerance: 0, relativeDurationTolerance: 0 }).options,
    ).toEqual({ volumeTolerance: 0, relativeDurationTolerance: 0 });
  });

  test('one option can be given without the other', () => {
    expect(new StylizeArticulation({ volumeTolerance: 5 }).options).toEqual({
      volumeTolerance: 5,
      relativeDurationTolerance: 0.2,
    });
  });
});

describe('StylizeOrnamentation options', () => {
  test('defaults stand when nothing is passed', () => {
    expect(new StylizeOrnamentation().options).toEqual({
      tickTolerance: 10,
      intensityTolerance: 0.3,
      gradientTolerance: 0.1,
    });
  });

  test('all three are read, not only the first', () => {
    expect(
      new StylizeOrnamentation({
        tickTolerance: 5,
        intensityTolerance: 0.9,
        gradientTolerance: 0.9,
      }).options,
    ).toEqual({
      tickTolerance: 5,
      intensityTolerance: 0.9,
      gradientTolerance: 0.9,
    });
  });

  test('a tolerance of 0 is kept', () => {
    expect(
      new StylizeOrnamentation({
        tickTolerance: 0,
        intensityTolerance: 0,
        gradientTolerance: 0,
      }).options,
    ).toEqual({
      tickTolerance: 0,
      intensityTolerance: 0,
      gradientTolerance: 0,
    });
  });
});
