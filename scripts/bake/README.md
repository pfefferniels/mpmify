# The segment bake

Moved here from `mpm-desk/scripts/` on 2026-08-21, when mpm-desk dropped `mpm-ts` and `mpmify`
and went espressivo-only. This is the only place mpmify's transformer pipeline still runs.

**Runnable, not automated.** No npm script runs them, and the full inputs still live in the
mpm-desk repo (pass them with `--mei` / `--info`). `vite-node` resolves the `mpmify` imports
through the alias in `vite.config.ts`, so the bake runs against the working tree.

An excerpt of those inputs _is_ in this repo now — `test/fixtures/roundtrip`, four bars and the
84 calls that reconstruct them — and `test/roundtrip/bake.test.ts` runs this code over it on
every commit, asserting what `bakeSegments.ts` checks before it writes. The first thing it found
was that the bake did not run at all: `getRange` needs a residual to place a pedal, neither
`derive` nor the segment merge passed one, and every real `info.json` has `InsertPedal` calls in
it.

`test/roundtrip/aligned.test.ts` measures the same 84 calls, but reaches them through
`src/runChain.ts` and the frozen alignment, so it no longer runs anything in this directory.

## What it does

MEI + `info.json` ⇒ three files the viewer reads:

| Output            | What it is                                               |
| ----------------- | -------------------------------------------------------- |
| `score.msm`       | The MEI converted by espressivo — what a render performs |
| `performance.mpm` | The transformer pipeline's MPM                           |
| `segments.json`   | The intensity segments, each naming its MPM element ids  |

```sh
MPMDESK=../mpm-desk
node_modules/.bin/vite-node scripts/bake/bakeSegments.ts -- \
    --mei $MPMDESK/public/transcription.mei --info $MPMDESK/public/info.json    # dry run
node_modules/.bin/vite-node scripts/bake/bakeSegments.ts -- … --write
node_modules/.bin/vite-node scripts/bake/verifySegments.ts                      # re-derive and diff
```

## Files

| File                | Role                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------- |
| `bakeSegments.ts`   | CLI wrapper: sets up jsdom globals, runs `derive`, writes `public/`                    |
| `deriveSegments.ts` | The bake itself — `runPipeline` feeds the MEI to `runChain`, `derive` groups the calls |
| `verifySegments.ts` | Re-derives and diffs against what was written                                          |
| `asMSM.ts`          | Enriches a converted MSM with the performance data encoded in the MEI                  |
| `mergeSegments.ts`  | Folds segments covering the same ticks into one                                        |
| `writeAlignment.ts` | Cuts `test/fixtures/roundtrip/alignment.*` out of the MEI through `asMSM`              |
| `Reconstruction.ts` | Copy of mpm-desk's `src/model/Reconstruction.ts` — the output shape                    |
| `intensityCurve.ts` | Copy of mpm-desk's `src/utils/intensityCurve.ts` — `verifySegments` check 4 needs it   |

The last two are copies rather than imports so the set stands on its own. If mpm-desk's versions
change, these do not follow — and `knip.json` ignores them, since a copy carries exports its
copy of the code does not use.

## What is missing

- **The full inputs.** Both scripts default to `public/transcription.mei` and `data/info.json`
  relative to the cwd, and `verifySegments.ts` additionally reads
  `public/{score.msm,performance.mpm,segments.json}`. Those files live in the mpm-desk repo and
  were not copied (~650 kB). `bakeSegments.ts` takes `--mei` and `--info`; `verifySegments.ts`
  still hardcodes its paths. What is here is the four-bar excerpt, which the tests use directly
  through `derive` rather than through either script.
- **An npm script.** Nothing runs the two scripts automatically, and with the full inputs
  outside the repo they cannot be part of `npm test`.

## Why the bake exists at all

The pipeline fits its curves by simulated annealing (`Math.random` in `Approximation.ts` and
`ApproximateLogarithmicTempo.ts`), and `convertMeiToMsm` mints a fresh `meico_<uuid>` per
conversion. Re-running produces a different-but-equivalent MPM whose ids an older
`segments.json` no longer resolves — so the three outputs must always come from **one** run.
That is what baking is for, and why the viewer ships the result rather than deriving it.

Measured, and asserted by `verifySegments.ts`: only `accentuationPattern` grouping moves between
runs (`MergeMetricalAccentuations` folds two patterns together based on annealed velocity fits).
A difference in any other element type would be a regression, not annealing.

## What mpm-desk kept

mpm-desk still has a `scripts/verifySegments.ts`, slimmed to the two checks that need no
pipeline: every element id a segment names exists in `performance.mpm`, and espressivo's
`spotlightMpm` accepts every segment and every single-span selection. Those overlap with checks
2 and 3 of the copy here.
