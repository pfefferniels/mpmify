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
notes, by up to 107 CC. 0 non-finite values over 11708 notes × 15, and over 12562 Vienna
notes.

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

The smoke's step time is contention-dominated; min 3.01 s is the closer estimate of the
uncontended cost. At 20k pieces and BATCH=24 (834 batches/epoch) that projects to roughly
17 h for 24 epochs uncontended and ~40 h at the contended median — worth deciding on before
step 9 rather than during it.

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
