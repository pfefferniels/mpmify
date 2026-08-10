# Generating MPM from score-aligned MIDI with a modern ML architecture — feasibility study

*Research synthesis, 2026-07-24. Produced by a 15-agent research workflow: five agents digested MPM/meico/mpmify (guidelines + ODD specs, meico rendering source, fork diff, mpmify code), four surveyed the ML literature/architecture/synthetic-data/alignment questions, two critics reviewed everything, and four gap-fill agents ran actual local experiments (numerics cross-validation, renderability audit, evaluation-metric prototype, data-ingestion pilot). Sources and artifacts are listed at the end.*

## Executive summary

**(a) Can a modern transformer generate/reconstruct MPM from a score-aligned MIDI performance? Yes — and it appears to be genuinely novel.** Targeted searches found no published work that trains a model to emit MPM or any comparable symbolic performance-description language. The closest precedents are 20+ years old and narrow (Zanon & De Poli 2003: optimization-fitting KTH rule parameters; Widmer's PLCG 2003: induced flat note-level rules). Modern neural performance research runs the *forward* direction (score → performance: VirtuosoNet, ScorePerformer, DExter, PianoFlow, Pianist Transformer) and treats performance markings only as *input* conditioning, never as generated output. The closest inverse-direction tool, partitura's performance codec, is a dense per-note parameterization with no segmentation, no curve models, no instruction vocabulary. MIDI2ScoreTransformer (Beyer & Dai, ISMIR 2024) proves the structurally hardest part — transformers emitting valid symbolic markup from performance MIDI — is tractable at ~30–40M parameters.

**(b) Can training data be generated purely synthetically (sample MPM → meico render → pair)? Yes for the core, with three sharp qualifications.** This setting is unusually favorable: unlike every sim2real precedent (OMR, synthetic-audio transcription), there is *no observation-domain gap* — both sides are symbolic, and meico defines MPM's semantics. Rendering was empirically verified as deterministic and cheap (~27 CPU-hours per 10⁶ pairs on one M1 core, embarrassingly parallel). The qualifications:

1. **Identifiability**: MPM is over-parameterized w.r.t. its rendering (tempo vs. rubato vs. asynchrony vs. imprecision can explain the same onsets; segmentation is non-unique). A **canonical normal form** for MPM must be defined, and synthetic MPMs must be *sampled in that normal form* — this is the single most consequential design decision.
2. **Renderable-subset ceiling**: meico can never render note-*generating* ornaments (trills/mordents/turns — `OrnamentData.java:101` TODO, unimplemented upstream too), detune/tuning, or performer errors. Synthetic pairs always have a perfect 1:1 note correspondence. The synthetic route covers exactly the timing/dynamics/articulation/pedal subset — which happens to coincide almost perfectly with mpmify's current transformer targets.
3. **Distribution gap**: a model trained on unconditioned random MPMs will invert meico beautifully but decompose *human* playing badly (human expression correlates with phrase structure; humans make errors). Fix: fit score-conditioned priors over MPM parameters by running mpmify on real aligned corpora (nASAP), sample from those, mix in mpmify-labeled real pairs, and evaluate by round-trip render distance.

**Bottom line**: the correct framing is *synthetic-first with real-data-fitted priors, real fine-tuning, and round-trip evaluation* — not "purely synthetic," but ~95% of training tokens can be synthetic, and the fully-synthetic track (PDMX scores, CC BY) is the only one producing releasable training data.

---

## 1. MPM, precisely

MPM (Music Performance Markup, Axel Berndt; current ODD edition 3.0.1, namespace `http://www.cemfi.de/mpm/ns/1.0`) describes a performance as "the entirety of all transformations necessary to make the music sound," strictly separated from the logical score (MSM/MEI). Conceptual ancestor: the KTH rule system (Director Musices) — symbolic, interpretable, score-anchored — but MPM replaces global rule weights with *dated, segment-wise instructions*, which is exactly what Zanon & De Poli (2003) found necessary when static KTH weights failed to fit real performances.

**Structure**: `mpm` → `metadata?` + `performance+` (@pulsesPerQuarter, recommended 360/720). Each performance: one `global` + 0..n `part`, each holding `header` (style collections) + `dated` (maps). **12 map types**: tempoMap, rubatoMap, asynchronyMap, dynamicsMap, metricalAccentuationMap, articulationMap, ornamentationMap, and 5 imprecision maps (generic/timing/dynamics/toneduration/tuning). A part-local map of a given type overrides the global map *entirely* — even an empty local map suppresses the global one.

**Anchoring**: every instruction carries `date` (double, symbolic ticks), lasts until the next same-type instruction; dates must ascend (Schematron-enforced). Continuous curves are per-segment monotonic. The rendering pipeline order is fixed: dynamics → (movement) → metrical accentuation → articulation (tick modifiers) → rubato → ornamentation (tick) → **tempo (ticks→ms)** → asynchrony → articulation (ms modifiers) → ornamentation (ms) → imprecision.

**Key semantics** (all verified against the meico source):

- **tempo**: `bpm`, `beatLength` (0.25 = quarter), `transition.to`, `meanTempoAt` ∈ [0,1] (default 0.5). Curve: T(x) = bpm + (transitionTo − bpm)·x^p with p = ln 0.5 / ln(meanTempoAt) — Berndt's power model (**"Musical Tempo Curves", ICMC 2011** — note: the project docs and memory cite "Berndt 2010"; the correct year is **2011**). ms timing integrates 1/T via Simpson's rule at 16th-note resolution.
- **rubato**: frame-local, exactly invertible tick warp — newDate = date − local + ((local/frameLength)^intensity·(earlyEnd−lateStart)+lateStart)·frameLength. Metronomically neutral per frame (Gatty 1912 definition).
- **dynamics**: unitless doubles (meico: MIDI velocity); transitions are cubic Béziers shaped by `curvature` [0,1] and `protraction` [−1,1]; `subNoteDynamics` renders as CC7 streams.
- **articulation**: the only discrete feature — 12 modifiers in symbolic and ms domains, `noteid` targeting, `defaultArticulation` via the map's style element.
- **asynchrony**: piecewise-constant ms offsets per part.
- **imprecision**: 6 distribution models (uniform, Gaussian, triangular, correlated Brownian, compensating triangle, deterministic list) with a `seed` attribute; `distribution.list` is explicitly documented as the residual-storage workflow of performance *analysis* — MPM's own docs anticipate exactly what mpmify does.
- **styles**: named styleDefs per domain; literal values ("Allegro", "p") resolve through the most recent `style` switch; inline attributes override referenced defs.

**Not official MPM**: the `movementMap` (continuous pedal curves: `movement` with position/transition.to/curvature/protraction/controller = sustain|soft) exists only in your meico fork + mpm-ts — Bézier machinery transplanted from dynamics, rendered to CC64/CC67. Any ML output vocabulary must decide explicitly: official 12-map MPM, or the fork dialect (mpm-ts currently also lacks imprecision types, and its `parseMPM` is lossy — drops accentuationPattern, rubato lateStart/earlyEnd, dynamics curvature).

---

## 2. meico as the forward simulator — empirically verified

A gap-fill agent built and ran meico locally (`ant compile`, OpenJDK 17, M1) and cross-validated it against mpmify. Findings:

**Numerics: bit-exact.** mpmify's TS kernels are line-by-line ports of the Java and agree to the last bit on all 510 sampled points across 16 configurations: tempo Simpson-rule ms integration (`tempoCalculations.ts`), dynamics Bézier (`dynamics/Approximation.ts`), rubato warp (`InsertRubato.ts::calculateRubatoOnDate`). Max divergence: exactly 0.0 ms / 0.0 velocity / 0.0 ticks. (Caveats: TS hardcodes ppq=720; re-verify pow/log bit-agreement on non-M1 training hardware.) TS-side label computation therefore needs no Java round-trip; meico remains the reference renderer for full pipelines.

**Determinism: yes, except one layer.** All non-imprecision maps render byte-identically across JVM runs. Seeded imprecision distributions are deterministic (`RandomNumberProvider.setSeed` works). The *only* nondeterminism is the **shake layer**: `Performance.perform` hardcodes `shakePolyphonicPart=true`, and `shakeOffsets`/`shakeTimingOffsets` use unseeded `new Random()` (`ImprecisionMap.java:821/:845`) whenever ≥2 events share an exact ms date (chords, contiguous legato notes). Observed run-to-run onset deltas up to 2.21 ms. **One-line fix**: `ImprecisionMap.java:754` — pass `false` instead of `shakePolyphonicPart` (all six call sites route through this wrapper); ~5 lines more to keep shake but seed it.

**Throughput: cheap, with one trap.** End-to-end (perform + expressive MIDI) is near-linear: ~97 ms for a mid-size piece (3,375 notes, full maps). **10⁵ pairs ≈ 2.7 CPU-h; 10⁶ ≈ 27 CPU-h** (single M1 core; ~5 h wall on 8 cores). The trap: **movementMap rendering is quadratic in piece length** (~136 s per mid-size piece with bar-wise sustain ramps; `getMovementSegment(0.1)` emits ~10³ CC events per ramp) — bound movement density, coarsen maxStepSize, or profile/fix the hotspot before large-scale generation.

**Semantics discoveries that constrain the sampler:**

- **A dangling final transition is inert**: a tempo/dynamics/movement instruction with `transition.to` but no subsequent instruction gets endDate = Double.MAX_VALUE and the curve *stays at the start value*. The synthetic sampler MUST close every transition, or labels and audio silently diverge (the fork's own `GenerateAllMapsReference` all_maps case has this bug — its "ritardando" renders as constant 120).
- **Upstream accentuation bug**: `AccentuationPatternDef.getAccentuationAt` has a dead condition (verified verbatim in upstream cemfi/meico master) — multi-anchor patterns always interpolate toward the pattern end, not the next anchor. Whatever semantics you pick, sampler and extractor must agree on *one*.
- **Fork movement bugs** (all found by the fork-diff agent): MovementData's XML constructor assigns the controller attribute to `xmlId` (wrong namespace lookup) so `controller` is never parsed — always sustain; `addMovement(MovementData)` never serializes controller; the rendering path never parses curvature/protraction from XML — **fitted curvature/protraction values currently have zero effect on rendered CC curves**. Also `GenerateAllMapsReference` sets position in 0–127 units while MovementData assumes 0–1 (×127), saturating the rendered pedal curve. All must be fixed before pedal supervision is generated.
- Detune (articulation `detuneCents`/`detuneHz`) and `imprecisionMap.tuning` are dead ends — they write MSM attributes no exporter consumes; drop them from the sampling space.

---

## 3. What mpmify already solves, and where ML actually helps

mpmify's pipeline is explain-and-subtract: each of ~20 transformers inserts MPM instructions and removes their effect from the MSM so later transformers see residuals. Well-solved *given human decisions*: power-function tempo fitting within given boundaries (alternating optimization, ~0.3–0.5 BPM), Bézier dynamics fitting, articulation ratios, arpeggio parameters, the provenance layer (CIDOC-CRM/CRMinf argumentations).

The brittle parts — and the precise value proposition for ML:

1. **Segmentation** — every from/to/date/frameLength is user-supplied; mpmify proposes no boundaries. This is the central unsolved decision.
2. **Joint attribution** — the greedy residual cascade (ornament → tempo → tick translation → rubato → articulation → asynchrony → imprecision) is order-dependent and non-identifiable; tempo will absorb rubato if frames aren't pre-declared; imprecision separation is an unimplemented stub.
3. **Ornament recognition** — arpeggios only; trills/appoggiaturas/extra notes unrepresentable (MsmNote can't hold unmatched notes; deletions unrepresentable because `midi.onset` is required).
4. **Stylization** — DBSCAN with hand-tuned epsilons decides which events share a def.
5. Dozens of magic constants (W_TIMING=5, λ=0.01, 35 ms arpeggio threshold, …) that encode priors which could be learned.

An important critic correction: two reports claimed "mpmify's pipeline is already a de facto canonicalizer." It is *not*, because segmentation is manual — the pipeline defines the attribution *hierarchy* but not an algorithmic normal form. Automating segmentation is precisely what makes the normal form well-defined, and it's the hardest open subproblem. (Also noted: `fitting.md` is stale vs. the code — it describes w_t=0.1, a 50000 shape penalty, 51-point grid; the code uses W_TIMING=5, clamping + turning-pair regularization, 21-point grid + SA.)

---

## 4. Literature: where this sits

**Forward (score → performance)**: KTH/Director Musices (rules, analysis-by-synthesis) → Basis Mixer (linear basis functions) → VirtuosoNet (ISMIR 2019; hierarchical RNN + CVAE, per-note tempo/velocity/timing/articulation/pedal) → ScorePerformer (ISMIR 2023; encoder-decoder transformer over SPMuple score-performance tuple tokens, multi-level style VAE) → DExter (2024; diffusion over partitura's 5-dim p_codec) → PianoFlow/SyMuPe (ACM MM 2025 Outstanding Paper; flow matching, ~2,968 h aligned data) → Pianist Transformer (Dec 2025; 135M params, 10B-token self-supervised pretraining, near-human subjective ratings). RenCon 2025 (9 entries): humans still rated highest — the forward task is active and unsolved.

**Inverse (performance → symbols)**: partitura performance codec (per-note beat_period, velocity, timing, articulation_log; fully invertible; no segmentation/curves — the dense skyline for any symbolic method); MIDI2ScoreTransformer (Beyer & Dai, ISMIR 2024: performance MIDI → MusicXML, RoFormer 4+4 layers, d_model 512, parallel per-attribute token streams, 512-note chunks / 64-note overlap — *the* architecture recipe to copy, though it discards expressiveness, the exact complement of MPM extraction); Kosta et al. 2016 (dynamic-marking classification; cross-piece generalization poor — a warning).

**Synthetic-supervision precedents**: Groove2Groove (TASLP 2020) — style transfer trained *entirely* on synthetic parallel MIDI (encouraging, though it evaluated largely in-domain); OMR on rendered scores (PrIMuS, DeepScores); SynthTab (ICASSP 2024) — synthetic-pretrain + real-finetune wins; Maman & Bermano (ICML 2022) — synthetic bootstrap + EM pseudo-labeling on real data; NMT backtranslation (Edunov 2018: *sampled/noisy* synthetic sources beat beam outputs → sample MPM priors broadly, domain-randomize).

**Novelty check**: explicit searches for "Music Performance Markup" + ML/neural, MPM Berndt neural, performance-rule learning, symbolic performance-language generation returned only Berndt's own non-ML tooling. Emitting MPM from a performance with a sequence model would be a first. (Caveat from the skeptic pass: contact Berndt's group / check ISMIR 2026 before claiming novelty in print.)

---

## 5. Proposed architecture

**Input encoding** (exploits the given alignment — don't make the model re-learn it): one sequence position per score note, summed sub-embeddings: score side (pitch, position-in-bar, bar index, beat strength, duration class, voice/part) + performance side as *deltas* (onset deviation in ms and in beats, log duration ratio, velocity, pedal state) — i.e. ScorePerformer's SPMuple recipe (geometric 121-bin tempo vocab, 161-bin onset-deviation, 8-second windowed local tempo, which they showed beats bar/beat/onset tempo encodings). Add a **beat-level stream** (windowed local BPM, mean velocity, pedal position per beat) since most MPM instructions live on the beat/segment grid.

**Output representation**: not raw XML. A compact line-based DSL (`T 1440 112.4→96.2 @0.61`) that deterministically compiles to MPM XML is ~4–6× shorter, trivially grammar-constrainable (llguidance/Outlines; PICARD-style), and losslessly invertible; xml:ids, corresp, defaults are compiler-generated. Continuous attributes: digit tokenization (exact, composable with grammar constraints) or coarse+fine bins for the autoregressive design; regression/MDN heads for the encoder-only design. Semantic constraints (monotonic dates, transition.to ⇒ closing instruction) via a small incremental validator as a logits processor.

**Three candidate designs**:

- **Design A — end-to-end**: encoder-decoder transformer (~40–80M params; MIDI2ScoreTransformer recipe: RoFormer, parallel attribute heads, chunked 1–2k notes with overlap, date-based stitching at instruction boundaries), emitting canonical MPM-DSL. Trained on canonicalized synthetic pairs; fine-tuned on mpmify-labeled real data. Directly answers question (a); needs the normal form; data-hungry.
- **Design B — hybrid (recommended primary)**: encoder-only transformer, same input, multi-task heads predicting (i) per-beat tempo/dynamics curves + per-note articulation/asynchrony/pedal targets (VirtuosoNet/DExter-style) and (ii) **segment-boundary probabilities and residual-attribution labels** — exactly the decisions mpmify currently outsources to the user; then mpmify's existing deterministic fitting produces the final numbers. Valid MPM by construction, least-squares-optimal parameters, sample-efficient, reuses the whole codebase, and the neural net learns only what heuristics do badly.
- **Design C — pretrained code-LLM fine-tune emitting raw XML**: fastest probe, 5–10× sequence blowup; baseline only.

Build B as primary and A as comparison (they share the input encoder). The A-vs-B crossover as synthetic data volume grows is itself the interesting empirical result for question (b). Scale realism: MT3 is T5-small (~60M), ScorePerformer single-digit M, MIDI2ScoreTransformer ~30–40M — 20–100M params is the right class; this is a laptop/single-GPU-scale project, not an LLM-scale one.

**A structural advantage unique to this domain**: meico is a fast, exact renderer, so `render(predict(x)) vs x` is available as (i) the primary evaluation metric, (ii) an n-best reranking criterion, and (iii) a reward for preference-style fine-tuning (meico is non-differentiable, so use reranking/RL or distill a differentiable surrogate).

---

## 6. Synthetic training data: the full verdict

**Why it works here**: no observation-domain gap (symbolic in, symbolic out; meico *defines* the semantics); labels exact by construction; unlimited volume at ~27 CPU-h per 10⁶ pairs; alignment is free (the fork's text-event commit embeds note xml:ids in rendered MIDI — note this is fork-only, so the fork must be frozen as the reference renderer); and synthetic pairs provide supervision real data never can (exact pedal ground truth in score time, exact curve parameters, ornament-note ownership).

**The sampler** (the design core):

1. **Sample in canonical normal form**: literal values (or one fixed style vocabulary); fixed attribution hierarchy (tempo = smooth global timing at bounded instruction density; rubato = only frame-periodic redistribution; asynchrony = only constant part offsets; imprecision = only residual distribution parameters); deterministic segmentation policy (instructions at beat/measure-boundary candidates); every transition closed (dangling-transition inertness!); minimum notes-per-imprecision-segment so variance parameters are statistically estimable.
2. **Score-conditioned priors from real data**: run mpmify's transformers over the nASAP robust subset (~832 performances) to fit joint distributions (ritardando depth/meanTempoAt at phrase ends, asynchrony ranges, articulation clusters, imprecision variances); sample from these priors *plus* broad domain randomization (Edunov's lesson: diverse beats typical).
3. **Robustness injection**: seeded imprecision maps; simulated alignment noise (note deletions/insertions applied post-render) so real-world unmatched notes aren't fully out-of-distribution.

**Hard ceiling (renderable subset)**: synthetic pairs can never contain note-generating ornaments (trills/mordents/turns — unimplemented in meico, upstream too), performer errors, or any pitch effect. Renderable and usable: tempo, rubato, asynchrony, dynamics (incl. sub-note CC7), metrical accentuation, articulation timing/duration/velocity, arpeggio temporalSpread+dynamicsGradient, timing/dynamics/toneduration imprecision, fork movementMap→CC64/67. That is precisely mpmify's current scope — so for *reproducing and surpassing mpmify*, synthetic coverage is complete. Extending to trills means either implementing spec-complete ornament note generation in the fork (closing `OrnamentData.java:101` — probably the cheapest route, since the MPM spec already defines the `<note>` pool / `|: :|` repetition syntax meico never parses) or heuristic labeling of insertion clusters in real data (Nakamura-style ornament models).

**Real data's role**: evaluation, prior-fitting, domain-adaptation fine-tuning — not bulk training. Public trustworthy note-aligned data ≈ 10³ performances / ~100 h / ~8M note pairs (nASAP robust 832 + Batik-plays-Mozart + Vienna 4×22); ATEPP adds ~10⁴ transcribed performances but with pedal-contaminated offsets (transcription can't separate key release from damper) — avoid for articulation supervision.

---

## 7. Data pipeline (piloted, works)

- **Scores**: PDMX (~250K public-domain MusicXML from MuseScore; Zenodo record is **CC BY 4.0**, not CC0; use the no_license_conflict subset, 87.7%). Pipeline **MusicXML → MEI (Verovio) → MSM (meico)** piloted on 11 scores: 11/11 converted, ~98–100% note-level accuracy. Traps found: the Verovio *CLI* silently truncates to page 1 — use the pip package (6.1.0) with `getMEI({scoreBased: True, pageNo: 0})`; a meico double-octave-shift bug (+12 semitones inside 8va spans — applies both `@oct.ges` and the `<octave>` span); a Verovio cross-octave accidental-carry defect; ±4-tick tuplet rounding (use tolerance joins). meico has **no** MusicXML import (the fork's `MusicXml2MsmMpmConverter` is a stub).
- **Real-data adapter**: a working PoC (`nasap_adapter.py`, see artifacts) joins nASAP `note_alignment.tsv` → mpmify `MsmNote[]`/`MsmPedal[]` with **0 join failures** (incl. repeat passes via `meico_repetition_k_` ids) — but only with the CPJKU/asap-dataset score copies (they carry the `n1…` note ids; the fosfrancesco copies don't). Two mpmify type gaps: deletions unrepresentable (make `midi.onset`/`midi.duration` optional), insertions have no slot; plus single-global-time-signature and hardcoded 2 parts.
- **Licensing**: MAESTRO/ASAP/nASAP are CC BY-NC-SA (research fine; derived releases stay NC). ATEPP's CC BY claim is dubious (performers' neighboring rights) — internal use only. meico's GPLv3 does **not** encumber rendered output (GPL FAQ: program output not covered). **The fully synthetic PDMX route is the only one producing releasable, restriction-free training data.**

---

## 8. Evaluation methodology (the field has none — define it)

No standard metric exists for symbolic instruction-level agreement; naive instruction matching is wrong because equivalent segmentations render identically. Proposed three-level suite:

- **(a) Render-space** (primary; the only level valid on real performances, which have no ground-truth MPM): render predicted MPM with meico, compare per note-id — onset MAE/RMSE (ms and beat-normalized), log duration-ratio MAE, velocity MAE + Pearson r, beat-level IOI-curve correlation, CC64 curve RMSE. Exclude/seed imprecision maps; score imprecision distributionally (residual moments/Wasserstein).
- **(b) Curve-space, segmentation-invariant**: compare maps as functions of ticks under meico's exact semantics (log2 quarter-normalized BPM; Bézier dynamics/movement in native units). A working prototype exists (`mpm_curve_metric.py`): equivalent re-segmentations and beatLength re-encodings score exactly 0; it also empirically caught the dangling-transition inertness.
- **(c) Instruction-space** (diagnostic only): Hungarian matching within a date tolerance, precision/recall/F1 + attribute MAE on matches, name.refs resolved through styleDefs.

**Baselines**: deadpan constant tempo/velocity floor; mpmify under three boundary regimes (oracle boundaries from GT MPM — synthetic only; automatic change-point detection on midpoint-corrected log-IOI, e.g. PELT/BIC; uniform 4-beat grid); partitura codec round-trip as the dense skyline; GT-MPM re-render as the noise floor. **Listening test** (real data): MUSHRA-style with hidden reference + deadpan anchor, ≥20 trained listeners, one synthesis chain, confidence weighting (RenCon 2025 practice); success = extracted-MPM render indistinguishable from the reference interpretation in 2AFC.

---

## 9. Recommended roadmap

1. **Fix the fork** (all small): shake determinism (1 line, `ImprecisionMap.java:754`); MovementData controller/curvature/protraction XML parsing + controller serialization; `GenerateAllMapsReference` movement unit bug; the meico 8va double-shift; decide the accentuation-interpolation semantics; optionally profile/fix the quadratic movement hotspot.
2. **Define the canonical normal form** (spec document + validator): attribution hierarchy, segmentation policy, closed transitions, literal-value policy, imprecision minimum-segment rule. Measure residual ill-posedness with the curve metric on a small canonicalization study.
3. **Build the sampler + generator**: PDMX→MEI→MSM corpus (pin Verovio pip); priors from mpmify-on-nASAP; batched meico rendering (100+ pieces/JVM); target 10⁵ pairs first (≈3 CPU-h).
4. **Train Design B** (hybrid: curves + boundaries + attribution heads → mpmify fitting); evaluate with the three-level suite against the baselines.
5. **Train Design A** (end-to-end DSL) on the same data; study the A/B crossover vs. synthetic volume — that comparison is the publishable core of question (b).
6. **Real-data track**: nASAP adapter hardening (optional physical attributes for deletions, insertion slots), fine-tune, listening test.
7. **Later**: implement ornament note generation in the fork to lift the trill ceiling; extend attribution (`modified`) coverage beyond asynchrony/articulation for per-note causal supervision.

## Experimental validation (live program — status 2026-08-08)

The plan above is now a running autonomous program (`ml/` in this repo; journal: `ml/LOG.md`). Empirical results so far:

- **The end-to-end concept works.** A 2.2M-param encoder-decoder (CPU-trained on an 8 GB M1!) learns to emit valid canonical MPM from purely synthetic meico-rendered pairs. v1 (tempo only): curve RMSE −53% vs. constant baseline, render-space RMSE −37%. v2 (joint tempo+dynamics, 24 epochs): −36% / −26% / velocity −19%, correct instruction counts on both maps. v3 (tempo+dynamics+articulation+rubato) is training now. Segmentation (boundary F1 ~0.5–0.6) is the frontier, exactly as §3 predicted.
- **Bit-exactness required porting fdlibm.** The "0.0 diff" cross-validation claims hid a 1-ulp gap: macOS libm vs. the JVM's fdlibm differ on ~10% of pow/log arguments. With a Python fdlibm port, the four-map rendering chain now reproduces meico to the last bit (0 ulp over 25k+ notes) — labels are *exactly* what the renderer produces.
- **MDL makes "natural decomposition" a theorem, not a preference.** With exact fitters: explaining one 13-token rubato span via staircase-tempo instructions costs 5.85× the description length; canonical MPM strictly dominates every staircase on the fidelity-vs-length Pareto front (`ml/CANONICAL.md`, `ml/analysis/`). The `mdl_ratio` metric (DL(pred)/DL(GT)) is part of the evaluation suite.
- **The sim2real gap is real and measured.** v1 on Vienna 4x22 (88 real performances ingested with exact pedal streams): render RMSE 2.9–9.0 s vs. ~0.4 s baseline — purely-synthetic training does not transfer yet, confirming §6's central caveat. Causes separated: domain gap (tempo range, texture density, 31 ms chord melody-lead) → v4 domain randomization; plus a representation-ceiling question (≥4-beat segments can't express beat-level fluctuation) → measurable with the staircase oracle.
- **The pedal path is unblocked.** The three fork movementMap bugs are fixed and committed (`meico 1b3711f0`), verified by XML round-trip test; the parallel meico-ts team mirrored them with byte-for-byte fixture verification — v4 pedal supervision has two independently validated renderers, and Vienna 4x22 supplies genuine continuous half-pedalling ground truth (312k CC64 events).
- **New meico findings filed**: NaN rendering when a rubato frame straddles a tempo transition (`bugs.md` #7); dangling transitions are inert; first-instruction 100 bpm quirk; pendingDurations asymmetries — all now canonical-form rules or sampler constraints.

## Program status — 2026-08-10

v3 lineage complete (v3.1 end-to-end baseline: render −24%, velocity −60%, rubato F1 0.5, articulation = the pointer problem). v4 hybrid built and GT-floor-proven (DSL decoder + per-note heads); training moved to bwUniCluster (24 epochs = 6 min on an H100, ~150×); device gate passed. Central empirical law thrice confirmed: a map learns exactly when its signal is an explicit input feature. Self-corrections: espressivo articulation-identity defect (ecosystem-wide fix), our evaluator part-mis-pairing (early v4 numbers voided + re-evaluated). Ornamentation merge lifted §6's hard ceiling for v5. Pending: two one-variable H100 runs (heads; asynchrony feature) — runbook in `ml/CLUSTER_QUEUE.md`. Full journal: `ml/LOG.md`.

## Corrections to project docs surfaced by the fact-check pass

- The tempo-curve paper is **Berndt, "Musical Tempo Curves", ICMC 2011** (not 2010) — fix in `fitting.md`, MEMORY.md, and any future citations. The paper introduces two curve families; which parameterization meico implements has never been checked against it.
- `fitting.md` no longer matches the fitter's actual weights/grids (see §3).
- `bugs.md` #6 (rubato coordinate mixing) remains open and would corrupt residualization.
- mpm-ts `parseMPM` is lossy (accentuationPattern, rubato lateStart/earlyEnd, dynamics curvature) — must be fixed before MPM round-tripping is used in training.

## Artifacts produced during this study

All under `/private/tmp/claude-501/-Users-nielspfeffer-Projects-mpmify/6a63bc22-2929-4ad2-81f9-fd90f7b0b835/scratchpad/`:

- `xval/` — Java/TS numerics cross-validation harness (`XValNumerics.java`, `compare.js`, `BenchPerform.java`, CSVs, byte-diff reference runs)
- `mpm_curve_metric.py` — segmentation-invariant curve-space metric prototype (validated on 5 cases)
- `ingest/` — `Mei2MsmCli.java` (MusicXML→MEI→MSM driver), `nasap_adapter.py` (nASAP→MsmNote PoC, 0 join failures), `stream_mxl.py` (PDMX sampling), converted MSMs
- `wf/` — the nine full agent reports + critiques (per-topic markdown)

Copy anything worth keeping into the repo (suggested: `tools/eval/` for the metric, `tools/ingest/` for the adapters) — the scratchpad is session-temporary.

## Key sources

MPM ODD/specs (github.com/axelberndt/MPM, edition 3.0.1) · meico fork source (local) · Berndt, ICMC 2011 · Berndt, "The Music Performance Markup Format and Ecosystem", ISMIR 2021 · ScorePerformer (ISMIR 2023) · MIDI2ScoreTransformer (ISMIR 2024, arXiv:2410.00210) · DExter (Appl. Sci. 2024, arXiv:2406.14850) · PianoFlow/SyMuPe (ACM MM 2025) · Pianist Transformer (arXiv:2512.02652) · partitura performance codec · nASAP (Peter et al., TISMIR 2023) · parangonar · Groove2Groove (TASLP 2020) · SynthTab (ICASSP 2024) · Maman & Bermano (ICML 2022) · Edunov et al. (EMNLP 2018) · PDMX (ICASSP 2025) · Zanon & De Poli (CMJ 27(1) & JNMR 32(3), 2003) · Widmer (AIJ 2003) · Cancino-Chacón et al. survey (Frontiers Digit. Humanit. 2018) · RenCon 2025 (arXiv:2605.02059).
