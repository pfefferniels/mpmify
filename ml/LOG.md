# Experiment log: end-to-end aligned-MIDI → MPM

## Program roadmap (updated 2026-08-08, per Niels)

Goal: **full MPM power** — all maps and attributes, including the non-standard
movementMap (pedalling, required), represented efficiently and naturally
(operationalized as MDL: fewest DSL tokens for given render fidelity). Multi-day
autonomous program, multiple agent teams.

- **v1** tempo only (training now) — closes the loop
- **v2** + dynamics (data ready, autopilot queued)
- **v3** + articulation, rubato (build teams running: sampler+ports, identifiability/MDL
  study + CANONICAL.md, DSL→MPM-XML export bridge with meico render-back proof)
- **v4** + movementMap/pedal (requires fixing 3 fork bugs: controller/curvature/protraction
  parsing + serialization; and the quadratic getMovementSegment cost), asynchrony
  (2-part scores), metricalAccentuation
- **v5** + ornamentation (temporalSpread/dynamicsGradient), imprecision maps
  (seeded; targets are distribution *parameters*, statistically identifiable only)
- **v6** + styleDefs/style switches — styles are MDL compression (recurring
  articulation/tempo patterns become defs), unifying "full power" with "efficient"
- Full articulation attribute set (ms modifiers, noteid targeting, defaultArticulation)
  phased across v4–v6

**meico-ts**: a parallel agent team is porting meico to TypeScript (../meico-ts).
Coordination established 2026-08-08 with their conductor. Their status: rendering is
COMPLETE for all maps (incl. movement, ornamentation, imprecision), proven equivalent
to Java via fixture comparison, 2108 tests green, ~2s for 16 full-pipeline scores.
The three movement bugs are reproduced bug-for-bug BY DESIGN (parity guarantee).
Agreed fix path: (1) we fix the Java fork (after current build workflow finishes),
(2) they regenerate reference fixtures from it and mirror the fixes — NEEDS NIELS'
APPROVAL (fixture-immutability invariant), (3) their T13 facade (JSON batch API,
no file I/O, seed-exposed imprecision) becomes our data generator when it lands →
single-language pipeline, deterministic imprecision (impossible with Java's unseeded
shake layer without patching). Also pending Niels: adopting our 0.0-diff triples as
additional meico-ts fixtures.

Goal: an end-to-end prototype of the research plan in `../mpm-ml-research.md` —
sample canonical-form MPM, render with meico, train a transformer to emit MPM back
from the (score, performance) pair, evaluate in render space, iterate.

## Iteration 0 — tempo-only, closed loop (2026-07-24)

**Scope decision**: start with tempoMap only (constant + power-function transitions,
beatLength 0.25, ppq 720). Tempo is the hardest continuous map (nonlinear curve family,
segmentation ambiguity) and the one with the best-understood math (bit-exact TS/Java
cross-validation from the feasibility study). Everything else is additive once the loop closes.

**Canonical form v0** (implements the "normal form" the study called the most consequential
design decision):
- instruction at date 0 always; boundaries on beat multiples; segments ≥ 4 beats
- last instruction constant (meico renders dangling transitions as inert — verified)
- bpm 1 decimal, log-uniform [40, 200]; meanTempoAt 2 decimals, uniform [0.15, 0.85]
- transitions change tempo by ≥ ~11% (|log2 ratio| ≥ 0.15)
- adjacent equal constants merged; 60% tempo continuity at boundaries (prevEnd carried over)

**Data**: `java/SampleAndRender.java` (compiles against ../meico out/production, no fork edits).
Random scores: 32–96 quarters, durations {16th, 8th, quarter, half}, 8% rests, 15% chords
(2–4 notes). 30k train / 1k val / 1k test. Generation ~7 ms/piece single-threaded.

**Validation of the forward path**: `python/tempo_math.py` (port of the exact meico/mpmify
Simpson + power-curve math) reproduces meico's rendered onsets/offsets with **max diff
0.000000000 ms over 2,019 notes** (pilot set). So labels are exact and render-space eval
needs no Java in the loop.

**Model** (`python/model.py`): encoder-decoder transformer, d_model 256, 4+4 layers,
ff 1024, 7.45M params. Input: 9 continuous features per note (score onset/duration in
beats, perf onset/duration in s, score+perf IOI, windowless local log2 BPM from IOI,
chord flag, position fraction). Output: digit-level DSL
`T <date_beats> B <bpm> (C | R <to> M <mta>)`* — lossless round-trip verified on pilot.

**Eval** (`python/evaluate.py`): median over val pieces of
- curve RMSE (log2 BPM, 90-tick grid) vs GT map
- render RMSE (ms, re-rendered predicted map vs actual onsets, exact math)
- constant-tempo baseline for both; boundary F1 (±1 beat); instruction counts

**Training**: 15 epochs, batch 48, AdamW lr 3e-4 cosine, MPS. → results below.

### Results

v0 run aborted — see hardware findings below.

## Iteration 0.1 — hardware reality check (2026-07-24)

**Finding**: this machine is an 8 GB M1; the v0 recipe (30k pieces held as Python dicts
≈ >1 GB RSS, MPS training, 7.45M model, 384-note pieces) pushed it into swap-thrash:
plain MPS matmuls ran at ~100× slowdown, and nn.Transformer training on MPS *hangs
outright* in torch 2.11 even on an idle machine (reproduced with a minimal benchmark —
CPU-side primitives are fine, MPS never returns). MPS is unusable here regardless of load.

**CPU benchmark** (2.2M model, B=32, N=100, T=120): threads=1 → 2.93 s/step,
threads=4 → 2.34, threads=8 → 1.96 (but contends with everything else),
B=64/threads=4 → 1.74 s/step (8.1k tok/s), B=96 → collapse (12 s/step, memory cliff).

**Fixes adopted**:
- pieces shortened to 16–48 beats (avg 52 notes, 42 target tokens)
- JSONL → packed float32/int16 tensors (`preprocess.py`, 48 MB total, no dicts in RAM)
- model d160 / 3+3 / ff640 = 2.2M params; CPU threads=4, batch 64, length-bucketed
- eval decode batched (50 pieces at once) instead of per-piece sequential
- forward-path validation re-run on regenerated data: still 0.000000000 ms

**Run v1**: 20k pieces, 10 epochs, ~313 steps/epoch. Results below.

## meico fork: movement fixes landed (2026-08-08)

All three movementMap bugs fixed in ../meico (v4 pedal prerequisite): controller now
parsed from XML (was wrong-ns lookup), controller serialized by addMovement(MovementData),
curvature/protraction parsed at render time (were silently defaulted). Additive:
`MovementMap.movementSampleMaxStep` (default 0.1 = unchanged behavior) to tame the
quadratic CC-sampling cost. Bonus: GenerateAllMapsReference movement cases now use
normalized 0..1 positions (were 0..127, saturating). Verified by
`ml/java/MovementFixTest.java`: serialize→re-parse→render bit-identical to in-memory
render, controller preserved (soft→CC67 path), curvature/protraction demonstrably
effective. meico-ts conductor notified. Niels approved their fixture regeneration (directly in
their session, 2026-08-08 evening); T20b (mirror fixes + regenerate references + TS
MovementFixTest) runs first in their Phase 3 — when it lands, the TS renderer honors
controller/curvature/protraction and the v4 pedal-supervision path has two validated
renderers. **Governance (2026-08-08, Niels)**: the program is purely autonomous and long-running;
the orchestrating agent makes ALL calls (same for the meico-ts refactor). Consequences
executed immediately: movement fixes committed in the fork (**meico 1b3711f0**), ML
workspace committed in mpmify (**a1cbe39**), triples-adoption question handed to the
meico-ts conductor as their-invariant/their-call (patch file
ml/patches/meico-movement-fixes-on-450193e4.patch retained as provenance backup).
Outcome: provenance re-pointed to meico@1b3711f0 (independently verified by them);
triples **declined** — redundant proof mass against the same fork; revisit post-T13
as a facade test consuming our JSONL directly (no frozen XML fixtures). Sound call.
**T20b landed** (meico-ts commit 304e90a): TS mirrors the fixes exactly, fixtures
regenerated and independently verified byte-for-byte (56-case negative-control battery:
exactly the six fix-dependent cases flip). v4 pedal supervision now has two validated
renderers.

## Results v2 (completed 2026-08-08, 24 epochs; joint tempo+dynamics)

Final 500-piece val: **curve RMSE 0.251** (base 0.393, −36%), **render RMSE 779 ms**
(base 1050, −26%), **velocity RMSE 11.4** (base 14.1, −19%), boundary F1 0.50,
correct instruction counts on both maps. The joint two-map model beats all baselines.
Notes: needed 24 epochs (~2× v1) for the doubled target length; at epoch 12 velocity
was still at baseline — the "flat dynamics" suspicion was disproved by inspection
(structure right, values undertrained) and the extension fixed it. Failure profile
mirrors v1: segmentation (F1 ~0.5) and transition-parameter precision are the frontier.

## Build-team wave 1 + v3 integration (2026-08-08)

Three-team workflow (build → independent verify → fix → integration-readiness review;
10 agents, 0 failures). All three teams shipped after fix rounds:

**Team A (sampler v3 + exact ports)** — `SampleAndRender.java` emits articulation +
rubato; `rubato_math.py`/`perf_chain.py` reproduce the full four-map chain
**bit-identically** (0 ulp over 460 pieces / 25,151 notes). Headline discovery:
**the project's "0.000000000 ms" claims were a %.9f artifact** — macOS libm differs
from Java's fdlibm by 1 ulp on ~10% of pow/log arguments (2.26% of val_v2 values were
non-bit-identical). Fix: a Python port of fdlibm e_pow/e_log (`java_libm.py` import
surface), verified 0/200,000 mismatches vs Java. Deep meico semantics documented:
rubato/tempo pendingDurations asymmetries, tempo-segment-by-unwarped-key (NaN hazard →
new normative rule R8; filed in ../bugs.md), first-instruction 100 bpm quirk, dangling
looped rubato warps to piece end (terminator mandatory).

**Team B (identifiability + MDL)** — `CANONICAL.md` + `analysis/`. Proved with exact
fitters (staircase competitor reproduces meico to 7e-12 ms): **canonical MPM strictly
dominates staircase-tempo explanations** — equal token budget → staircase is 131 ms
worse; within-10 ms fidelity → staircase needs 1.76× tokens; and explaining ONE rubato
span (13 tokens) via tempo instructions costs **5.85× the description length**. This is
the quantitative core of the "efficient and natural representation" goal: MDL forces
the natural map decomposition. Their `mdl_ratio` metric (DL(pred)/DL(GT), healthy in
[0.9, 1.2]) is now in `evaluate_piece_v3`.

**Team C (MPM export bridge)** — `dsl_to_mpm.py` + `RenderMpm.java`: predicted maps →
real MPM XML → meico renders **byte-identically** for tempo+dynamics (v2 scope).
v3 XML round-trip (articulation/rubato vocabulary) deferred to the v4 wave; v3
exactness is proven Python-side (validate_v3, bit-exact).

**Integration (orchestrator)** — the readiness review flagged 5 blockers, all resolved:
B1 vocab freeze (V2_VOCAB_SIZE=24, per-version sizes, resume mismatch now ABORTS —
would otherwise have silently overwritten the live v2 ckpt); B2 6-field rubato schema
everywhere, pilot_rubato*/pilot_v3_cov* never ingested; B3 v3 eval routes through
PerfChain (GT floor verified true 0.0); B4 `_sanitize_rubato`/`_sanitize_artic` +
isfinite guards (NaN can't poison epoch metrics); B5 scoped as above. v3 DSL:
`U date F frameBeats I intensity X endDate` (paired-terminator convention) +
`A date L relDur W velChange`, round-trip 100/100; target budget raised to 448.
Sampler decisions: R3 deadband widened to [0.89,1.12] uniformly; frameLength anti-skew
(sample frame first: 85/12/4 → 67/21/12); T2 relaxed until v4 regeneration
(documented in CANONICAL.md changelog).

**T13 facade validated cross-renderer (2026-08-09 ~04:00)**: meico-ts@c432849 exposes
performMsmToData (JSON-in/JSON-out, seeded imprecision via RenderOptions). Smoke test on
the movement fixture: notes 0.0-diff vs Java fork; CC stream structurally identical
(19 points, controller=soft→CC67, movement fixes honored). **Decision: the v4 generator
migrates to meico-ts** — single language, deterministic imprecision, no JVM/file I/O.
Java fork remains the cross-check renderer. Conductor revisits triples at T23.

**v3 mid-run diagnosis (epoch 11/24, 2026-08-09 01:15)**: render at baseline parity,
velocity −47% vs baseline; rubato/artic F1 0.00 — inspection shows grammar +
marginal-statistics learned (emits both productions on 30/30 pieces, values
mode-collapsed at relDur≈0.57/velChange≈−13/intensity≈0.57, rubato hallucinated on
no-rubato pieces). Same shape as v2's dynamics at its midpoint. Decision: run to 24;
if F1s still flat → v3.1 with larger model (capacity suspect at 2.2M for 4 maps).

**v3 autopilot armed**: waits for v2 → generates 20k/1k/1k (all four maps) →
bit-level spot-validation gate → preprocess → 24-epoch training. v3 keeps the v2
score/tempo domain deliberately (one variable at a time); domain randomization from
the Vienna findings lands with the v4 regeneration.

## Sim2real probe v1 × Vienna 4x22 (2026-08-08)

Corpus ingested (88 performances / 43,472 matched notes / 220 model-sized windows;
`vienna_adapter.py`; two partitura traps handled: quarter-vs-beat in 6/8, pedal-extended
note-offs). v1 inference (`infer.py`, render-space only — real data has no GT MPM):

| piece | median render RMSE | note |
|---|---|---|
| Chopin op10/3 | 8990 ms | ~31 qBPM — BELOW the sampler's [40,200] range |
| Chopin op38 | 3959 ms | in-range |
| Mozart K331/i | 3565 ms | in-range |
| Schubert D783/15 | 2889 ms | in-range |
| constant baseline | ~404 ms overall | |

**Finding: purely-synthetic v1 does not transfer to real performances** — exactly the
study's predicted failure mode. Maps stay well-formed (0 parse errors, sane instruction
counts); the values are wrong. Two causes to separate:
1. **Domain gap** → fix via domain randomization in the v3 sampler: bpm range [25,240],
   finer rhythm grid (90/240/540-tick values), denser polyphony, chord-onset jitter
   (real melody lead is ~31 ms median), more tempo instructions per piece.
2. **Representation ceiling** → measure with Team B's staircase oracle fit on Vienna:
   the v1 canonical form (≥4-beat monotone segments) may be unable to express real
   beat-level tempo fluctuation regardless of model quality. If the oracle fit is also
   ~seconds, the canonical form needs rubato (v3), finer segments, and ultimately
   imprecision maps (v5) to explain human playing — mpmify's distribution.list
   workflow reaching the same conclusion from the other direction.
Pedal bonus: the corpus carries continuous half-pedalling CC64 (312,380 sustain +
25,011 soft events; 97.9% of values strictly between 1..126, all 128 values occur) —
real ground truth for v4 movementMap. Now embedded in both JSONL files as
sustain_cc/soft_cc [[ms,value],...] streams, hand-parsed from the raw match files
because **partitura silently drops duplicate (time,value) CC events** (1,232 lost
corpus-wide) and reorders same-timestamp events. Validated: stream counts and value
sequences exactly match the raw corpus; windows carry initial pedal state.
**v4 fitting caveats**: (a) same-timestamp events need last-wins state semantics;
(b) every performance opens with a degenerate tick-0 burst (up to ~315 events ramping
at zero elapsed time) — collapse it before curve fitting, no movementMap curve can
express infinite slope.

### Results v1 (completed 2026-08-08, 10 epochs; run interrupted by 2-week machine sleep and resumed cleanly)

Val (100-piece median, greedy decode), trajectory of the epoch-end evals:

| epoch | curve RMSE (log2 BPM) | render RMSE (ms) | boundary F1 | n_pred/n_gt |
|---|---|---|---|---|
| 1 | 0.508 (base 0.400) | 2561 (base 1099) | 0.40 | 3/3 |
| 3 | 0.420 | 1371 | 0.47 | 2/3 |
| 5 | 0.250 | 757 | 0.50 | 3/3 |
| 7 | 0.232 | 747 | 0.50 | 3/3 |
| 9 | **0.190 (−53% vs base)** | **694 (−37% vs base)** | 0.59 | 3/3 |

**Verdict: the end-to-end concept works.** A 2.2M-param model learns valid DSL, correct
instruction counts, boundary placement well above chance, and value regression via digit
tokens — all from purely synthetic meico-rendered data, CPU-only. Trajectory was still
improving at epoch 10 (loss 0.90); more epochs / more data / bigger model all still on
the table. exact-match stays 0.00 — full token-exact reproduction is the wrong target
anyway (equivalent decompositions exist); render/curve metrics are the honest ones.
Weakest link: boundary F1 0.59 — segmentation is, as predicted in the feasibility
study, the hard part. Ideas queued: boundary-aware loss weighting, coarse+fine date
tokens, more training.
