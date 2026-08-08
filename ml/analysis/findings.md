# Identifiability + MDL: findings

Team B. Reproduce everything with

```sh
cd ml/analysis && nice -n 15 python3 identifiability.py            # ~8 s, single core
cd ml/analysis && nice -n 15 python3 identifiability.py validate   # exactness proofs only
```

Raw numbers land in `analysis/out/results.json` (gitignored). The spec these measurements
justify is `../CANONICAL.md`.

**Aggregation convention.** Every ratio in this document is a **median of per-piece
ratios**, never a ratio of medians. (The first release mixed the two in §B; for the 10 ms
row the difference is 5.85 vs 5.88.) Greedy-staircase budgets: `max_instr = 48` in §A,
`max_instr = 80` in §B (rubato needs more breakpoints); both are named constants in
`identifiability.py`.

---

## 0. Exactness proofs (project standard of proof)

All must be <= 1e-9. They are, on every run:

```
V1 DL token counter vs dsl.encode_piece        : 1000 pieces, 0 mismatches, max |diff| = 0
V2 staircase design matrix vs meico rendering  : max |diff| = 0.000000000007 ms  (200 staircases x 40 notes)
V3 GT canonical MPM re-render vs meico         : max |diff| = 0.000000000007 ms  (100 pieces, 5047 notes)
V4 pure-Python rubato warp vs meico RubatoMap  : max |diff| = 0.000000000004 ms  (40 pieces, 2368 notes, 1 constant tempo instruction each)
V5 rubato o tempo COMPOSITION, pow-free subset : max |diff| = 0.000000000000 ms  (10 pieces, 546 notes, multi-segment constant tempo, meico's own date.perf)
V6 same, WITH power transitions                : max |diff| = 0.000000000007 ms  (40 pieces, 2485 notes, 30 straddling, 4 NaN onsets reproduced exactly)
V7 end-to-end (own warp + own composition)     : max |diff| = 0.000000000015 ms
```

- **V1** - `analysis/mdl.py`'s token counter is byte-exact with `python/dsl.py::encode_piece`,
  so the DL numbers below are the *actual* target-sequence lengths the model would emit.
- **V2** - the least-squares staircase fitter is built on the identity
  `ms(t) = sum_j s_j * clip(t - b_j, 0, b_{j+1} - b_j)` with `s = 15000/(bpm*0.25*720)`,
  which reproduces meico's constant-tempo rendering to 7e-12 ms. The competitor is fitted
  *exactly*, not approximately - a fair fight.
- **V3** - `data/val_v2.jsonl` ground-truth maps re-render to meico's own onsets.
- **V4** - the pure-Python rubato warp
  `t -> t - l + frame*((l/frame)^intensity*(earlyEnd-lateStart) + lateStart)`,
  `l = (t - start) mod frame`, matches meico's `RubatoMap.computeRubatoTransformation`
  over 40 pieces rendered by `analysis/RubatoProbe.java` mode `iso` (a real
  `Performance.perform()` run with a global `rubatoMap` + `tempoMap`).
- **V5/V6/V7** - *new; these did not exist in the first release and the code they test was
  wrong.* V4 only ever exercised pieces with **one constant** tempo instruction, so it
  proved `computeRubatoTransformation`, not the composition. `render_with_rubato` modelled
  the chain as `TempoTimeline.ms_at(warp(t))` - selecting the tempo segment by the
  **warped** tick. meico selects it by the **unwarped** map key
  (`TempoMap.java:396-404`) and evaluates the formula at the warped `date.perf`
  (`RubatoMap.java:368`). New probe mode `multi` puts tempo boundaries strictly inside
  rubato frames; on it the old model was off by up to **316 ms on 24/2485 notes** and got
  the NaN mask wrong on 4. The corrected `RubatoTempoRenderer` reproduces meico exactly,
  NaNs included. Experiment B's numbers are unaffected (its probe is single-constant-tempo)
  - what changed is that the helper is now safe to reuse on v3 data.
- **Floating point.** The floor is ~1.5e-11 ms, not 0: `java.lang.Math.pow` (fdlibm) and
  CPython's libm differ by 1 ULP on identical arguments (checked bit-for-bit:
  `0x1.c49f151d727fap-1` vs `0x1.c49f151d727f9p-1`). Feed meico's own `date.perf` in and
  take pow out of the tempo path (V5) and the agreement is **exactly** 0. Every
  "0.000000000 ms" in the first release was a `%.9f` rendering of a residual of this size;
  all prints now use `%.12f`.
- **Staleness guard.** `ensure_rubato_probe` used to short-circuit on file existence, so an
  edited `RubatoProbe.java` would have been validated against a stale JSONL. It now
  regenerates whenever the JSONL is older than the generator.

---

## A. Pareto: description length vs render fidelity

100 pieces of `data/val_v2.jsonl` (median 51.5 notes, 16-48 beats). "DL" = canonical-DSL
tokens for the **tempo map only**; `bits` = two-part MDL
(`DL*log2|V| + n*[log2(sigma/1 ms) + 0.5*log2(2*pi*e)]`). The GT row's `0.000` is the
7e-12 ms of V3, printed at 3 decimals.

| explanation | DL med | instr med | RMSE med (ms) | RMSE p90 | bits med | DL/DL_GT |
|---|---|---|---|---|---|---|
| **GT canonical** | **38** | **3** | **0.000** | **0.000** | **285** | **1.00** |
| constant tempo | 8 | 1 | 1184.5 | 2424.5 | 651 | 0.19 |
| staircase 8-beat | 37 | 4 | 131.2 | 335.2 | 632 | 0.97 |
| staircase 4-beat | 66 | 8 | 41.2 | 116.1 | 670 | 1.57 |
| staircase 2-beat | 106 | 12 | 7.2 | 29.3 | 699 | 2.49 |
| staircase 1-beat | 147 | 17 | 0.79 | 3.25 | 792 | 3.42 |

**Canonical MPM strictly dominates every staircase.**

- *Equal budget*: the 8-beat staircase costs the same 37-38 tokens and is **131 ms worse**.
- *Equal fidelity*: a greedy sub-beat staircase (boundaries chosen adaptively at sixteenth
  resolution, global LS refit at every step) needs **1.76x** the tokens to get within 10 ms
  and **3.55x** to get within 1 ms - and even then only 86/100 pieces reach 1 ms within a
  48-instruction budget.
- *Single scalar*: two-part MDL ranks them correctly with no threshold tuning - 285 bits for
  GT vs 632 for the best rival. The gap is 347 bits ~= 76 DSL tokens.

The reason is structural, not incidental: one power-function transition buys an entire
curved segment for ~13 tokens, while a staircase pays ~9 tokens per breakpoint and still
only ever produces a polyline.

### A2. The velocity field

Same question for dynamics. The rival is the *dense skyline* - one constant `<dynamics>`
per distinct rendered velocity, i.e. what a partitura-style per-note codec does.

| explanation | DL med | velocity RMSE |
|---|---|---|
| GT canonical dynamics curve | **40** | 0.000000000 (exact) |
| per-onset velocity skyline | 165 (**3.5x**) | 0.0177 med / 0.0320 max |
| constant velocity | 8 | 15.2 |

3.5x compression at effectively identical error. A Bezier segment is worth ~3.5 skyline
steps. The skyline's error is now **measured** rather than asserted: the first release
claimed "0.000000000 (exact by construction)", which is false - the skyline rounds each
velocity to canonical 1-decimal precision (G6) while meico writes the rendered velocity as
an un-quantised float (e.g. `32.111028088559394`). 0.018 velocity units is immaterial to
the MDL conclusion, but this document's standard of proof is exactness, so the number gets
reported. (The GT curve's 0 *is* genuine - it is the very map that was rendered.)

---

## B. Tempo-vs-rubato ambiguity

40 pieces rendered by meico (`RubatoProbe.java`) with a constant tempo plus **one canonical
rubato span** (`lateStart=0, earlyEnd=1, loop=true`, neutral terminator, frame in {1,2,4}
beats, intensity in [0.45,2.2] excluding [0.95,1.05], span >= 8 beats).

| explanation | DL med | render RMSE med (ms) | min over the 40 | pieces < 10 ms |
|---|---|---|---|---|
| **truth: constant tempo + 1 rubato span** | **21** (13 = the rubato span alone) | **5e-13** | - | 40/40 |
| constant tempo (optimal LS) | 8 | 53.0  <- RMS magnitude of the warp | 4.0 | 1/40 |
| staircase 8-beat | 38 | 37.8 | 2.7 | 3/40 |
| staircase 4-beat (finest *canonical-density* grid) | 66 | **34.0** | **2.6** | 4/40 |
| staircase 2-beat | 96 | 24.5 | 2.1 | 8/40 |
| staircase 1-beat (4x denser than canonical allows) | 145 | 8.4 | 1.7 | 26/40 |

Cost of buying fidelity with tempo instructions alone (greedy, sub-beat boundaries allowed):

| tolerance | reached | instructions med | DL med | DL / DL_true (median of ratios) |
|---|---|---|---|---|
| 50 ms | 40/40 | 2 | 20 | 0.91x |
| 20 ms | 40/40 | 9 | 99 | 4.76x |
| **10 ms** | 40/40 | **11** | **124** | **5.85x** |
| 5 ms | 40/40 | 14 | 148 | 7.07x |

> **Answer to the posed question**: reaching 10 ms of the true rubato explanation
> (13 tokens, ~0 ms) costs a median of **11 tempo instructions / 124 tokens - 5.85x the
> description length** - and requires sub-beat boundaries that canonical form forbids.

(The first release printed 5.9x here; that was a *ratio of medians*. Under the stated
median-of-ratios convention it is 5.85x. Immaterial, but the two must not be mixed.)

Breakdown by frame length (medians):

| frame | n | warp RMS (ms) | 4-beat staircase | optimal beat-aligned | absorbed |
|---|---|---|---|---|---|
| 1 beat | 14 | 40.0 | 28.1 | 17.4 | 55 % |
| 2 beats | 12 | 50.6 | 32.3 | 8.6 | 83 % |
| 4 beats | 14 | 108.8 | 67.6 | 5.7 | 94 % |

"absorbed" = the fraction of the warp an *optimal beat-aligned* tempo map removes. Two
caveats the first release got wrong or left out:

- **The 34.0 ms is a median, not a bound.** The first release wrote "the canonical-density
  rival (4-beat grid) never gets below 28 ms, so under the normal form the two maps are
  cleanly separated" (28.1 is in fact the median of the 1-beat-frame *subgroup*). The
  per-piece minimum of `rmse_4b` is **2.62 ms**; **12/40** pieces are under 28 ms and
  **4/40** under 10 ms. The four easiest all have intensity just outside the deadband
  (1.07, 1.15, 0.86, 0.84) - i.e. exactly the near-identity spans that §D shows the shipped
  deadband fails to exclude. For those pieces the tempo/rubato split is **not** cleanly
  separated. The MDL separation still holds on the median piece; the "always" did not.
- **The beat-aligned floor is a bracket, not a proof.** `beat_aligned_floor` optimises over
  beat-aligned *piecewise-constant* maps. Canonical tempo may bend within a segment, so the
  floor brackets what beat-grid tempo can see; it is not a universal lower bound over all
  beat-aligned tempo maps.

At `frameLength = 2880` (4 beats) a decoder allowed 1-beat tempo boundaries absorbs 94 % of
the warp - that frame length remains the riskiest choice in the Team A rubato rules.

---

## D. The rubato observability floor depends on frameLength

R3 excludes intensity in `[0.95, 1.05]` and claims this "guarantees every sampled rubato
span is detectable". It does not, because the warp amplitude in *milliseconds* scales with
the frame **duration** - a 1-beat frame at a fast tempo produces a third of the
displacement of a 4-beat frame at the same intensity. Exact synthetic measurement (4-frame
span, sixteenth grid, rendered with the V5-exact composition): onset-displacement RMS in ms
that survives the best single constant tempo.

| frame | i=0.86 | 0.95 | 1.05 | 1.07 | 1.25 | (at 100 bpm) |
|---|---|---|---|---|---|---|
| 1 beat | 15.9 | 5.4 | 5.1 | 7.1 | 23.2 | |
| 2 beats | 31.3 | 10.6 | 10.0 | 13.8 | 45.1 | |
| 4 beats | 62.4 | 21.1 | 20.0 | 27.6 | 90.0 | |

At 200 bpm every number halves. Bisecting for the 5 ms floor this study uses elsewhere
(§C, `CANONICAL.md` 4.T2):

| frameLength | deadband @100 bpm | @200 bpm | @240 bpm |
|---|---|---|---|
| 720 (1 beat) | [0.95, 1.05] | **[0.91, 1.10]** | **[0.89, 1.12]** |
| 1440 (2 beats) | [0.98, 1.02] | [0.95, 1.05] | [0.94, 1.06] |
| 2880 (4 beats) | [0.99, 1.01] | [0.98, 1.02] | [0.97, 1.03] |

So the shipped `[0.95, 1.05]` is conservative for `frameLength >= 1440` and **too narrow
for 720**. The 40-piece probe contains the proof: piece id 36 (1-beat frame, intensity
1.07, i.e. legally outside the deadband) has a total warp RMS of **4.03 ms** - below the
floor, while costing the full 13 tokens. That is precisely the unfalsifiable instruction R3
exists to prevent.

---

## C. Why "segments >= 4 beats" and the transition-depth deadband

Exact synthetic computation, `tau0 = 100 bpm`, notes on a sixteenth grid.

**C1 - shape identifiability.** ms RMSE between `meanTempoAt = 0.30` and `0.70` *after*
re-optimising the boundary tempi (so only the curve shape remains):

| L (beats) | x1.05 | x1.11 | x1.25 | x1.50 | x2.00 |
|---|---|---|---|---|---|
| 1 | 0.44 | 0.93 | 1.93 | 3.35 | 5.27 |
| 2 | 0.83 | 1.76 | 3.68 | 6.42 | 10.27 |
| **4** | 1.57 | **3.32** | 6.93 | 12.13 | 19.52 |
| 8 | 3.03 | 6.42 | 13.39 | 23.44 | 37.80 |
| 16 | 5.96 | 12.61 | 26.31 | 46.06 | 74.31 |

**C2 - depth identifiability.** ms RMSE between the transition and the best constant tempo:

| L (beats) | x1.05 | x1.11 | x1.25 | x1.50 | x2.00 |
|---|---|---|---|---|---|
| 1 | 1.57 | 3.25 | 6.41 | 10.26 | 14.26 |
| 2 | 3.02 | 6.24 | 12.34 | 19.79 | 27.53 |
| 4 | 5.88 | **12.15** | 24.04 | 38.61 | 53.76 |
| 8 | 11.59 | 23.93 | 47.39 | 76.20 | 106.19 |
| 16 | 22.99 | 47.48 | 94.08 | 151.35 | 211.07 |

The existing depth rule (`|log2 r| >= 0.15`, i.e. x1.11) is comfortably identifiable at
L >= 4 (12.2 ms, C2). The *shape* parameter is not: at the minimum length and minimum depth
`meanTempoAt` is worth only **3.3 ms** (C1) - below the noise a real performance carries, so
a substantial share of currently sampled tempo instructions carry a label the model cannot
possibly infer. That is a pure loss-floor contribution.

---

## Recommendations

### 1. Add `mdl_ratio` to the evaluation suite (highest value, ~10 lines)

`mdl_ratio = DL(pred) / DL(GT)`, computed with `analysis/mdl.py::mdl_ratio` on the
canonical-DSL token counts (already exact vs `dsl.encode_piece`). Report it next to
`render_rmse`, and report **`total_bits`** as the single leaderboard scalar.

Calibration from section A: a model that over-segments to a 1-beat staircase scores an
*excellent* 0.79 ms render RMSE - better than most realistic predictions - while being a
3.42x worse description. Render RMSE alone actively rewards that failure mode; `total_bits`
ranks it 792 vs GT's 285, correctly last. Suggested targets: `mdl_ratio` in [0.9, 1.2] with
`render_rmse < 10 ms`. The existing `n_pred`/`n_gt` instruction counts in `evaluate.py` are
a weak proxy - instruction count ignores that a transition costs ~3x a constant.

### 2. ~~Fix `evaluate.py::render_rmse` for v2 records~~ - WITHDRAWN, already fixed

The first release reported that `python/evaluate.py:42` raises `ValueError` on every v2
record. It does not (any more): the line reads
`for date, dur, pitch, ms_on, ms_off, *_ in rec["notes"]:` and both `render_rmse` and
`evaluate_piece_v2` run clean on `data/val_v2.jsonl`. Either a concurrent agent fixed it or
the original diagnosis was wrong; either way the recommendation is a no-op and the
corresponding claim in `analysis/mdl.py`'s docstring has been removed. `mdl.render_rmse`
stays as a local copy only so `analysis/` does not depend on the arity of the note tuple.

### 2b. NEW - make R8 (no tempo boundary inside a rubato frame) normative

The single highest-severity finding of this revision. meico composes rubato and tempo by
*key*, not by date (see §0, V5-V7): a straddling frame can render a note under a tempo
segment that does not contain its performance date, moving it by hundreds of ms, and can
produce **NaN milliseconds** where a power transition meets a backwards warp. The shipped
sampler avoids this in `pickFrameLength` (`java/SampleAndRender.java:272-289`) but
`CANONICAL.md` never stated it, so a second sampler written from the spec would emit data
whose tempo/rubato factorisation the renderer does not honour. Now `CANONICAL.md` R8 plus
canonicalisation step 11.

### 3. Sampler: tie transition depth to segment length (C1)

Currently a 4-beat x1.11 transition carries a `meanTempoAt` label worth 3.3 ms - unlearnable.
Require **either** depth >= 0.32 in |log2| (ratio >= 1.25) **or** segment length >= 8 beats
before sampling a transition; emit a constant otherwise. Expected effect: the residual loss
floor on the `M` token drops and boundary F1 stops being polluted by segments whose shape is
a coin flip. Cheap to verify: rerun C after the change and check every sampled (L, depth)
cell exceeds ~5 ms.

### 4. Sampler: pin the rubato rules that meico's defaults would otherwise break

Three of them are silent-failure risks, not preferences:
`loop="true"` (meico defaults to `false`, under which **only the first frame** is warped -
`RubatoData.java:29`); the neutral terminator (without it the warp runs to
`Double.MAX_VALUE` and leaks into every later note); and `lateStart=0, earlyEnd=1` (the only
setting where the warp has zero net *tick* displacement at the frame grid - and the only
setting where meico and mpmify's TS port agree, since the TS port clamps `lateStart` to
[0, 0.9] and `earlyEnd` to [0.1, 1]). Additionally: consider dropping `frameLength = 2880`
from the alphabet - section B shows a 4-beat frame is 94 % absorbable by a beat-aligned
tempo map, the weakest separation of the three.

**Open conflict, needs a decision.** The shipped sampler
(`java/SampleAndRender.java:333-339`) samples `lateStart in (0, 0.15]` /
`earlyEnd in [0.85, 1)` on **20 % of spans**, against R2. Those spans are not expressible
in the v3 DSL (§5 has no slot for the two attributes), so one label in five cannot be
written down by the target grammar. Either drop the branch from the sampler or extend the
grammar with `S`/`E` - `mdl.dl_rubato_span` now prices both. `CANONICAL.md` §4 flags this
inline.

### 4b. Widen the R3 intensity deadband for `frameLength = 720`

Section D: at 1-beat frames the shipped `[0.95, 1.05]` leaves spans whose entire warp is
under the 5 ms floor while still costing 13 tokens (probe piece 36: intensity 1.07,
4.03 ms). Use `[0.91, 1.10]` for `frameLength = 720` at the current bpm range, or
`[0.89, 1.12]` if v3 widens the tempo range to 240 bpm. Frames 1440/2880 need no change.

### 5. Report DL per map, and price articulation before scaling it up

Articulation dates are note onsets, hence sub-beat, hence expensive: ~13 tokens each at
15 % of ~40 onset dates is roughly **78 tokens/piece** - about the cost of the tempo *and*
dynamics maps combined (38 + 40). Once Team A's articulation lands, the target sequence
roughly doubles and articulation dominates both the loss and the DL. Two mitigations worth
measuring before committing: (a) delta-code articulation dates (`A +2 ...`); (b) use MPM's
own `styleDef`/`name.ref` mechanism - a small vocabulary of named articulations (`staccato`,
`tenuto`, ...) turns 13 tokens into 3-4, and is exactly what MPM is designed for. Track
`DL_tempo / DL_dyn / DL_rubato / DL_artic` separately in the eval so this stays visible.

---

## Scope and honesty notes

- **§A is a self-consistency result.** The 100 pieces were generated by the canonical
  sampler, so the generating hypothesis class necessarily dominates on its own samples.
  It shows the normal form is internally well-posed and the staircase rival is priced
  fairly; it does **not** show canonical MPM is the best description of a *human*
  performance. The test for that - the staircase oracle fit on Vienna 4x22 queued in
  `LOG.md:120-124` - has not been run. `CANONICAL.md` §0 carries the same caveat.
- **The rival's fitter has two numerical fallbacks** (non-positive slope -> global mean
  slope; bpm clamped to [10, 1000]). They weaken the rival, so they are now counted and
  printed rather than silent: on the §A workload they fire on **6** and **3** of **6036**
  fitted segments, 0 LinAlgErrors. Over a whole run (including every greedy candidate fit)
  the rate is 491/614 out of 944 038.
- **Onsets only.** The Python rubato/tempo composition models note onsets. meico resolves
  note *offsets* through a different rule (`pendingDurations`, keyed on the already-warped
  `date.end.perf`); nothing in v3 depends on it and this study does not claim it.
