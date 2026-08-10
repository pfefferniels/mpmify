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

**Sibling campaign: MLign (2026-08-09 ~14:00)**: a third program (~/Projects/MLign)
builds a learned score→performance aligner trained on synthetic espressivo renders —
the missing front-end of OUR real-data track. Coordination established: they get
provenance via facade PerformedNote.id (+ Java fork MIDI text events), our JSONL
schema, and the PDMX pipeline traps; proposed division: **they own the performer-
error/repeat/rolled-chord injection layer, we own the MPM map samplers, one shared
generator** (factor after v4 readiness passes). Their aligner output format will be
provenance-keyed compatible with our v5 ornament GT representation. Deal closed:
robustness layer = pure fn (notes, msm, rng, config) → edited notes + typed edit-log
(delete/insert/substitute/shift), edit-log doubles as alignment GT and as our
unmatched-note training signal; their outputs parangonar-compatible + our JSONL mirror.
Robustness layer v1 DELIVERED (~/Projects/MLign/src/robustness/, pure ESM, seeded
sfc32, typed edit-log, provenance-carrying inserts; 8/8 invariant tests pass on our
machine — invoke with the glob form on Node 23). ms-clock convention PINNED: editsToAlignment emits absolute facade ms (≥0 guaranteed);
adapter gt.mjs:shiftToMatchedZero converts to our first-matched-onset=0 clock (tested).
v5 integration recipe: editsToAlignment → shiftToMatchedZero → JSONL emit. Thread
closed until v5 (pedal/CC op spec owed to them then).

**Sibling campaign: MPM v3 ornamentation in meico-ts (2026-08-09 ~13:30)**: a new
user-directed autonomous program (worktree ../meico-ts-orn, branch ornamentation-v3)
implements spec-v3 discrete-note ornamentation — trills/turns/mordents become REAL
generated notes with provenance (ornament.generated/ref), facade gains expandOrnaments.
This removes the feasibility study's hard ceiling for v5. Implications journaled:
(a) v5 ornament ground truth is espressivo-only (upstream Java unimplemented; PR#31
defective — do not validate against it); (b) MPM has NO version marker — our exporter
must pick a generation per document; (c) generated notes break the 1:1 score↔perf
bijection — v5 input schema must carry performance-only notes with a generated flag
(same machinery real-data insertions need — two birds); (d) stakeholder asks sent
(provenance depth incl. role/index, determinism confirmation, W7/merge ETA).
**All granted (ruling D10)**: generated notes will carry ornament.generated/ref/
source/slot/pass — full ownership+role+repetition labels. Expansion is RNG-free
(bit-deterministic); generated xml:ids are random per run → v5 supervision keys on
provenance attrs + (part,date,pitch,slot), never generated ids. W7 facade ~1 day,
merge to main 1-2 days — ahead of our v5 slot. Sampler contract: their DESIGN.md +
research/github-v3-design.md §5/§6 (emit spec-strict, suffixed units).

**meico-ts program COMPLETE (2026-08-09 ~13:15)**: certified by adversarial final
audit, merged to main (d981c14). Everything v4 builds on is mainline: frozen facade,
movement fixes, accentuation fix + regenerated ground truth. **TD3 gate CLEARED** —
v4 dataset generation enables accentuation supervision (--with-accentuation on).
Their session shut down; triples question journaled on both sides for a future session.

**v3.1 epoch-11 inspection → v4 architecture decision (2026-08-09 ~11:30)**:
conditioning features fixed value mode-collapse (relDur now 0.40-0.87 stdev 0.146,
velChange -17..14 stdev 4.8) but articulation DATE accuracy is 18/196 (±1 beat) —
the decoder cannot transcribe which-note-spiked into digit coordinates (pointer-vs-
generation problem); rubato intensity still collapsed at 0.5, spans hallucinated on
11/30. This is the study's Design-A-vs-B crossover, empirically. **v4 model = hybrid
split**: note-anchored maps (articulation; later asynchrony/pedal state) via per-note
encoder heads (binary presence + attribute regression; dates exact by construction);
segment maps (tempo, dynamics, rubato, movement) via the DSL decoder. v3.1 runs its
remaining epochs as the end-to-end comparison point.

**espressivo green light + v4 wave launched (2026-08-09 ~10:15)**: Niels (via the
conductor, confirmed): espressivo is frozen and ready — build on it now; only gate:
accentuation supervision waits for their TD3 (which our meico 1d662105 accentuation
fix just unblocked). v4 build teams running alongside v3.1 training: Team D
(espressivo-based Node generator: v3 parity + movement/asynchrony/2-part scores +
domain randomization per the Vienna findings, dual-renderer 0-diff gate), Team E
(exact Python ports: movement Bezier→CC sampling, asynchrony, PerfChainV4), Team F
(CANONICAL.md v4: pedal/asynchrony normal form; pedal_fit.py on real Vienna CC
streams; vienna_ceiling.py — the representation-ceiling measurement answering how
much of the 2.9-9.0 s sim2real error any canonical tempo map could close).

## Results v3.1 (completed 2026-08-10, 24 epochs; conditioning features + 4.2M model)

Final 500-piece val: render 875 ms (base 1146, −24%),
velocity 13.7 (base 34.5, −60%), boundary F1 0.50,
**rubato F1 0.50** (vs 0.00 in v3 — the onset-residual feature worked once LR
decayed), articulation F1 0.00 (confirmed unlearnable via digit-coordinate
emission — the pointer problem), mdl_ratio 1.08, nonfinite 0. Survived TWO
session interruptions and one overnight machine sleep on checkpoint resume.
**This is the end-to-end (Design A) baseline the v4 hybrid must beat**, esp. on
articulation (per-note heads) and rubato span placement.

## Vienna sim2real re-probe + five-run table (2026-08-10 ~21:00)

**Vienna (v41 on 220 real windows, GT-free metrics)**: render median 1991 ms vs 404
baseline — still above baseline, but the gap HALVED on every piece vs v1
(op10/3 8990→5286; op38 3959→1908; Mozart 3565→1936; Schubert 2889→1088);
velocity 16.2 vs 34.4 base (model BEATS the real-data velocity baseline ~2x — first
real-data win); 0 parse errors, DL 262 — well-formed MPM on real playing.
Articulation head fires on ~195 notes/window (real playing is nowhere canonical-
neutral — expected; thresholding/eras for v1.0). **CATCH (mine): pedal_state is both
input feature f14 AND head target — the 0.3cc/1.17cc pedal MAEs are largely
self-copy; plumbing-valid, not an ML result. v1.0 design correction: drop f14 when
training the pedal head, or retarget the head to movement-curve parameters.**

**Five-run like-for-like table (cluster agent, eval_ckpt.py, identical baselines
verified)**: e96 render 502.5 / boundary 0.769 BEATS both heads runs (582.6/635.4,
0.667) while heads win velocity (5.30/5.63 vs 8.26) + artic 1.00 + (v41) asynchrony
7.25 vs 31.79 base. Honest framing adopted: heads trade some sequence-level accuracy
for per-note wins — NOT "heads improved everything"; single-seed. The n_features
guard correctly forced v41 onto its own pack (identical baselines prove matched
targets). Full-set asynchrony 7.25/31.79 is the day's most robust result.

**Truthful re-evals of the record (2026-08-10 ~20:30, eval_ckpt.py on val_v4.pt)**:
v4-h100 render 1585.0 (was published 9956.6 — void), e96 **502.5 / vel 8.26 /
boundary 0.769 / rubato 1.00** (the 24→96 gain was 3.2x, not the ~3% the broken
evaluator showed — the schedule conclusion was right for a reason we couldn't see;
correct-conclusion-from-corrupted-evidence is luck, not method), cpuref 6375
(labeled: epoch-4 fragment, record-completion only). Mixed-provenance caveat
accepted: both heads ckpts being re-scored on the same pack for a five-run table.
v41 ckpt pulled and byte-verified locally; **Vienna probe running**.

## v4 VERDICT (2026-08-10 ~19:45): the hybrid works — completely

Both 96-epoch runs, exit 0, ~22 min each, identical-condition pair, truthful evaluator:

| metric | v4-heads (15f) | v41-asyn (16f) | baseline |
|---|---|---|---|
| render RMSE | **697.4 ms** | 771.6 ms | 3018.8 |
| velocity RMSE | 6.61 | **6.28** | 34.90 |
| asynchrony err | 43.5 ms | **5.6 ms** | 33.6 |
| artic F1 (heads) | **1.00** (P 1.00 / R 1.00, 20/20) | 1.00 | — |
| relDur / velCh / pedal MAE | 0.017 / 0.95 / 0.3cc | 0.015 / 0.95 / 0.3cc | — |
| rubato F1 / boundary F1 | 1.00 / 0.67 | 1.00 / 0.67 | — |
| mdl_sub / mdl_full | 1.01 / 0.64 | 0.97 / 0.64 | — |

**Articulation: SOLVED by the per-note heads** (0.00 → 1.00; the pointer-problem
diagnosis and the hybrid split both vindicated). **Asynchrony: SOLVED by the
conditioning feature** (six times better than baseline; fourth confirmation of the
central law). Evaluator fix visible: render baseline 10486 → 3019 ms — every
pre-055f8ab render/velocity figure confirmed void. Caveats kept honest: the pair's
render difference (697 vs 772) is single-seed noise until replicated; boundary F1
0.67 keeps tempo segmentation as the remaining frontier; movementMap reconstruction
from pedal states is a deferred fitting pass. REMAINING within v4: those three.
NEXT: Vienna sim2real re-probe with the v41 model (domain randomization + heads vs
v1's 2.9-9.0 s failure) once re-evals land.

**v4 verdict runs LAUNCHED (2026-08-10 19:18)**: v4-heads-h100 (job 6247332) and
v41-asyn-h100 (6247333), both gates `heads=on w=1.0` passed, separate H100 nodes two
seconds apart — identical conditions for the one-variable pair. Cluster agent's
pre-submit verification: all four packs byte-matched to local sources, sync SHA
ancestor-checked (not name-trusted), eval_ckpt.py present. Heads cost: 4.28M vs 4.21M
params. Re-evals queued behind the runs; cpuref's will be labeled record-completion,
not a model result. First heads signal to watch: artic_f1 leaving 0.00 (late epochs).

**Heads phase 2 COMPLETE — the hybrid's per-note half is shippable (2026-08-10 ~19:30,
heads successor agent, 6b01399)**. The model/train/eval wiring the predecessor built
audited clean and was kept; two things were missing and one was wrong.

**Missing 1 — `eval_ckpt.py`, the deliverable that unblocks the re-evaluation.** A run's
`final_val.json` is written by whatever evaluator was in the tree when it ran, so the v4
mis-pairing froze wrong render/velocity numbers into three checkpoints that cannot be
retrained to refresh them. `eval_ckpt.py --ckpt --data --out` re-scores a saved checkpoint
over a whole val pack, **config-driven from the checkpoint's own `config`** (heads,
vocab_size, n_features) so re-evaluating cannot instantiate a different architecture than
was trained. Two mismatches ABORT rather than warn — feature width (a v3 ckpt on a v3.1
pack is 10-vs-13, which torch broadcasts into nonsense) and vocab size; both fire, tested.
The decode-and-score loop **moved out of `train.py` into it** and train.py imports it back:
a second copy is exactly how an offline evaluator drifts from the training one, and a
re-evaluation running different code would prove nothing about the run it corrects.

**Missing 2 — `mdl_ratio` split into `mdl_ratio_subset` and `mdl_ratio_full`; the old
ambiguous key is GONE.** The single key was full-vs-full, which on a phase-1 v4 model is
not a quality measure at all: the prediction has no movementMap (a median 408 of the GT's
~768 full tokens) and, pre-heads, no articulationMap, so it sat near a design constant —
e96 "settled on 0.24" while its four trained maps were converging. It moved when the
architecture changed and not when the model got better. Subset-vs-subset is the
over-/under-segmentation signal on the maps actually trained; full-vs-full is what an
exported MPM would cost. The 20-step smoke reads **mdl_sub 0.10 and mdl_full 2.81 on the
same prediction** (drops productions AND over-explains via a hallucinated articulationMap)
— one number could not have said both, which is the whole argument.

**Wrong — `--max-steps` did not actually suppress checkpointing.** It documented "no
checkpoint", and the mid-epoch break delivered that, but a budget that crosses an epoch
boundary saved one per completed epoch: the predecessor's 20-step smoke on a 5-batch pack
wrote three, under the run name it was given. Under a real run's name that is the silent
overwrite the flag exists to prevent. Guarded; the re-run leaves `log.txt` and nothing else.

**Also: `import train` starts a training run, and that has now happened twice** (this
session's was mine: it resumed complete-v1 at epoch 10/10 and rewrote its final_val.json;
ckpt untouched, both incidents noted in `runs/v1/log.txt`, authoritative v1 numbers are
the epoch-9 line and the table above). train.py now raises ImportError when imported —
nothing legitimately imports it now that the reusable half is `eval_ckpt.run_eval`.

Acceptance, all on the **preprocessed** path (where the mis-pairing lived):

| leg | result |
|---|---|
| `sanity_heads.py model` | MODEL_SANITY_PASS — split-vs-fused forward max abs diff **0.000e+00**, heads +8580 params |
| `sanity_heads.py labels 200` | LABEL_ALIGNMENT_PASS — 25062 note rows, max abs(packed − recomputed) **0.0**, pedal-feature-vs-label **0.0** |
| `sanity_heads.py assembly 50` | ASSEMBLY_SANITY_PASS — **GT floor exactly 0.0**; artic F1 1.0 by construction; assembled map identical to the GT articulationMap 50/50; off_rmse **0.0 vs 96.25** and vel_rmse **0.0 vs 5.41** against the no-articulation render, lower on 50/50 (render_rmse 0.0 both — articulation moves note-off and velocity, never onset) |
| Sanity A: 20-step heads smoke | all four components finite and the two that carry signal falling — token CE 3.644→3.288, head BCE 0.7223→0.6933, relDur 0.3980→0.2904; velCh ~0.85 and pedal ~0.223 flat at 20 steps (expected: both are masked/normalised terms that move on the epoch scale). Peak RSS **3.24 GB** under a loaded machine (two agents training), vs 1.63 GB measured quiet — memory still not the binder |
| Sanity: epoch-end eval through train.py | full v4+heads metric line renders incl. both MDL keys and the heads block; `final_val.json` written |
| Regression: v1 mode | 20 steps, loss 3.213→2.918, no checkpoint written |
| Regression: old checkpoints | v1/v2/v3/v3.1 all load and re-evaluate through `eval_ckpt.py`; a heads checkpoint round-trips the full head path (decode → assemble articulation → render) |

Loss-component scales at init, for anyone reading a future curve: BCE ~0.72 (ln 2 = the
right start for a 15 % positive rate), relDur ~0.40, velCh ~0.85, pedal ~0.223, token CE
~3.6. Held-out judgement: velCh and pedal being flat over 20 steps is not evidence against
the heads — 20 steps is 4 epochs of a 200-piece pack.

`vienna_adapter.py`'s uncommitted `total_ticks` work (swept into ff3754d) was **audited and
kept**: it is the real-data half of the pos_frac parity already journaled above, and its
emitted JSONL satisfies the invariant it claims — 88 records + 220 windows, 0 missing,
0 with `total_ticks < max(date+dur)`, median slack 1.00 beat on the full records.

**Heads phase 2 COMPLETE (2026-08-10 ~19:30, successor agent; main repaired at
6b01399, head 30c9454)**: eval_ckpt.py = the single evaluator for epoch-end AND
offline re-scoring (same code by construction); mdl split into subset/full; --max-steps
truly checkpoint-free; train.py refuses import (accident happened twice). All
acceptance green incl. GT-plumbing (assembled GT articulation strictly improves the
render; preprocessed-path GT floor exactly 0.0). KEY SEQUENCING INSIGHT (successor's):
mode v41 packs note_labels → a v41 run is AUTOMATICALLY a heads run — so the pair
(v4-heads-h100 on 15-feat, v41-asyn-h100 on 16-feat) differs by exactly the offset
feature; run both for one-variable attribution. Cluster still down → full package
made durable in ml/CLUSTER_QUEUE.md (sync 30c9454, two runs with heads=on log-line
gates, three re-evals). Program blocked ONLY on cluster revival.

**Staging error + cluster outage (2026-08-10 ~19:00)**: my e814960 blanket-staged
train.py and swept the heads successor's in-flight rework incl. an import of the
then-UNCOMMITTED eval_ckpt.py — main's train.py briefly import-broken; successor
directed to land its files immediately (fix = its commit). Simultaneously the cluster
agent's auth socket died (their predicted fragility; Niels away) — v41 submission
deferred, both hold-messages timed out. STANDING ACTION: when the cluster session
revives, FIRST send the corrected sync SHA, then the v41 run request stands unchanged.
Lesson (mine): never blanket-stage a shared file while a build agent is active in it —
stage by hunk or by explicitly-owned file list.

**Device gate PASSED and closed early; cpuref cancelled (2026-08-10 ~17:30, Niels +
cluster agent)**: matched-epoch parity h100-vs-cpuref at epochs 1/3 — render 1.6%,
vel 1.9-2.6% relative divergence (criterion: >5%), boundary_f1 identical. Adjudicated
at epoch 3; the remaining 20 cpuref epochs were 7h of a 96-core node buying nothing.
Design-length error co-owned (24-epoch twin specified where device-dispatch faults
show in hundreds of steps or never). **Methodology note, program-wide: port gates =
2-3 epoch curve comparisons (~1% of the compute, same assurance).** cpuref's log +
epoch-4 ckpt preserved for the record. Pending: re-evaluate all checkpoints through
eval_ckpt.py (fixed evaluator) when heads phase 2 ships.

**Evaluator mis-pairing found — v4 render/vel metrics invalidated (2026-08-10 ~17:00,
heads agent, fix 055f8ab)**: _v4_render flattened parts part-major and zipped against
date-sorted GT — every v4 render/velocity number so far compared part-1 renders to
part-2 targets (GT floor read 8064 ms; after fix: exactly 0.0 over 30 pieces). The
pilot gate missed it because the raw JSONL is part-major — only the preprocessed
training path was wrong. SURVIVES: F1s, mdl, asyn_err, cc metrics (map/stream-space) —
so schedule-was-binder and the asynchrony diagnosis stand. CORRECTED my own claim:
the ~10s absolute scales were mostly THIS, not the widened bpm domain. h100-vs-cpuref
stays valid as a device-parity gate (identical deterministic mis-measurement both
sides); all three checkpoints get re-evaluated with eval_ckpt.py (scope-added to the
heads agent). Lesson reinforced: GT-floor checks belong on EVERY data path, not one.

**e96 probe adjudicated mid-flight (2026-08-10 ~16:30)**: schedule WAS the binder —
rubato F1 0→1.00, boundary 0.71, n_pred==n_gt, mdl_ratio settled on the design
constant 0.24 (metric normalization fix routed to the heads agent: subset-vs-subset
for phase 1). Asynchrony is the one REAL defect and now has a clean signature: it
WANDERS (45.9→43.6→47.6 across 24/53/65 epochs) — fitting noise on a target whose
signal the part-scoped features hide by construction (B5's own tempo fix caused it).
Expected-result note for the record: e96's final asynchrony number will be worse than
baseline and that is not a failure of the run. FIX QUEUED (v4.1): conditioning feature
= windowed median of (part-2 onset − interpolated part-1 onset) — the v3.1 lesson,
third occurrence: every map learns exactly when its signal is an explicit input
feature. Sequencing: heads land first (current features), then ONE v4.1 rev bundles
heads + asynchrony feature + re-preprocess + a 96-epoch cluster run.

**First cluster results — v4-h100 (2026-08-10 ~15:45)**: 24 epochs in SIX MINUTES
(0.02-0.03 s/step, ~150x the M1). Numbers, read as phase-1-of-hybrid (DSL decoder only;
per-note heads not yet in the model): render 9957 vs base 10486 ms (v4's widened domain
inflates absolute scales — bpm 25-240 makes constant baselines catastrophic on slow
pieces); cc_rmse == baseline (expected: no pedal head yet); soft spots = asynchrony
worse than baseline (45.9 vs 33.6 ms) and rubato F1 0.00 (v3.1: 0.5), mdl_ratio 0.33
(dropped productions). Queued: 96-epoch probe (v4-h100-e96) to separate undertraining
from task hardness — 25 min on H100. Gate discipline held: H100 vs cpuref comparison
pending (~midnight). Cluster CPU note: 96-core EPYC ≈ only 2x the M1 for torch CPU
training — GPU migration was the right call, more cores was never the answer.
NEXT CRITICAL PATH: implement the per-note heads (articulation presence/values, pedal
state) in model.py + head-aware eval — the halves of the hybrid that make v4's maps
actually predictable. With 6-min cycles, head iteration is now interactive-speed.

**Training moves to bwUniCluster — local-training era ends (2026-08-10 ~15:30, Niels'
directive via the cluster agent: local trainings starve the machine)**: 17:35 local v4
auto-fire CANCELLED. New policy: trainings on the cluster; the Mac keeps rendering/
data-generation/validation only. The replication gate improved in the move (cluster
agent's design): v4-h100 (--device cuda) vs v4-cpuref (--device cpu --threads 32) on
the SAME filesystem/torch/data isolates the device variable, instead of confounding
BLAS+build+architecture as my Mac-vs-H100 gate would have. train.py gained --device
(4453193/ac7f0c2) and --threads (4dddcfd); CPU path semantics unchanged. Gate: median
final_val parity, >5% relative divergence on render/vel RMSE = investigate. MLign
informed (caps relax; cluster pointer shared).

**bwUniCluster 3.0 scoping (2026-08-10 ~14:30)**: Niels arranged HPC/GPU access; a
scoping agent collected our training factsheet. Migration is trivial (torch-only dep,
~20-line --device patch, 87 MB of packed tensors, battle-tested resume, no network).
Strategic split proposed: v4 trains locally tonight; the cluster's first job = v4
REPLICATION (migration correctness gate, metric parity expected, bit parity not —
different BLAS) then the model-scale sweep the study sized (30-80M params) that this
8 GB M1 forbids. Renderer-side bit-exactness proofs stay Mac-local; the cluster
inherits label correctness through the packed tensors.

**Expression-transform campaign merged (2026-08-10 ~09:30)**: meico-ts main@9974ba3
(3992 tests). exaggerateMpm/spotlightMpm: 15-dimension parameter-space MPM transforms
in correct scale spaces (log/logit/gain), deterministic, with R5a/R5b invariance
(symbolic note identity preserved = LABEL-SAFE augmentation) and per-dimension reports.
Queued for our program: (a) v5 data augmentation — systematic interpretation variation
over canonical samples (sampling ranges: expression/DESIGN.md §8; MLign's generator
wiring is the reference consumer); (b) evaluation probe — single-dimension exaggeration
of an EXTRACTED MpM + render diff isolates what each dimension of our model's output
actually controls.

**Ornamentation program MERGED (2026-08-09 ~22:45)**: meico-ts main@05147ed, 3064
tests green, our E1/E2 pair pushed to origin with it. Everything v5 needs is mainline:
discrete-note ornament rendering (trills/turns/mordents as real notes), provenance
sextet + ornament.carved, expandOrnaments opt-out, PARITY §6 semantic ledger,
DESIGN.md contract. **The feasibility study's hard ceiling on synthetic supervision is
lifted** — v5 can sample note-generating ornaments with exact ownership labels.

**Ornamentation W7 facade final (2026-08-09 ~18:30)**: PerformedNote gains
ornamented/ornamentRef/Source/Slot/Pass/Anchor (anchor = principal's score id — bonus
for principal-linkage supervision); expandOrnaments opt-out. Critical semantics for v5
labels: THREE ornamented shapes — generated notes (full field set), v2-altered
(fields null), and CARVED HEADS (at-end ornaments shorten their principal; ornamented
+ ref only). Carved heads become their own v5 label class — otherwise the articulation
head would learn ornament carving as staccato. Their W8-W10 remain before merge.

**espressivo E1/E2 FIXED and verified (2026-08-09 ~16:15)**: meico-ts main da24612
(fix c77f4aa), dist rebuilt (also freshening the dist-stale TD3). 2365 tests green
(13 new, 11 revert-sensitive + 2 controls); cross-renderer on a 40-piece all-maps
pilot: 3169 differing values → 37, all within the derived ULP envelope (max 3.64e-12
ms), velocities 2408→0; pow-free control bit-exact over 124,134 comparisons. PARITY
entry with a driven control (probe-blindness demonstrated, then defeated by injecting
inline modifiers/curvature into fixtures). Two doc-level amendments to the predecessor's
work, one disproven-by-test (inline RELATIVE modifiers compound with a def's;
absolute ones replace). espressivo is now a correct renderer for the full v4 map set —
the java path remains only a throughput choice (~5x). MLign green-lit for their v1
corpus; ornamentation campaign pinged for their rebase.

**MPS datapoint from MLign (2026-08-09 ~15:45)**: their custom blocks over
F.scaled_dot_product_attention train NORMALLY on MPS (3-epoch smoke green) — the
torch-2.11 MPS hang is specific to nn.Transformer's module machinery, not attention.
Implication: rewriting our model with custom SDPA blocks could unlock MPS (potentially
5-10x CPU on this M1) for the v4 training. Queued as an optional experiment behind the
step-8 smoke; CPU remains the safe default. Resource protocol with MLign locked:
they hold ~2GB niced during our runs, burst in our v31→v4 gap (ping owed at v31
TRAINING_COMPLETE), mutual caps during v4 training.

**v4 wave landed + integration dispatched (2026-08-09 ~18:30)**: 10 agents, 0 errors;
full reports + the 11-blocker readiness review preserved in ml/waves/v4/ (v3 wave in
ml/waves/v3/). Headlines: Team D's generator ports v3 bit-exactly (89,639 comparisons,
0 diff, exact java.util.Random port) and adds 2-part/asynchrony/movement/domain
randomization — and its dual-renderer gate found **espressivo E1/E2** (articulation
renders as identity; dynamics curvature/protraction never read — real on main; survived
certification via a styleDef/default-curvature fixture blind spot; TD3 was only
dist-stale). Decisions executed: B1 vocab freeze (V3=31, live v3.1 ckpt safe), B4 java
renderer default, B3 part-local articulationMaps (rule A6), **B2 split revised by
measurement**: v4 DSL training targets = tempo+dynamics+rubato+asynchrony (~183 tokens);
articulation AND movement move to per-note heads/labels (full-DSL 768-token targets =
9-10 GB activations, unaffordable; B3 makes date-keyed articulation labels wrong anyway).
**H3 reversal**: accentuation stays OUT of v4 — TD3 cleared the technical gate but no
identifiability band exists (aliases against articulation); my earlier enable call was
wrong. bugs.md #8/#9 filed. Dispatched: v4-integrator agent (steps 3/5/6/7/8),
espressivo-fixer agent (E1/E2 + regression tests + PARITY note, meico-ts main under
ecosystem delegation), vienna-adapter (part column). MLign warned (v0 corpus degraded
by E1, holding articulation sampling until fix ping); ornamentation campaign informed
(no collision; merge race protocol agreed).

**v3 final + v3.1 decision (2026-08-09 ~04:30)**: v3 completed 24 epochs. Final
500-piece val: render 1009 ms (base 1146, −12%), velocity 15.9 (base 34.5, −54%),
mdl_ratio 1.20 — but rubato/artic F1 flat 0.00 throughout. Root-cause analysis:
NOT (only) capacity — v1/v2 succeeded exactly on maps whose signal was exposed as a
direct input feature (local_log2_bpm, velocity); articulation/rubato had none.
**v3.1 = conditioning features + moderate capacity** (d192/4+4/ff768 ≈ 4.2M):
f10 log2 duration-ratio vs local tempo, f11 onset residual vs local linear fit,
f12 velocity spike vs local median. Feature validation on pilot (medians):
f10 0.247 at-artic vs 0.008 off (30×); f12 0.385 vs 0.000 (clean separation);
f11 0.042 in-rubato vs 0.0026 outside (16×). Pipeline chained behind v3 completion.

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

## v4 integration: pedal, asynchrony, part-local articulation (2026-08-09)

The wave-4 readiness review returned 6 blockers and 5 hazards (`waves/v4/summary.md`).
This is what integrating them changed. Steps were run against a regenerated 100-piece
pilot (`generate_v4.mjs ../data/pilot_v4.jsonl 100 4242 --renderer java`), and every
number below is measured on it.

**B1 vocab freeze.** `V3_VOCAB_SIZE = 31` is now a named constant and `VOCAB_SIZES` has an
explicit `"v4"` arm, so appending `G Z Y J` (31 → 35) cannot desync a live checkpoint.
Re-checked rather than assumed, after the append: `runs/v31/ckpt.pt` (epoch 14, the run
that was training at the time) and `runs/v3/ckpt.pt` (epoch 23) both still match the config
their own mode recomputes, at `vocab_size 31`.

**B2 architecture split — the DSL decoder does not carry the pedal.** Measured token cost
put the full §11 grammar at a median 731 tokens/piece (p90 1051, max 1205), against 183
for tempo+dynamics+rubato+asynchrony alone. movementMap is the reason: a median 408 tokens,
more than every other map combined. So the v4 **training target** is the four cheap maps,
and articulation + pedal become per-note label arrays (`dataset.piece_to_note_labels_v4`:
`artic_present`, `relative_duration`, `velocity_change`, `pedal_state`). The full six-map
grammar is still what `encode_piece_v4(maps, subset="full")` emits, and it is what the MDL
metric and any MPM export mean — the training target is a subset of the representation, not
a different one, and `roundtrip_v4.py` checks exactly that.

**B3 articulation was targeting the wrong notes → CANONICAL A6.** meico resolves a
`noteid`-less `<articulation>` with *at-or-after*, not *at*. With two independently sampled
rhythms only 5.8 % of onset dates are shared, so a global map drawn from the union
articulated a note its own label did not name in 80 % of cases. `articulationMap` is
**part-local** from this revision (one map per `<part>`, dates from that part's own
onsets); JSONL articulation rows gained a 4th element, the part number. On the regenerated
pilot the two targeting rules now coincide exactly — 1779 note-hits by at-or-after, 1779 by
plain (date, part) matching — which is what A6 was for. `perf_chain.py` keeps both rules
(`artic_targeting="exact"` for the v3 metrics, `"at-or-after"` for v4 and for **any**
predicted map, whose dates need not land on an onset at all).

**B4 renderer default.** `generate_v4.mjs` defaults to `--renderer java`. espressivo's two
parsing defects (E1 articulation modifiers, E2 dynamics curvature/protraction) are live, so
it mislabels velocity and note ends wherever those maps appear; a warning on stderr is not
a safe default for a backgrounded 20k run.

**B5 features.** `N_FEATURES_V4 = 15`: v3.1's 13, plus `part` and `pedal_state`, with every
neighbour- and window-based feature re-scoped to the note's **own part**. Without that,
`is_chord_tone` fires on cross-part coincidences and the millisecond IOI — hence
`local_log2_bpm`, the feature this program credits for the model working at all — is
measured across the part boundary, where it carries part 2's asynchrony offset instead of
the tempo. `pos_frac` now comes from `total_ticks`. Pedal state is read from a stable-sorted
last-wins step function (the stream has 36.6 % duplicate timestamps and can step backwards),
and for a later part it is read at `note_ms − asynchrony_offset`, because `sustain_cc` is
part 1's unshifted stream: that correction alone changes the state on 235 of 2095 part-2
notes, by up to 107 CC. 0 non-finite values over 11708 synthetic notes × 15, and over all
94578 Vienna notes (88 performances + 220 windows).

The Vienna side closed a sim2real skew in the same pass: `pos_frac` fell back to
`max(date+dur)` there because the adapter emitted no `total_ticks`, which is a *different
quantity* from the sampled piece length — the synthetic generator can end a piece with a
trailing rest (2/100 pilot records), and a real excerpt's last bar is often not filled
(3 of the 4 Vienna pieces). The adapter now emits the notated length, guarded as
`max(notated, max(date+dur))`; 132 of 308 records had differed, median `pos_frac` shift
0.010, max 0.033. Small, but systematic and in the one feature every note carries.

`python3 dataset.py --self-test` pins the pedal-state conventions. The case that earned it
is real and unreachable from synthetic data: Vienna stamps a performance's opening pedal
gesture at a single instant — 315 sustain events all at ms 0 on Chopin op10/3, ramping
3 → 127 — so only a stable sort with last-wins reads the state the excerpt actually starts
in. A sequential scan reads one of the 314 intermediate values, plausibly and silently.

**B6 evaluation.** `evaluate_piece_v4` renders through `PerfChainV4` and reports render and
velocity RMSE, CC RMSE, CC-64 threshold agreement, asynchrony offset error and `mdl_ratio`
(priced on the **full** grammar), with non-finite renders counted rather than averaged in.
Fed the ground-truth maps it returns exactly 0.0 on every error metric and exactly 1.0 on
`mdl_ratio` and `cc64_agree` — the floor the whole evaluation rests on, checked on 20
records.

**Length cap.** `preprocess.py --v4` raises on an overlong piece instead of skipping it: the
old silent `skipped += 1` would have dropped ~88 % of a v4 set behind a one-line count, and
the pieces that overflow are the long, densely-marked ones, so the survivors would have been
a biased sample as well as a small one. The cap is 448, set from 200 pieces across two
independent pilots (median 181, p90 265, p99 339, max 435) — 320 and 384 both reject a
percent or two of legitimate pieces.

### Gate results (100-piece A6 pilot, all under `nice -n 15` alongside the live v3.1 run)

| leg | result |
|---|---|
| `verify_v4.mjs invariants` | INVARIANTS_PASS |
| `verify_v4.mjs cross` (full map set) | CROSS_RENDERER_ULP_PASS — 11708 notes, 19635 CC, every JSONL field bit-exact including all 11708 velocities; 88 values differ, all inside the derived per-piece libm envelope |
| `validate_v4.py` | EXACT — 0/11708 ms_on, ms_off, velocity; 0/19635 cc_ms, cc_value |
| `validate_v4.py --cross-java` | EXACT — 24 parts, 1712 notes, 5958 CC, 2967 asynchrony-on-positionMap events covered |
| `roundtrip_v4.py` | ROUNDTRIP_EXACT — 100 records, 11708 notes, 19635 CC bit-exact, 0 decode errors |
| 20-step training smoke (BATCH=24) | peak RSS **1.63 GB**, median 7.32 s/step (min 3.01, max 23.23) at load average 15–18 |

The cross leg moved during the integration, and the sequence is worth recording. Run first
against the then-current meico-ts it was a guaranteed fail on any set containing
articulation or dynamics transitions — 100 pieces, 323892 comparisons, 7817 differing, every
one of them in `note.velocity` or `note.ms.end`, i.e. exactly E1 and E2 and nothing else. So
the gate ran on `pilot_v4_exact.jsonl` (`--maps tempo,rubato,asynchrony,movement`), which
passed, and `validate_v4.py --cross-java` covered the full-map set against the fork. The
espressivo team then landed the E1/E2 fix (main `da24612`), and re-running the same command
on the same 100-piece file turns those 7817 differences into 0: the full map set is now
`CROSS_RENDERER_ULP_PASS` with every JSONL field bit-exact. That the failure set was
*precisely* the two defects' blast radius, and that it vanished entirely on their fix, is
the cleanest evidence so far that the derived-envelope gate discriminates logic divergence
from libm noise rather than merely tolerating both.

The post-fix pass then **reproduced on a second, independently generated pilot**: seed 4001,
100 pieces, 11828 notes, 41044 position events, all eight `jsonl.*` field classes 0
differing, 128 values inside the envelope against 88 on seed 4242. Same verdict, different
data — so the full-map pass is a property of the fixed renderer rather than a lucky sample,
which matters because the earlier ULP gate defect (`waves/v4` I1) was exactly a seed-lucky
result quoted as a property.

**Both regression directions on the A6 change are closed, and they are different checks.**
`verify_v4.mjs v3proof` proves the part-local sampler did not disturb the v3-compat
*generator* (12978 comparisons, 0 differing, bit level); `validate_v3.py` proves the
`artic_targeting` split did not disturb the v3 *chain* (EXACT, 0/5129 onsets, offsets and
velocities). Either could have broken without the other noticing.

The smoke's step time is contention-dominated; min 3.01 s is the closer estimate of the
uncontended cost. At 20k pieces and BATCH=24 (834 batches/epoch) that projects to roughly
17 h for 24 epochs uncontended and ~40 h at the contended median. Read that as an **upper
bound**: the run ships at BATCH=48, i.e. 417 batches/epoch. No uncontended s/step exists yet
for either batch size, and none will until the v3.1 and v0-syn jobs are off the machine —
that single number is what step 9's sequencing actually needs, and neither of the two
independent sweeps could measure it.

**Hygiene.** `data/pilot_v4_espressivo.jsonl` — knowingly wrong velocities and note ends,
under a name any `pilot_v4*` glob picked up — moved to `data/defective/`.
`pilot_v4_exact.jsonl` was espressivo-rendered despite its name and is now regenerated
through the Java fork. JSONL records carry `renderer` and `seed`, so a file says what
produced it. The two new `MovementMap` fork defects are filed as `../bugs.md` #8 and #9.
`README.md` documents the v4 generator, the four verification legs and the training path.

### Batch size for the v4 run — measured, and it is not the constraint the plan expected

The wave plan's B2 projected 9–10 GB of activations at BATCH=64 and called the v4 shape
unaffordable on an 8 GB M1. That projection assumed the **full** §11 grammar as the target
(T≈768). With the training target cut to the four cheap maps it does not hold. Peak RSS
measured over 20 optimiser steps, always on the *worst* length bucket (211 notes, 313-token
targets — the shape that sets the peak, not the average one), same MODEL_CFG as `train.py`,
`torch.set_num_threads(4)`, `nice -n 15`, on a machine already running the v3.1 job and
MLign's v0-syn:

| BATCH | median s/step | min–max | peak RSS |
|---|---|---|---|
| 24 | 4.39 | 1.37–6.23 | 0.69 GB |
| 32 | 4.52 | 1.98–7.57 | 0.67 GB |
| 48 | 3.98 | 1.91–8.71 | 0.68 GB |

**Peak RSS is flat in the batch size** — 0.67–0.69 GB across a 2× range — so memory is not
what limits the v4 batch; the resident set is dominated by the interpreter, the 4.21M
parameters and the packed data, not by activations. Anything up to 64 fits the 2.5 GB bar
with an order of magnitude to spare.

The step times, on the other hand, are **not** usable for choosing: at load average 18–25
the 24-step and 48-step medians differ by less than the min–max spread of either, and B=48
measuring *faster* per step than B=24 while doing twice the work is a direct readout of the
noise. A separate run of the same harness through `train.py` itself, which also holds the
eval-side tensors, measured 1.63 GB and 7.32 s/step at BATCH=24 — the higher RSS is real
(eval data) and the higher step time is contention. Both are recorded; neither is a clean
throughput number, and a B=64 run was abandoned after 25 minutes at 17 % CPU because the
machine was saturated.

**Recommendation for step 9: BATCH=48.** It is the largest size measured to fit with
margin, it keeps 20k pieces at 417 batches/epoch (close to v3.1's 313, so the LR schedule
and epoch budget carry over), and the memory headroom means the choice can be revisited
upward without a new measurement. Re-measure s/step once the machine is quiet — the
projection to a 24-epoch wall-clock is worth having before committing to a multi-day run,
and no number taken under load average 20 can supply it.
