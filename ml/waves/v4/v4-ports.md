# v4-ports — built

## report
## Team E — exact Python ports for v4 eval (movement + asynchrony). DONE, bit-exact.

`PerfChainV4` reproduces the Java fork's full v4 chain with **0 differing bits** on Team D's Java-rendered pilot (7,082 notes × {ms_on, ms_off, velocity} + 3,769 CC points × {ms, value}). v4 evaluation needs no renderer round-trip.

### Files (all new)
- `ml/python/movement_math.py` — `MovementData` / `MovementTimeline`. Port of `MovementData.java` + `MovementMap.java` (post-1b3711f0). Bézier S-curve shares `inner_control_points` with `dynamics_math` (no duplication); `get_movement_segment(maxStep)` does the adaptive value-resolution subdivision in the **normalized 0..1** domain, ×127 last. Row: `[date, position|None, transitionTo|None, curvature|None, protraction|None, controller|None]` (`None` = attribute absent).
- `ml/python/asynchrony_math.py` — `AsynchronyTimeline.render(entries)` mutating in place, plus `java_max` (Java `Math.max` NaN/signed-zero semantics; Python's builtin diverges).
- `ml/python/perf_chain_v4.py` — `PerfChainV4`: per-part rendering with meico's local-else-global map resolution, notes as `NoteV4` carrying `.part`, `PartPerf.positions`/`.volumes` (flat map order) and `.cc` (espressivo's grouped `ControlChangeStream` shape, `ms_value_points()` → `[(ms, value)]`).
- `ml/python/validate_v4.py` — pilot mode / java mode / `--negative` / `--espressivo`. Bit-pattern comparison throughout (never `==`, never `%.9f`).

### Semantics mirrored (verified in BOTH the Java fork and espressivo source, then empirically)
Order per part, verbatim from `Performance.java:505-555`: dynamics → **movement→positionMap** → articulation → rubato → tempo(score) → tempo+asynchrony(channelVolumeMap) → tempo+asynchrony(positionMap) → asynchrony(score). The two controller maps deliberately bypass rubato; each `renderAsynchronyToMap` call gets its own working list.

**Movement quirks Q1–Q6** (all under negative-control test): Q1 the last `<movement>` is never rendered; Q2 `getPreviousPosition` loops `j > 0`, so index 0 is never examined (a position-less second movement inherits **0**, not the first one's `transition.to` — confirmed against the fork); Q3 exact start unshifted / end appended → **first and last point of every segment are duplicated**; Q4 constant movement = 3 identical points, no appended end; Q5 curvature is *not* clamped by MovementMap (unlike DynamicsMap), so x(t) can be non-monotone and `GenericMap.insertElement` reorders — mirrored, not assumed; Q6 defaults come from the `MovementData` **field initialisers** (curvature **0.4**, protraction 0, controller "sustain").

**Asynchrony A1–A4**: membership decided in the **tick** domain from the raw `duration` attribute (never `date.end.perf`/`duration.perf`), so a note can carry segment *k*'s offset on its onset and *k+1*'s on its end; `startDateMs` is a per-(instruction,entry) local, so the revisit path floors the end at **1 ms**, not at the note's own start+1; duration-less entries (position/volume) are finished after one pass.

**channelVolumeMap**: `DynamicsMap.renderDynamicsToMap` emits one mandatory `value="100.0"` reset at the first dynamics date even with no sub-note dynamics — it is a real CC point and is produced (`subNoteDynamics` is refused explicitly as out of canonical form).

### THREE FINDINGS FOR THE ORCHESTRATOR

**1. meico articulation targeting is at-or-AFTER, not exact-date (new normative issue, rule proposal "A6").** `ArticulationMap.renderArticulationToMap_noMillisecondModifiers` resolves a `noteid`-less `<articulation>` via `GenericMap.getAllElementsAt(date)` = `getElementIndexAtAfter(date)` and then **adds that element unconditionally**, key-checking only its successors. So an articulation whose date has no note **is not skipped — it articulates the next note**, and if that is a chord, **only its first note**. v3 could never reach this (articulation dates were drawn from the single part's own onsets); v4 makes it routine because dates come from the **union of both parts' onsets** while the map is global. Measured on `pilot_v4.jsonl` (60 pieces): **742 off-date landings, 278 stacked articulations, 21 articulations dropped past the last note**. `perf_chain.py` matches by exact date (correct for v3, wrong for v4) — fixed in my file via a `_ScoreChain(PerfChain)` subclass overriding `_apply_articulation` (targets are note *indices*, which a date-keyed map cannot express). Before this fix 543 velocities / 549 offsets mismatched; after, 0. **Implication**: the v4 DSL says "articulation at date d" but the renderer applies it elsewhere → the supervision target is systematically misattributed. CANONICAL.md needs either "articulation dates must be onsets **in every part the map applies to**" or "articulationMap must be part-local".

**2. espressivo ignores LITERAL articulation attributes** (meico-ts@a09f82c). `ArticulationMap.getArticulationDataOf` builds `new ArticulationData()` and fills only xml/date/xmlId/noteid/style/name.ref — it never parses the 13 numeric modifiers the fork parses inline (`ArticulationData`'s own XML ctor *does* parse them; the map never calls it). Literal `relativeDuration`/`absoluteVelocityChange` is a **silent no-op**; the `name.ref`→styleDef spelling renders identically in both. Minimal repro: 3 notes @100bpm, volume 60, `<articulation date="0" relativeDuration="0.5" absoluteVelocityChange="12"/>` → fork vel 72.0 / duration.perf 360.0 (ms end 300); espressivo vel 60 / ms end 600. Same articulation as a styleDef → 72 / 300 in **both**.

**3. espressivo ignores dynamics `curvature`/`protraction`.** `DynamicsMap.getDynamicsDataOf` parses volume/transition.to/subNoteDynamics but not curvature/protraction → they stay null → defaulted to 0 → every continuous dynamics transition uses x1=0, x2=1 regardless of the XML. The fork also **clamps** them (`ensureCurvatureBoundaries`/`ensureProtractionBoundaries`), which a fix must include. Repro: `<dynamics date="1440" volume="60" transition.to="100" curvature="0.3" protraction="-0.4"/>`, note at tick 2160 → fork **88.53760540485382**, espressivo **80** (the t=0.5 identity-curve value).

Both are the *same bug class* as the three movementMap parsing bugs the fork fixed on 2026-08-08. **Impact**: CANONICAL.md G5 pins the canonical form to literal values (no styleDef indirection) and the sampler draws curvature ∈ [0,0.9], protraction ∈ [−0.7,0.7] — so espressivo mis-renders **v2, v3 and v4** data. This blocks LOG.md's "the v4 generator migrates to meico-ts" decision. Independently corroborated: Team D's `generate_v4.mjs` documents an `ESPRESSIVO_DEFECTS` block and defaults to `--renderer java`; my `pilot_v4_espressivo.jsonl` run shows 3,989/7,082 velocities and 1,606/7,082 offsets diverging. The T13 smoke test missed it because the movement fixture has neither literal articulation nor a curved dynamics transition.

### Renderer attribution of the residual ulp
`pilot_v4_exact.jsonl` differs from this port on 7 notes + 3 CC points, all at **exactly 1 ulp**. I re-rendered the 6 affected records through the Java fork with `ml/java/RenderMpm`: **Python == Java fork bit-for-bit in all 14 values; the JSONL is the odd one out** — i.e. that file is espressivo-rendered and the residue is the known JS-`Math.pow` vs fdlibm divergence, not a port defect. `validate_v4.py` prints this attribution (and how to reproduce it) instead of a bare MISMATCH.

### Proof discipline
- **9 negative controls** monkey-patch a plausible *alternative* reading of each quirk (Q1/Q2/Q3/Q6, the 16129 maxStep-domain bug, A2, tick-vs-perf-end membership, and both A6 variants). Every one flips the battery to MISMATCH — a control that stayed EXACT would be a hole in the case battery, not a success.
- All meico order-dependent counters are driven off zero by the battery: `rubato_pending_blocked=3`, `tempo_pending_revisited=2`, `stacked_articulations`, `artic_offdate`, `artic_unmatched`, `asyn_score_carried`, both asynchrony clamps.
- fdlibm discipline: movement and asynchrony need **no** transcendental (polynomial Bézier + bisection + ±×÷); the tempo path reaches Java's `pow`/`log` through `perf_chain`/`java_libm`. `grep` confirms no `math.pow`/`math.log`/`**` in the new files.
- java mode writes to a temp dir and deletes it — **no dataset is generated**. **Accentuation gate respected**: no accentuation code, sampling or data anywhere.

### API
```python
PerfChainV4(parts=[{"number":1,"notes":[(date,dur),...], "movement":[...], "asynchrony":[...]}],
            global_maps={"tempo":..., "dynamics":..., "articulation":..., "rubato":..., "movement":...},
            movement_sample_max_step=0.1).render()   # -> [PartPerf]
```
Map resolution is meico's: key **absent** → global; key **present** (incl. `None` = null map, `[]` = empty map that shadows the global) → local. `PartPerf.notes` (NoteV4 with `.part`), `.positions`/`.volumes` (flat map order = MSM ground truth), `.cc` (grouped streams, `cc_number` 64/67/7/0), `.stats`.

## files_changed
[
 "/Users/nielspfeffer/Projects/mpmify/ml/python/movement_math.py",
 "/Users/nielspfeffer/Projects/mpmify/ml/python/asynchrony_math.py",
 "/Users/nielspfeffer/Projects/mpmify/ml/python/perf_chain_v4.py",
 "/Users/nielspfeffer/Projects/mpmify/ml/python/validate_v4.py"
]

## validation_output
$ python3 validate_v4.py ../data/pilot_v4.jsonl        # Team D pilot, Java-fork-rendered
pilot /Users/nielspfeffer/Projects/mpmify/ml/data/pilot_v4.jsonl: 60 records, 120 parts, 7082 notes, 3769 cc points
  parts per record: 2->60
  movement rows: 608 in 60 records   asynchrony rows: 131 in 60 records
  cc ground-truth key(s): sustain_cc
  meico order-dependent paths exercised: artic_offdate=742  artic_unmatched=21  asyn_cvm_start_shifted=60  asyn_pos_start_shifted=3769  asyn_score_carried=71  asyn_score_end_shifted=1305  asyn_score_start_shifted=1305  rubato_pending_break=96  stacked_articulations=278  tempo_pending_skipped=584
  ms_on          max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 7082
  ms_off         max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 7082
  velocity       max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 7082
  cc_ms          max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 3769
  cc_value       max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 3769
EXACT

$ python3 validate_v4.py --java --negative --espressivo
java mode: 24 cases, 27 parts, 125 notes, 403 position events, 10 channelVolume events
  meico order-dependent paths exercised: artic_offdate=4  artic_unmatched=2  asyn_cvm_start_clamped=4  asyn_cvm_start_shifted=8  asyn_pos_start_clamped=8  asyn_pos_start_shifted=187  asyn_score_carried=14  asyn_score_end_clamped=13  asyn_score_end_shifted=75  asyn_score_start_clamped=17  asyn_score_start_shifted=74  rubato_pending_blocked=3  rubato_pending_break=5  stacked_articulations=2  tempo_pending_revisited=2  tempo_pending_skipped=28
  ms_on          max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 125
  ms_off         max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 125
  velocity       max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 125
  cc_ms          max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 413
  cc_value       max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 413
EXACT

negative controls (each MUST turn the battery MISMATCH):
  nc_prev_position_j0      DETECTED  1/24 cases differ, 8 non-bit-identical values, 4 shape errors
      Q2 'fixed': getPreviousPosition scans down to index 0
      first differing cases: mov_basic
  nc_default_curvature0    DETECTED  1/24 cases differ, 12 non-bit-identical values, 12 shape errors
      Q6 ignored: default curvature 0.0 instead of 0.4
      first differing cases: mov_defaults
  nc_render_last_movement  DETECTED  19/24 cases differ, 0 non-bit-identical values, 22 shape errors
      Q1 ignored: the final movement instruction is rendered
      first differing cases: artic_offdate, asyn_tick_vs_perf_end, full_stack, global_movement_both_parts
  nc_no_bracket_points     DETECTED  18/24 cases differ, 634 non-bit-identical values, 350 shape errors
      Q3 ignored: no prepended/appended exact endpoints
      first differing cases: artic_offdate, asyn_tick_vs_perf_end, full_stack, global_movement_both_parts
  nc_maxstep_127           DETECTED  18/24 cases differ, 716 non-bit-identical values, 404 shape errors
      maxStepSize compared in the 0..127 domain (the 16129 bug)
      first differing cases: artic_offdate, asyn_tick_vs_perf_end, full_stack, global_movement_both_parts
  nc_asyn_end_floor        DETECTED  1/24 cases differ, 1 non-bit-identical values, 0 shape errors
      A2 ignored: end floored at the note's own shifted start
      first differing cases: asyn_clamp_end
  nc_asyn_perf_end         DETECTED  1/24 cases differ, 2 non-bit-identical values, 0 shape errors
      asynchrony segment membership from date.end.perf, not ticks
      first differing cases: asyn_tick_vs_perf_end
  nc_artic_exact_date      DETECTED  1/24 cases differ, 6 non-bit-identical values, 0 shape errors
      A6 ignored: articulations matched by exact date (PerfChain)
      first differing cases: artic_offdate
  nc_artic_whole_chord     DETECTED  1/24 cases differ, 4 non-bit-identical values, 0 shape errors
      A6 half-ignored: off-date articulation spills over the chord
      first differing cases: artic_offdate
negative controls: ALL DETECTED

espressivo cross-check (meico-ts): 24 cases, 125 notes, 34 cc streams, 413 cc points
  ms_on          max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 125
  ms_off         max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 103
  velocity       max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 78
  cc_ms          max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 413
  cc_value       max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 413
EXACT

  QUARANTINED from the verdict -- known espressivo defects, 8 cases:
    [artic] artic_offdate, asyn_tick_vs_perf_end, full_stack
    [dyncurve] asyn_straddle, mov_basic, mov_max_step, overlap_pending, two_parts_local_maps
    ms_off         max|diff| = 656.741233650   max ulp = 4479557769567483.5   non-bit-identical = 12 / 22
    velocity       max|diff| = 12.000000000   max ulp = 1548112371908608.0   non-bit-identical = 16 / 47

### renderer attribution of the 1-ulp residue in pilot_v4_exact.jsonl (re-render through ml/java/RenderMpm)
rec    part note  field   python(bits)       jsonl(bits)        javafork(bits)
0      1    26    ms_off  0x40bf504f11f14071 0x40bf504f11f14072 0x40bf504f11f14071  PY==JAVA
0      1    27    ms_on   0x40bf504f11f14071 0x40bf504f11f14072 0x40bf504f11f14071  PY==JAVA
17     1    57    ms_off  0x40caef36cbd7230c 0x40caef36cbd7230d 0x40caef36cbd7230c  PY==JAVA
17     1    58    ms_on   0x40caef36cbd7230c 0x40caef36cbd7230d 0x40caef36cbd7230c  PY==JAVA
22     1    46    ms_off  0x40c9689b0bcbddd8 0x40c9689b0bcbddd7 0x40c9689b0bcbddd8  PY==JAVA
33     1    72    ms_off  0x40d6e517fda065b5 0x40d6e517fda065b6 0x40d6e517fda065b5  PY==JAVA
33     1    73    ms_on   0x40d6e517fda065b5 0x40d6e517fda065b6 0x40d6e517fda065b5  PY==JAVA
36     1    27    ms_off  0x40d4f509f5c22f68 0x40d4f509f5c22f67 0x40d4f509f5c22f68  PY==JAVA
36     1    28    ms_on   0x40d4f509f5c22f68 0x40d4f509f5c22f67 0x40d4f509f5c22f68  PY==JAVA
36     1    39    ms_off  0x40d868d7f1c98a1c 0x40d868d7f1c98a1b 0x40d868d7f1c98a1c  PY==JAVA
36     1    40    ms_on   0x40d868d7f1c98a1c 0x40d868d7f1c98a1b 0x40d868d7f1c98a1c  PY==JAVA
36     1    41    ms_on   0x40d868d7f1c98a1c 0x40d868d7f1c98a1b 0x40d868d7f1c98a1c  PY==JAVA
46     1    9     ms_off  0x40b05dc404dc972e 0x40b05dc404dc972f 0x40b05dc404dc972e  PY==JAVA
46     1    10    ms_on   0x40b05dc404dc972e 0x40b05dc404dc972f 0x40b05dc404dc972e  PY==JAVA

### v3 backward compatibility (PerfChainV4 must equal the v3 chain when the new maps are absent)
  pilot_v3                     EXACT
  pilot_v3_cov_polyphony       EXACT
  pilot_v3_cov_stackedArtic    EXACT
  pilot_v3_cov_danglingTempo   EXACT
  pilot_v3_cov_lateStart       EXACT
  pilot_v3_seed3002            EXACT
  pilot_v3_seed3003            EXACT
  (55,807 v3 notes + 7,082 v4 notes reproduced bit-exactly)

### espressivo defect 1 -- minimal repro (same MSM, same 3 notes, 100 bpm, volume 60)
literal:  <articulation date="0.0" relativeDuration="0.5" absoluteVelocityChange="12.0"/>
  JAVA        n0 vel 72.0  duration.perf 360.0        (-> ms end 300)
  espressivo  P1 n0 vel 60   ms 0 -> 600              (unarticulated)
styleDef: <articulationDef name="stac" relativeDuration="0.5" absoluteVelocityChange="12.0"/>
  JAVA        n0 vel 72.0  duration.perf 360.0
  espressivo  P1 n0 vel 72   ms 0 -> 300              (agrees)

### espressivo defect 2 -- minimal repro (overlap_pending case, note @2160 inside a 60->100 transition
###   with curvature=0.3 protraction=-0.4; ms values agree, only the curve shape differs)
  JAVA        P1_n4 2160.0 720.0 velocity 88.53760540485382  ms 1721.0735406080523 -> 2377.8147742584315
  PYTHON      P1_n4 2160   720   velocity 88.53760540485382  ms 1721.0735406080523 -> 2377.8147742584315
  espressivo  P1_n4 2160   720   velocity 80                 ms 1721.0735406080523 -> 2377.8147742584315

$ python3 -m py_compile movement_math.py asynchrony_math.py perf_chain_v4.py validate_v4.py
COMPILE_OK

## open_issues
[
 "CANONICAL.md needs a normative rule for meico's at-or-after articulation targeting (proposed A6): an articulation date with no note IN THE PART BEING RENDERED silently articulates the next note, and only the first note of a chord landed on this way. Either require articulation dates to be onsets in every part the map applies to, or make articulationMap part-local. Measured on pilot_v4.jsonl: 742 off-date landings, 278 stacked, 21 dropped past the last note -- i.e. the v4 DSL target and the rendered effect systematically disagree.",
 "ml/python/perf_chain.py (Team A) matches articulations by exact date. Correct for every v3 dataset, wrong for v4. I could not edit it (file ownership), so PerfChainV4 overrides it via a _ScoreChain subclass. Any other v4 consumer that calls PerfChain directly will silently mis-render articulation -- consider folding the fix into perf_chain.py at the next Team A pass.",
 "espressivo (meico-ts@a09f82c) ignores literal articulation attributes AND dynamics curvature/protraction. Blocks LOG.md's 'v4 generator migrates to meico-ts' decision; datasets rendered with --renderer espressivo (pilot_v4_espressivo.jsonl: 3989/7082 velocities, 1606/7082 offsets divergent) must not be used as supervision until both are fixed. Both fixes are one-liners in get<Map>DataOf; the dynamics one must also carry the fork's ensureCurvature/ProtractionBoundaries clamps.",
 "Team D renamed the pilots mid-run (pilot_v4.jsonl was the espressivo output at 10:38 and the Java output at 10:41). validate_v4.py globs pilot_v4*.jsonl and validates all of them, but the renderer is not recorded IN the JSONL -- suggest a 'renderer' field per record so attribution is not inferred from a filename.",
 "Movement-related coverage NOT exercised anywhere yet, so unproven in either direction: movementSampleMaxStep != 0.1 against the Java fork (MovementMap.movementSampleMaxStep is a static field, so RenderMpm cannot vary it per job -- the espressivo cross-check does vary it via RenderOptions); movementMap entries interleaved with <style> switches; sub-note dynamics (a channelVolume CURVE), which PerfChainV4 refuses with NotImplementedError."
]

# v4-ports — verify

## verdict
ISSUES

## issues
[
 "[report factual error, act on this] Team E writes that \"Team D's `generate_v4.mjs` ... defaults to `--renderer java`\". It does NOT: /Users/nielspfeffer/Projects/mpmify/ml/node/generate_v4.mjs:159 sets `renderer: 'espressivo'` as the default, and line 14's own doc says \"espressivo (default) | java\". Java must be requested explicitly; espressivo only WARNS (line 358) when articulation/dynamics are requested. Combined with Team E's own Findings 2/3 this means the out-of-the-box generator invocation produces defective supervision (articulation = no-op, dynamics curve = identity). The operative fact for the orchestrator is the opposite of what the report states.",
 "[latent silent divergence in perf_chain_v4.py] `PerfChainV4._resolve` (lines 302-308) treats an explicit `None` map value in a part dict as \"this part has a local NULL map\" and does NOT fall back to the global. meico has no such state: Performance.java:479-494 is `if (localMap == null) localMap = globalMap;` \u2014 a null local map ALWAYS inherits. So `spec['tempo'] = None` silently selects meico's 1-tick-=-1-ms fallback instead of the global tempoMap, and `spec['movement'] = None` silently drops a global movementMap. `validate_v4.py::_record_parts`'s \"parts\"-schema branch is exactly such a caller (`if k in p: spec[k] = p[k]`), so a JSONL part object carrying `\"movement\": null` would mis-resolve. Not reachable from today's flat-schema pilots, but a footgun for any v4 consumer. `None` should mean INHERIT, or be rejected.",
 "[coverage overstated] The headline \"7,082 notes + 3,769 CC points, 0 differing bits\" covers only HALF the rendered control-change output, and specifically not the asynchrony-on-positionMap path. Measured on pilot_v4.jsonl: part index 0 renders 3,829 CC points of which 3,769 are compared (the 60 channelVolume reset events are never compared in pilot mode); part index 1 renders 3,829 of which 0 are compared, because `_read_cc` gates on `part_index == 0` (Team D writes only `data.parts[0]`). Under AS0/Y1 the asynchronyMap sits on the LAST part, so the entire `asyn_pos_start_shifted=3769` counter comes from the unvalidated part \u2014 i.e. \"asynchrony applied to the positionMap\" has no pilot-scale ground truth and rests solely on the 24-case Java battery (asyn_pos_start_shifted=187 there). Real coverage is 3,769/7,658 = 49% of rendered CC points. Fix belongs in Team D's generator, but the report should not present it as full coverage.",
 "[inherited semantic gap, unreachable today] An empty-but-present dynamicsMap is not meico-equivalent. DynamicsMap.java:392-394 returns null when `elements.isEmpty()` BEFORE writing any velocity, so notes get NO `velocity` attribute, and ArticulationData.articulateNote:209 (`if (velocityAtt != null)`) then skips every velocity modifier. `PerfChain.__init__` collapses `dynamics=None` and `dynamics=[]` to the same thing (velocity 100.0) and then applies articulation. `_record_parts` produces `dynamics: []` from a JSONL `\"dynamics\":[]` \u2014 which pilot_v4_exact.jsonl actually contains (it only escapes because `articulation` is `[]` too). No battery case uses an empty dynamicsMap, so this is untested in both directions. Inherited from Team A's perf_chain.py; would bite a v4 record pairing an empty dynamicsMap with a non-empty articulationMap.",
 "[unclamped on the v4 path] `dynamics_math.inner_control_points` applies no bounds, but the fork clamps curvature/protraction at RENDER time, not only on the write path: DynamicsMap.java:346 `ensureCurvatureBoundaries(...)` and :350 `ensureProtractionBoundaries(...)` inside `getDynamicsDataOf`. Out-of-range values would diverge from the fork. Unreachable under CANONICAL \u00a73's sampler ranges and untested by the battery (_DYN_CURVE uses 0.3/-0.4). The report correctly states the fork clamps but does not note the Python side does not. The contrast is real and correctly reproduced for movement: MovementMap.getMovementDataOf (MovementMap.java:182-192) genuinely does NOT clamp (Q5).",
 "[evidence table incomplete / not reproducible] The 1-ulp attribution table is wrong on counts and is not derivable from the delivered files. I re-derived it: 8 records differ (0, 17, 20, 22, 33, 36, 41, 46), not \"6 affected records\", across 17 values, not 14 \u2014 records 20 and 41 differ only in `cc_ms` (3 points) and are absent from the table. I re-rendered all 8 through ml/java/RenderMpm: PY==JAVA on 17/17, and full-record Python-vs-fork comparison is 0 non-bit-identical over 4,444 values. The conclusion stands and is now stronger, but the script that produced the table is not among files_changed; validate_v4.py only prints advisory prose. Fold an `--attribute` mode into validate_v4.py so the claim is reproducible.",
 "[provenance hazard, sharpens Team E's own open issue] pilot_v4_exact.jsonl is NOT the same sample as pilot_v4.jsonl rendered differently \u2014 it is a different configuration (dynamics: [], articulation: [], 643 movement rows vs 608, 124 asynchrony rows vs 131, 4,114 vs 3,769 CC points) and it is the LEAST fork-exact of the three despite its name. pilot_v4.jsonl (Java) and pilot_v4_espressivo.jsonl (espressivo) ARE the same sample under two renderers (identical map counts; 3,989 velocity / 1,606 ms_off divergences, both reproduced exactly). The requested per-record `renderer` field should be widened to renderer + map-config + seed, or the filenames retired.",
 "[unguarded harness assumption, low risk] `_run_java` cannot set `MovementMap.movementSampleMaxStep` (static field, RenderMpm has no hook), so every Java-side comparison is implicitly at 0.1 while the Python side uses the case's `max_step`. The battery avoids the trap (mov_max_step passes exactly 0.1) and a mismatch would be loud (differing point counts), but nothing asserts it. Also structurally unrepresentable rather than merely untested: `<style>` elements interleaved in a movementMap \u2014 the 6-field row format cannot encode them, and in meico a trailing `<style>` makes the last *movement* renderable, flipping Q1.",
 "[minor] `pilot_mode`'s verdict requires `n_notes > 0` but not `n_cc > 0` (unlike `_compare_cases`, which requires `counts['positions'] > 0`), so a pilot file with no recognised CC key passes vacuously on the CC side. Mitigated only by the printed \"cc ground-truth key(s): NONE FOUND\" line.",
 "[context, not a defect] meico-ts moved during this verification: HEAD went f788c93 -> 415bbd2 and dist/ was rebuilt at 11:07 mid-session, with MovementMap.ts changed (+25/-11) since the a09f82c the report cites. ArticulationMap.ts and DynamicsMap.ts are unchanged since a09f82c, so Findings 2/3 attribute correctly. I re-ran --espressivo against the fresh dist: still EXACT (0/125 ms_on, 0/413 cc_ms, 0/413 cc_value), so the port survives the upstream MovementMap refactor. Any future espressivo leg is only valid for the dist as built at run time."
]

## evidence
VERDICT SUMMARY: every headline numeric claim reproduces exactly; the port is genuinely bit-exact against the Java fork. The listed issues are one report factual error, one latent API footgun, and coverage/provenance caveats — none invalidate the deliverable.

=== REPRODUCED BYTE-FOR-BYTE ===
1. `python3 validate_v4.py ../data/pilot_v4.jsonl` (nice -n 15, 7.0 s): output identical to the report — 60 records / 120 parts / 7,082 notes / 3,769 cc points; counters artic_offdate=742, artic_unmatched=21, stacked_articulations=278, asyn_pos_start_shifted=3769, asyn_score_carried=71, rubato_pending_break=96, tempo_pending_skipped=584; ms_on/ms_off/velocity/cc_ms/cc_value all 0 non-bit-identical, max ulp 0.0. EXACT.
2. `validate_v4.py --java --negative --espressivo`: identical to the report — 24 cases / 27 parts / 125 notes / 403 positions / 10 channelVolume, 0/125 + 0/413 non-bit-identical, EXACT; all 9 negative controls DETECTED; espressivo leg EXACT with the 8-case quarantine.
3. Files: all four exist, `py_compile` OK, all four import cleanly via importlib. `git status` shows only Team E's 4 new files under ml/python/ — perf_chain.py untouched, as claimed.
4. Hygiene claims true: grep finds no math.pow/math.log/math.exp/`**` operator (only markdown emphasis in docstrings); no accentuation code (single mention is the "OUT OF SCOPE (v4 gate)" comment); java mode uses tempfile.mkdtemp + shutil.rmtree — no dataset written.

=== PORT SEMANTICS CHECKED LINE-BY-LINE AGAINST THE FORK (not merely re-run) ===
- MovementData.java: Horner association order in getDatePosition/getTForDate matches; ×127 applied AFTER the subdivision (so maxStepSize really is in the 0..1 domain — the "16129 bug" framing is right); Q3 bracketing (series.add(0, beginning) + conditional appended end) and Q4 (constant → [startDate, position] for every t, no appended end) match.
- MovementMap.java: Q1 `movementIndex < this.size() - 1` (:224); Q2 `for (int j = index - 1; j > 0; --j)` (:200) and the unguarded getAttribute("transition.to").getValue() NPE the port raises on; `md.startDate >= 0` guard; getEndDate → Double.MAX_VALUE; Q6 field initialisers curvature 0.4 / protraction 0.0 / controller "sustain" (MovementData.java:22-24); Q5 no clamp on parse. All match.
- GenericMap.insertElement(kv, false) (:549-561) — back-to-front scan for key <= newKey, insert after; `_insert_element` mirrors it exactly.
- AsynchronyMap.renderAsynchronyToMap (:118-176): A1 `continue` on end >= asynEndDate; A2 `double startDateMs = 0.0` declared INSIDE the per-entry loop; A3 Math.max(0.0, ...) / Math.max(ms, startDateMs+1); A4 dur == null → done.add + continue; `end = duration + key` from the RAW tick duration. All verbatim. java_max NaN/signed-zero semantics verified against Java's spec by hand.
- Performance.perform (:505-555): the claimed order (dynamics → movement→positionMap → articulation → rubato-on-`maps` → tempo-on-`maps` → tempo+asynchrony on channelVolumeMap → tempo+asynchrony on positionMap → asynchrony on score) is exactly what the source does, and `maps` provably excludes positionMap/channelVolumeMap, so "the controller maps bypass rubato" is right.
- DynamicsMap.renderDynamicsToMap (:392-453): the single mandatory value="100.0" reset at the first dynamics date is real (later instructions see getLastElement().value == "100.0" and skip).

=== FINDING 1 (A6) — CONFIRMED AND LOAD-BEARING ===
Source: ArticulationMap.java:418 calls map.getAllElementsAt(ad.date), and GenericMap.getAllElementsAt (:274-284) = getElementIndexAtAfter(date) then results.add(elements.get(index)) UNCONDITIONALLY, key-checking only successors (key == date). So an off-date articulation lands on the next note, and on a chord only its first note. `_index_at_after` mirrors getElementIndexAtAfter (:468-489), including the Java `/2` vs Python `//2` argument (first+last is provably >= 0 whenever mid is used).
Independent quantification on real data: I monkey-patched `_ScoreChain._apply_articulation` back to `PerfChain._apply_articulation` and re-ran pilot_v4.jsonl → 549 ms_off + 543 velocity mismatches out of 7,082 (exactly the report's numbers); with the fix, 0/0/0. Root cause confirmed in the generator: generate_v4.mjs:251 `sampleArticulationMap(rng, distinctDates([score1, score2]))` with the map placed globally (:264). CANONICAL.md A4 ("applied per date … all notes of a chord share it") is therefore falsified for off-date landings — the proposed A6 is a genuine normative gap.

=== FINDINGS 2 & 3 (espressivo) — CONFIRMED FROM SOURCE AND END-TO-END ===
Source: meico-ts/src/mpm/elements/maps/ArticulationMap.ts:103-121 fills only xml/date/xmlId/noteid/style/name.ref — no numeric modifiers. DynamicsMap.ts:100-129 parses volume / transition.to / subNoteDynamics only; curvature and protraction are never read.
Independent minimal repro (my own fixtures, fork via RenderMpm vs espressivo via performMsmToData):
  literal artic:  JAVA n0 velocity 72.0, ms 0→300   |  espressivo velocity 60, ms 0→600
  dyn curvature 0.3 / protraction -0.4, note @2160: JAVA 88.53760540485382 | espressivo 80
Both match the report to the digit. The fork's clamps are on the RENDER path (DynamicsMap.java:346, :350), so the report is right that a fix must include them.

=== 1-ULP ATTRIBUTION — INDEPENDENTLY RE-DERIVED AND EXTENDED ===
Own harness (scratchpad attrib_check.py): built MSM+MPM per record, rendered via ml/java/RenderMpm, compared raw bit patterns.
  differing records: 0, 17, 20, 22, 33, 36, 41, 46 (8, not 6) — 17 values (not 14)
  PY==JAVA: 17/17; the JSONL is the outlier in every case
  full-record python-vs-fork: 0 non-bit-identical over 4,444 values (682+586+800+432+356+436+640+512)
So pilot_v4_exact.jsonl is espressivo-rendered and the residue is JS Math.pow vs fdlibm, exactly as claimed.

=== v3 BACKWARD COMPATIBILITY — VERIFIED, AND THE ODD NUMBER EXPLAINED ===
All 13 pilot_v3*.jsonl validate EXACT through PerfChainV4 (0 MISMATCH/SHAPE lines each). The 7 files the report's table lists sum to 37,226 notes, not 55,807. All 13 sum to 55,962; 55,962 − 155 (pilot_v3_smoke) = 55,807 — so the number is real, but the table shows 7 of the 12 files it was computed over. pilot_v3_smoke also validates EXACT.

=== NEGATIVE CONTROLS — GENUINE ===
Each control patches the PORT (module attribute or method) and re-compares against the ALREADY-RENDERED Java output, restoring in a `finally`. nc_default_curvature0 works because DEFAULT_CURVATURE is resolved from module globals at call time. No control touches the comparator. Real discrimination, not a self-fulfilling check.

COMMANDS RUN (all under nice -n 15; no dataset generated, no training touched): validate_v4.py on pilot_v4 / pilot_v4_exact / pilot_v4_espressivo / all 13 pilot_v3*; validate_v4.py --java --negative --espressivo; validate_v4.py --espressivo re-run after meico-ts rebuilt its dist; two scratchpad scripts (Java re-render attribution; A6-necessity ablation); one scratchpad espressivo-defect repro. Java runs reused the existing ml/java/out/RenderMpm.class; temp dirs only.

# v4-ports — fixed

## report
## Team E fix round — all 10 verified issues addressed, battery re-proven

Every issue is fixed **in code with a negative control**, not in prose. The case battery grew 24 -> 28 and the negative-control battery 9 -> 12; all 12 controls still fire. A new `--cross-java` leg turns the "coverage overstated" complaint from a caveat into evidence.

### 1. Report factual error — CORRECTED (the operative fact is the opposite)
Verified `ml/node/generate_v4.mjs:159` = `renderer: 'espressivo'`, doc line 14 says "espressivo (default) | java", and line 366-370 only *warns* on stderr when articulation/dynamics are requested. **The out-of-the-box generator invocation produces defective supervision.** This is now printed by `validate_v4.py` itself (`ESPRESSIVO_IMPACT`, new final paragraph) so it cannot go stale in a report again: *"AND IT IS THE DEFAULT … `--renderer java` should be the DEFAULT rather than the documented escape hatch (Team D's file, not this one)."*

### 2. `_resolve` None-means-null — FIXED (`perf_chain_v4.py:_resolve`)
`None` / absent key / `INHERIT` now all mean **inherit**, mirroring `Performance.java:479-494` (`if (localMap == null) localMap = globalMap;` — meico has no shadowing-null state). New battery case **`local_null_maps_inherit`**: P1's part element carries no tempo/dynamics/movement map, spelled in the Python spec as explicit `None`, and must render identically to P2 which spells it by omission. New negative control **`nc_local_none_shadows`** restores the old reading → **DETECTED** (8 non-bit-identical values, 2 shape errors).

### 3. Coverage overstated — FIXED TWICE (reported *and* closed)
- `pilot_mode` now prints real coverage: `cc coverage: 12219 of 24438 rendered positionMap points compared (50%), plus 120 channelVolume reset events rendered and never recorded; positions have ground truth for part index [0] and are rendered for [0, 1]`, plus a NOTE naming the uncovered parts and the AS0 consequence.
- New **`--cross-java [N]`**: re-renders the pilot's own MSM+MPM through `ml/java/RenderMpm` and compares **all parts, all control changes** at full precision. On all 60 records: **24,558 CC points + 7,251 notes, 0 non-bit-identical**, with `asynchrony-on-positionMap events now covered: 12219` (was 0). The path that previously rested only on the 24-case battery now has pilot-scale ground truth. No dataset is written (temp dir, deleted).

### 4. Empty-but-present dynamicsMap (new rule **D0**) — FIXED
`DynamicsMap.java:392-394` returns null *before* writing anything, so an empty `<dynamicsMap/>` leaves notes with **no `velocity` attribute**, and `ArticulationData.articulateNote:209` (`if (velocityAtt != null)`) then drops `absoluteVelocityChange` while `relativeDuration` still scales `duration.perf`. `_ScoreChain` now takes `dynamics_present`, renders `velocity = None`, and counts `artic_velocity_skipped`. `Diffs.add` treats **absent-on-both-sides as an exact agreement** (counted and printed separately, never silently). Two new cases (`dyn_empty_local`, `dyn_no_dynamics_map_at_all`) hold both halves; the fork confirms it (`attribute absent on both sides = 7`, `artic_velocity_skipped=3`). Control **`nc_empty_dyn_vel100`** → DETECTED.

### 5. Dynamics curvature/protraction unclamped (new rule **D1**) — FIXED
Added `_ensure_curvature_boundaries` / `_ensure_protraction_boundaries` / `_clamped_dynamics` (ports of `DynamicsMap.java:249-276`, applied at render time per `:346, :350`), written as one-sided comparisons so NaN falls through as in Java. New case **`dyn_out_of_range_curve`** carries curvature 1.7 / protraction -2.5 **in the dynamicsMap and the movementMap at once**, so a single case proves the asymmetry: dynamics clamped, movement not (Q5). Counter `dynamics_boundary_clamped=4`. Control **`nc_no_dyn_clamp`** → DETECTED.

### 6. Attribution table not reproducible — FIXED (`--attribute`)
New mode re-renders exactly the differing records through the fork and prints python / JSONL / fork bit patterns with a per-value verdict (`PY==JAVA`, `JSONL==JAVA <-- THE PORT IS WRONG`, `ALL THREE DIFFER`, `SHAPE`), plus a **raw full-precision** python-vs-fork cross-check on the same records. It reproduced the corrected counts on the old file (8 records / 17 values, not 6 / 14) and now runs against the regenerated ones.

### 7. Provenance hazard — FIXED as far as the file allows
`pilot_mode` prints a per-file **map-configuration fingerprint** and the **record metadata keys**, so `pilot_v4_exact.jsonl` self-identifies as a different configuration (`asynchrony+movement+rubato+tempo`, no dynamics/articulation) rather than "the same sample, rendered exactly". The renderer is still not in the JSONL — remains an open request, now widened to renderer + seed.

### 8. `movementSampleMaxStep` harness assumption — FIXED
`_assert_java_default_max_step` refuses any java-mode case whose Python side asks for a non-default step, naming the cause (`MovementMap.movementSampleMaxStep` is static; `RenderMpm` has no hook). `<style>`-interleaved maps documented as **structurally unrepresentable** in the `perf_chain_v4` module docstring, with the Q1-flip consequence.

### 9. Vacuous CC verdict — FIXED (and the first cut was too broad; caught by the v3 sweep)
Verdict now fails when a **positionMap** was rendered and nothing compared it. My first version counted channelVolume resets too, which turned all 8 dynamics-carrying v3 pilots MISMATCH; narrowed to position events only (the reset is one event per record, emitted by every dynamicsMap, fully covered by the java battery). All 13 v3 pilots EXACT again.

### 10. meico-ts moved — RE-VERIFIED, and a THIRD finding
Re-checked at **meico-ts@415bbd2, dist built 11:35:42**: the articulation defect (`ArticulationMap.ts:103-121`) and the dynamics curvature/protraction defect (`DynamicsMap.ts:100-128`) are **still present** — T16/T21/TD2 moved the code, not the omission. The battery re-passes unchanged across TD2's `MovementMap.ts` rewrite. Provenance is now documented as **per-run, not per-commit** (the leg tests `dist/` as built at run time).

**New finding F4 — espressivo's facade cannot express an absent velocity (NOT a renderer defect).** `DynamicsMap.ts:159` mirrors the fork's D0 short-circuit exactly; the loss is one layer up in the frozen facade: `readNote` (`src/api/pipeline.ts:250`) returns `optionalNumber('velocity', note) ?? 100`, a documented unperformed-note fallback (their RULE E3). A `performMsmToData` consumer cannot tell "no velocity attribute" from "velocity 100.0" — so a facade-based v4 generator would record a velocity meico never wrote. Harmless while CANONICAL.md never emits an empty map element; quarantined as reason `velabsent` with a repro.

### SCHEMA CHANGE CAUGHT MID-SESSION — Team D regenerated all three pilots at 11:28
The new schema adds `total_ticks`, 6-field movement rows with `controller`, and — the load-bearing one — **`sustain_cc` values are now `Math.round`ed to the integer MIDI observable** (`generate_v4.mjs:406`; rationale: `Msm.parsePositionMap` emits the integer and the Vienna corpus has 0/3385 non-integer values). Comparing raw doubles against it produced `max|diff| = 0.5` on 5,734 / 12,219 points. Added `_js_round` (ECMAScript `Math.round` = `floor(x+0.5)`; Python's `round(0.5) == 0` would differ) and auto-detection: integral ground truth is compared in the MIDI domain, anything else raw. **Still a bit-pattern comparison, of a value the port computes rather than reads**, and never weaker — rounding is idempotent on integral rendered values, while `--cross-java` keeps the raw-precision proof against the fork. Result: 0 / 12,219.

### Findings 2/3 now proven at pilot scale, not just on the battery
`--attribute ../data/pilot_v4_espressivo.jsonl`: **5,658 differing values, every single one `PY==JAVA`**, and 0 of 46,191 raw python-vs-fork values non-bit-identical. The port and the fork agree; espressivo is the outlier. `pilot_v4_exact.jsonl` is likewise espressivo-rendered (28 values, all `PY==JAVA`, 0 / 9,961 raw) — the filename is a misnomer.

### Also corrected
`_record_parts` now reads an empty JSONL map list as **"the map element was absent"** (`xml.mjs::buildMpm` writes an element only `if (maps.X && maps.X.length)`; `SampleAndRender.java:520` does the same with `if (!dyns.isEmpty())`). Before the D0 fix this was an accidental collapse that happened to be right; now it is the documented reading, with the limitation spelled out (the JSONL cannot express a deliberately empty map — no generator emits one). The stale A6 measurement in the `_ScoreChain` docstring was refreshed to the regenerated pilot (743 / 282 / 22 on 7,251 notes).

## files_changed
[
 "/Users/nielspfeffer/Projects/mpmify/ml/python/perf_chain_v4.py",
 "/Users/nielspfeffer/Projects/mpmify/ml/python/validate_v4.py"
]

## validation_output
$ python3 validate_v4.py --java --negative --espressivo
java mode: 28 cases, 33 parts, 154 notes, 484 position events, 14 channelVolume events
  meico order-dependent paths exercised: artic_offdate=4  artic_unmatched=3  artic_velocity_skipped=3  asyn_cvm_start_clamped=4  asyn_cvm_start_shifted=8  asyn_pos_start_clamped=8  asyn_pos_start_shifted=204  asyn_score_carried=14  asyn_score_end_clamped=13  asyn_score_end_shifted=82  asyn_score_start_clamped=17  asyn_score_start_shifted=81  dynamics_boundary_clamped=4  rubato_pending_blocked=3  rubato_pending_break=5  stacked_articulations=2  tempo_pending_revisited=2  tempo_pending_skipped=38
  ms_on          max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 154
  ms_off         max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 154
  velocity       max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 154   attribute absent on both sides = 7
  cc_ms          max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 498
  cc_value       max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 498
EXACT

negative controls (each MUST turn the battery MISMATCH):
  nc_prev_position_j0      DETECTED  1/28 cases differ, 8 non-bit-identical values, 4 shape errors
      Q2 'fixed': getPreviousPosition scans down to index 0
      first differing cases: mov_basic
  nc_default_curvature0    DETECTED  1/28 cases differ, 12 non-bit-identical values, 12 shape errors
      Q6 ignored: default curvature 0.0 instead of 0.4
      first differing cases: mov_defaults
  nc_render_last_movement  DETECTED  23/28 cases differ, 0 non-bit-identical values, 27 shape errors
      Q1 ignored: the final movement instruction is rendered
      first differing cases: artic_offdate, asyn_tick_vs_perf_end, dyn_empty_local, dyn_no_dynamics_map_at_all
  nc_no_bracket_points     DETECTED  22/28 cases differ, 750 non-bit-identical values, 413 shape errors
      Q3 ignored: no prepended/appended exact endpoints
      first differing cases: artic_offdate, asyn_tick_vs_perf_end, dyn_empty_local, dyn_no_dynamics_map_at_all
  nc_maxstep_127           DETECTED  22/28 cases differ, 862 non-bit-identical values, 482 shape errors
      maxStepSize compared in the 0..127 domain (the 16129 bug)
      first differing cases: artic_offdate, asyn_tick_vs_perf_end, dyn_empty_local, dyn_no_dynamics_map_at_all
  nc_asyn_end_floor        DETECTED  1/28 cases differ, 1 non-bit-identical values, 0 shape errors
      A2 ignored: end floored at the note's own shifted start
      first differing cases: asyn_clamp_end
  nc_asyn_perf_end         DETECTED  1/28 cases differ, 2 non-bit-identical values, 0 shape errors
      asynchrony segment membership from date.end.perf, not ticks
      first differing cases: asyn_tick_vs_perf_end
  nc_artic_exact_date      DETECTED  2/28 cases differ, 6 non-bit-identical values, 1 shape errors
      A6 ignored: articulations matched by exact date (PerfChain)
      first differing cases: artic_offdate, dyn_empty_local
  nc_artic_whole_chord     DETECTED  2/28 cases differ, 4 non-bit-identical values, 1 shape errors
      A6 half-ignored: off-date articulation spills over the chord
      first differing cases: artic_offdate, dyn_empty_local
  nc_empty_dyn_vel100      DETECTED  1/28 cases differ, 7 non-bit-identical values, 0 shape errors
      D0 ignored: an empty dynamicsMap defaults velocity to 100.0
      first differing cases: dyn_empty_local
  nc_no_dyn_clamp          DETECTED  1/28 cases differ, 3 non-bit-identical values, 0 shape errors
      D1 ignored: dynamics curvature/protraction not clamped at render
      first differing cases: dyn_out_of_range_curve
  nc_local_none_shadows    DETECTED  1/28 cases differ, 8 non-bit-identical values, 2 shape errors
      map resolution: a local `None` map shadows instead of inheriting
      first differing cases: local_null_maps_inherit
negative controls: ALL DETECTED

espressivo cross-check (meico-ts): 28 cases, 154 notes, 43 cc streams, 498 cc points
  ms_on          max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 154
  ms_off         max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 110
  velocity       max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 78
  cc_ms          max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 498
  cc_value       max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 498
EXACT

  QUARANTINED from the verdict -- known espressivo defects, 12 cases:
    [artic] artic_offdate, asyn_tick_vs_perf_end, dyn_empty_local, dyn_no_dynamics_map_at_all, full_stack, local_null_maps_inherit
    [dyncurve] asyn_straddle, dyn_out_of_range_curve, mov_basic, mov_max_step, overlap_pending, two_parts_local_maps
    [velabsent] dyn_empty_local
(espressivo provenance for this run: meico-ts@415bbd2, dist/api/index.js built 9 Aug. 11:35:42 2026)


$ python3 validate_v4.py ../data/pilot_v4.jsonl --cross-java 60
pilot ../data/pilot_v4.jsonl: 60 records, 120 parts, 7251 notes, 12219 cc points
  parts per record: 2->60
  movement rows: 1781 in 60 records   asynchrony rows: 125 in 60 records
  map configuration(s): articulation+asynchrony+dynamics+movement+rubato+tempo x45; articulation+asynchrony+dynamics+movement+tempo x15
  record metadata keys: id, ppq, total_ticks
  cc ground-truth key(s): sustain_cc   value encoding: MIDI round(value)
  cc coverage: 12219 of 24438 rendered positionMap points compared (50%), plus 120 channelVolume reset events rendered and never recorded; positions have ground truth for part index [0] and are rendered for [0, 1]
  meico order-dependent paths exercised: artic_offdate=743  artic_unmatched=22  asyn_cvm_start_shifted=60  asyn_pos_start_shifted=12219  asyn_score_carried=61  asyn_score_end_shifted=1283  asyn_score_start_shifted=1283  rubato_pending_break=107  stacked_articulations=282  tempo_pending_skipped=595
  ms_on          max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 7251
  ms_off         max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 7251
  velocity       max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 7251
  cc_ms          max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 12219
  cc_value       max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 12219
  NOTE: parts [1] render a positionMap with no ground truth in the file. Under sampler rule AS0 the asynchronyMap sits on the LAST part, so the asynchrony-on-positionMap path (asyn_pos_* above) is counted there but has no pilot-scale ground truth; run --cross-java to cover it against the fork.

  cross-java (fork re-render of the first 60 records, ALL parts, ALL control changes): 120 parts, 7251 notes, 24438 position events, 120 channelVolume events
    asynchrony-on-positionMap events now covered: 12219
    ms_on          max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 7251
    ms_off         max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 7251
    velocity       max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 7251
    cc_ms          max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 24558
    cc_value       max|diff| = 0.000000000   max ulp = 0.0   non-bit-identical = 0 / 24558
    EXACT
EXACT


$ python3 validate_v4.py --attribute ../data/pilot_v4_exact.jsonl        # (tail)
attribution for ../data/pilot_v4_exact.jsonl: 60 records, 14 differ from this port
rec    part idx   field    python(bits)       jsonl(bits)        javafork(bits)     verdict
5      1    27    cc_ms    0x40b20a70c8cc021c 0x40b20a70c8cc021d 0x40b20a70c8cc021c PY==JAVA
10     1    49    ms_off   0x40c62a264167bc0d 0x40c62a264167bc0e 0x40c62a264167bc0d PY==JAVA
19     1    23    ms_on    0x40ad6d73d65d85f5 0x40ad6d73d65d85f8 0x40ad6d73d65d85f5 PY==JAVA
30     1    17    ms_on    0x40b041a79be2149d 0x40b041a79be2149e 0x40b041a79be2149d PY==JAVA
45     2    8     ms_on    0x40c7aa9044471f4f 0x40c7aa9044471f4e 0x40c7aa9044471f4f PY==JAVA
49     1    39    ms_on    0x40c0d74c4aa753d9 0x40c0d74c4aa753d8 0x40c0d74c4aa753d9 PY==JAVA
   [...28 rows total, all PY==JAVA...]

  28 differing values: PY==JAVA=28
  (`cc_val*` = the MIDI observable Math.round(value), the domain this file's ground truth is stored in; every other field is the raw double)
  full-record cross-check on the same records, RAW full precision: 0 of 9961 python-vs-fork values are non-bit-identical
ATTRIBUTED TO THE RENDERER THAT WROTE THE JSONL


$ python3 validate_v4.py --attribute ../data/pilot_v4_espressivo.jsonl   # (tail)
  ... more PY==JAVA rows suppressed (--verbose prints them all)

  5658 differing values: PY==JAVA=5658
  (`cc_val*` = the MIDI observable Math.round(value), the domain this file's ground truth is stored in; every other field is the raw double)
  full-record cross-check on the same records, RAW full precision: 0 of 46191 python-vs-fork values are non-bit-identical
ATTRIBUTED TO THE RENDERER THAT WROTE THE JSONL


$ for f in ../data/pilot_v3*.jsonl; do python3 validate_v4.py "$f"; done   # v3 backward compatibility
  pilot_v3_cov_all.jsonl                             EXACT     6305 notes
  pilot_v3_cov_danglingTempo.jsonl                   EXACT     5143 notes
  pilot_v3_cov_lateStart.jsonl                       EXACT     5171 notes
  pilot_v3_cov_polyphony.jsonl                       EXACT     6245 notes
  pilot_v3_cov_stackedArtic.jsonl                    EXACT     5147 notes
  pilot_v3_seed3002.jsonl                            EXACT     5115 notes
  pilot_v3_seed3003.jsonl                            EXACT     5276 notes
  pilot_v3_smoke.jsonl                               EXACT     155 notes
  pilot_v3_tempo_articulation_rubato.jsonl           EXACT     3069 notes
  pilot_v3_tempo_articulation.jsonl                  EXACT     3069 notes
  pilot_v3_tempo_dynamics_articulation_rubato.jsonl  EXACT     3069 notes
  pilot_v3_tempo_rubato.jsonl                        EXACT     3069 notes
  pilot_v3.jsonl                                     EXACT     5129 notes
  total v3 notes reproduced: 55962


$ python3 -m py_compile movement_math.py asynchrony_math.py perf_chain_v4.py validate_v4.py
COMPILE_OK

$ grep -c "math.pow\|math.log" movement_math.py asynchrony_math.py perf_chain_v4.py
0   (no new transcendental; tempo still reaches Java's fdlibm via perf_chain/java_libm)

## open_issues
[
 "STILL OPEN (Team F / CANONICAL.md): the A6 normative rule. An articulation date with no note IN THE PART BEING RENDERED silently articulates the next note, and only the first note of a chord landed on this way. Re-measured on the regenerated pilot_v4.jsonl (60 pieces / 7251 notes): 743 off-date landings, 282 stacked, 22 dropped past the last note. Either require articulation dates to be onsets in every part the map applies to, or make articulationMap part-local.",
 "NEW, for CANONICAL.md: two more meico states v3 could not reach, now ported and under negative control. D0 -- an empty but PRESENT <dynamicsMap/> suppresses the velocity attribute entirely (DynamicsMap.java:392-394) and thereby silently disables every articulation velocity modifier (ArticulationData.java:209), while NO dynamicsMap writes an explicit 100.0. D1 -- dynamics curvature/protraction are clamped to [0,1] / [-1,1] at RENDER time (DynamicsMap.java:346,350), whereas movement curvature/protraction are not (Q5). CANONICAL.md should state that the canonical form never emits an empty map element, which is what keeps D0 unreachable in supervision data.",
 "STILL OPEN (Team A): ml/python/perf_chain.py matches articulations by exact date -- correct for v3, wrong for v4. PerfChainV4 overrides it via _ScoreChain; any other v4 consumer calling PerfChain directly still mis-renders articulation, and now also mis-renders D0 (PerfChain collapses dynamics=None and dynamics=[] to velocity 100.0) and D1 (no clamp). Three behaviours to fold into perf_chain.py at the next Team A pass.",
 "STILL OPEN (Team D / meico-ts): espressivo ignores literal articulation attributes AND dynamics curvature/protraction. RE-VERIFIED PRESENT at meico-ts@415bbd2 (ArticulationMap.ts:103-121, DynamicsMap.ts:100-128) -- T16/T21/TD2 moved the code, not the omission. Now proven at pilot scale, not just on the battery: --attribute pilot_v4_espressivo.jsonl gives 5658 differing values, ALL PY==JAVA, with 0/46191 raw python-vs-fork values differing. ACT ON THIS: generate_v4.mjs:159 defaults to renderer 'espressivo' and only warns; flip the default to java until both are fixed. The dynamics fix must also carry the fork's ensureCurvature/ProtractionBoundaries clamps (see perf_chain_v4._clamped_dynamics for the exact port).",
 "NEW (meico-ts, facade not renderer): espressivo's frozen facade cannot express an ABSENT velocity. DynamicsMap.ts:159 mirrors the fork's D0 short-circuit exactly, but readNote (src/api/pipeline.ts:250) returns `optionalNumber('velocity', note) ?? 100` -- their documented RULE E3 unperformed-note fallback. A performMsmToData consumer therefore cannot distinguish 'no velocity attribute' from 'velocity 100.0', so a facade-based generator would record a velocity meico never wrote. Harmless while the canonical form never emits an empty map element; otherwise the facade needs `velocity: number | null`.",
 "STILL OPEN (Team D): the JSONL records no renderer. pilot_mode now prints a map-configuration fingerprint and the record metadata keys, which is enough to tell pilot_v4_exact.jsonl (asynchrony+movement+rubato+tempo) apart from pilot_v4.jsonl (all six) -- but the renderer still has to be INFERRED via --attribute. Request widened: add `renderer` AND `seed` per record. Note pilot_v4_exact.jsonl is espressivo-rendered despite its name.",
 "SCHEMA WATCH: Team D regenerated all three pilots at 11:28 mid-session. `sustain_cc` values are now Math.round-ed to the integer MIDI observable (generate_v4.mjs:406). validate_v4.py auto-detects integral ground truth and compares in the MIDI domain via a port of ECMAScript Math.round (Python's round() would differ on exact .5); raw full precision is still proven against the fork by --cross-java. Any consumer reading sustain_cc as the raw positionMap double will be wrong by up to 0.5.",
 "REMAINING UNPROVEN COVERAGE (unchanged, both structurally hard): movementSampleMaxStep != 0.1 against the Java fork -- MovementMap.movementSampleMaxStep is a static field and RenderMpm has no hook, so java mode now REFUSES such a case rather than silently comparing two different curves (the espressivo leg does vary it via RenderOptions). And <style> elements interleaved into a map are structurally unrepresentable in the 6-field row format; in meico a trailing <style> in a movementMap makes the last movement renderable, flipping Q1. Sub-note dynamics (a channelVolume CURVE) is still refused with NotImplementedError."
]

