import { expect, test } from 'vitest';
import { Alignment, type AlignedNote } from '../../src/alignment/index.js';
import {
  Mpm,
  createMpm,
  getDefinition,
  getInstructions,
  getStyles,
  requireMap,
} from '../../src/mpm/index.js';
import { InsertArticulation } from '../../src/transformers/articulation/InsertArticulation.js';
import { StylizeArticulation } from '../../src/transformers/articulation/StylizeArticulation.js';

/**
 * The chain issue #25 is about: `InsertArticulation` first, `StylizeArticulation` on what it
 * wrote. Every other articulation test hands `StylizeArticulation` `<articulation>` elements
 * built by hand, which still carry `@relativeDuration` and `@relativeVelocity` — and that is
 * exactly the state the real chain never produces, because `InsertArticulation` folds both into
 * the `<articulationDef>` and writes no modifier on the instruction at all. Clustering read the
 * instruction, so every point was `[undefined, undefined]`, every distance NaN, and the whole
 * transformer a no-op that five green tests could not see.
 */

/** A note that was played for `playedTicks` ticks — stated as a recording, read at 60bpm. */
const note = (id: string, date: number, pitch: number, playedTicks: number): AlignedNote => ({
  'xml:id': id,
  date,
  part: 1,
  pitchname: 'c',
  octave: 4,
  accidentals: 0,
  duration: 720,
  'midi.pitch': pitch,
  'milliseconds.date': (date / 720) * 1000,
  'milliseconds.date.end': ((date + playedTicks) / 720) * 1000,
  velocity: 64,
});

/** The tempo those recorded milliseconds are read against. */
const atSixtyBpm = () => {
  const mpm = createMpm();
  requireMap(mpm, 'tempo', 'global').addTempo({ id: 't1', date: 0, bpm: 60, beatLength: 0.25 });
  return mpm;
};

type Transformable = { transform(msm: Alignment, mpm: Mpm): void };
const callTransform = (
  transformer: InsertArticulation | StylizeArticulation,
  msm: Alignment,
  mpm: Mpm,
) => (transformer as unknown as Transformable).transform(msm, mpm);

const BOTH = new Set(['relativeDuration', 'relativeVelocity'] as const);

/** Eight notes on eight pitches, so no stretched note can run into a repeat of its own. */
const PITCHES = [60, 62, 64, 65, 67, 69, 71, 72];

const insert = (msm: Alignment, mpm: Mpm, name: string, ids: string[]) =>
  callTransform(
    new InsertArticulation({
      scope: 'global',
      noteIDs: ids,
      aspects: new Set(BOTH),
      name,
    }),
    msm,
    mpm,
  );

const stylize = (msm: Alignment, mpm: Mpm) => callTransform(new StylizeArticulation(), msm, mpm);

const defaultDef = (mpm: Mpm) => {
  const name = getStyles(mpm, 'articulation', 'global')[0]?.defaultArticulation;
  return name === undefined ? null : getDefinition(mpm, 'articulationDef', name);
};

test('the articulations InsertArticulation wrote are clustered, not read as noise', () => {
  // The issue's own evidence: two notes shortened alike, folded into one def named 'a', and
  // two `<articulation>` elements carrying nothing but `@name.ref="a"`. That is one cluster,
  // and being the only one it becomes the map's default — so the instructions can go.
  const msm = new Alignment([note('n0', 0, 60, 648), note('n1', 720, 62, 648)], {
    numerator: 4,
    denominator: 4,
  });

  const mpm = atSixtyBpm();
  insert(msm, mpm, 'a', ['n0', 'n1']);
  stylize(msm, mpm);

  const def = defaultDef(mpm);
  expect(def).not.toBeNull();
  expect(def!.getRelativeDuration()).toBeCloseTo(0.9, 6);
  expect(getInstructions(mpm, 'articulation', 'global')).toHaveLength(0);

  // And the def they were merged out of is gone with them: leaving it would have the styleDef
  // say the same thing twice, once under the name nothing refers to any more.
  expect(getDefinition(mpm, 'articulationDef', 'a')).toBeNull();
});

test('two articulation units are kept apart, and the larger one becomes the default', () => {
  // Five notes shortened to half, three lengthened to 1.4 — two units, two defs, and two
  // clusters that are further apart than `relativeDurationTolerance`. The larger becomes the
  // default; the smaller keeps an instruction each, now naming the def the cluster was given.
  const played = [360, 360, 360, 360, 360, 1008, 1008, 1008];
  const msm = new Alignment(
    PITCHES.map((pitch, i) => note(`n${i}`, i * 720, pitch, played[i])),
    { numerator: 4, denominator: 4 },
  );

  const mpm = atSixtyBpm();
  insert(msm, mpm, 'short', ['n0', 'n1', 'n2', 'n3', 'n4']);
  insert(msm, mpm, 'long', ['n5', 'n6', 'n7']);
  stylize(msm, mpm);

  const def = defaultDef(mpm);
  expect(def).not.toBeNull();
  expect(def!.getRelativeDuration()).toBeCloseTo(0.5, 6);

  const left = getInstructions(mpm, 'articulation', 'global');
  expect(left.map((a) => a.noteid).sort()).toEqual(['#n5', '#n6', '#n7']);

  // That each of these names *some* def is no longer worth an assertion: an `<articulation>`
  // without `@name.ref` is not an `AddArticulationOptions` at all, so `getInstructions` would
  // not have returned it. What still has to be checked is which def it names.
  const longName = left[0].nameRef;
  expect(longName).not.toBe(def!.getName());
  expect(new Set(left.map((a) => a.nameRef))).toEqual(new Set([longName]));

  const longDef = getDefinition(mpm, 'articulationDef', longName);
  expect(longDef!.getRelativeDuration()).toBeCloseTo(1.4, 6);

  // Both units were merged into definitions of this transformer's own, so neither of the
  // names they were inserted under is left behind.
  expect(getDefinition(mpm, 'articulationDef', 'short')).toBeNull();
  expect(getDefinition(mpm, 'articulationDef', 'long')).toBeNull();
});
