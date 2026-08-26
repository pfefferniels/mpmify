// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { getInstructions } from '../../src/mpm/index.js';
import { derive } from '../../scripts/bake/deriveSegments.js';

/**
 * The other half of the bake: the intensity segments the viewer reads.
 *
 * `test/roundtrip/aligned.ts` measures the chain, which is now `src/runChain.ts` and reaches
 * nothing here. This is the only thing that runs the bake, because until the fixture from #51
 * landed there was nothing in this repo to run it on — and it turned out not to run at all: `getRange`
 * needs a residual to place a pedal, since a pedal carries no symbolic date, and `derive` and
 * the segment merge both called it without one. Every real `info.json` has `InsertPedal` in
 * it, so `bakeSegments.ts` and `verifySegments.ts` threw on their own inputs.
 *
 * What is asserted here is what `bakeSegments.ts` checks before writing — the checks that,
 * being in a script nothing runs, had never once been evaluated.
 */

const fixture = (name: string) =>
  readFileSync(join(__dirname, '..', 'fixtures', 'roundtrip', name), 'utf-8');

let baked: ReturnType<typeof derive>;

beforeAll(() => {
  baked = derive(fixture('traeumerei.mei'), fixture('chain.json'));
}, 120_000);

describe('the bake', () => {
  test('turns the chain into segments', () => {
    // 84 calls in 20 file segments become 12 baked segments of 71 spans. The eight that
    // drop resolve to no range at all: their only calls are `MakeChoice`,
    // `StylizeOrnamentation` and `InsertMetadata`, none of which names a date, a range or a
    // note. `mergeOverlappingSegments` folds nothing here — all 20 cover distinct ticks.
    expect(baked.stats.transformers).toBe(84);
    expect(baked.stats.segments).toBe(20);
    // The substituted `InsertMetadata`: the file's segment names the call it replaced.
    expect(baked.stats.ungrouped).toBe(1);
    expect(baked.reconstruction.segments.length).toBe(12);
    expect(baked.reconstruction.segments.flatMap((segment) => segment.spans).length).toBe(71);
    expect(baked.reconstruction.title).toMatch(/Welte/);
  });

  test('gives every span a distinct id', () => {
    // bakeSegments.ts refuses to write when this fails: the viewer keys its lanes on it.
    const ids = baked.reconstruction.segments.flatMap((segment) => segment.spans.map((s) => s.id));
    expect(ids.length).toBe(new Set(ids).size);
  });

  test('names only elements the MPM actually holds', () => {
    const present = new Set(getInstructions(baked.pipeline.mpm).map((i) => i.id));
    const dangling = baked.reconstruction.segments
      .flatMap((segment) => segment.spans.flatMap((span) => span.elements))
      .filter((id) => !present.has(id));
    expect(dangling).toEqual([]);
  });

  test('places every span inside its segment', () => {
    for (const segment of baked.reconstruction.segments) {
      for (const span of segment.spans) {
        expect(span.from, `${span.id} starts before segment ${segment.id}`).toBeGreaterThanOrEqual(
          segment.from,
        );
        expect(span.to, `${span.id} ends after segment ${segment.id}`).toBeLessThanOrEqual(
          segment.to,
        );
      }
    }
  });
});
