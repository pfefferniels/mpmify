# espressivo-gen — built

## report
## Team D — v4 generator on espressivo: delivered, plus a blocking cross-renderer finding

### What was built (`ml/node/`, no npm deps, espressivo imported from its absolute `dist` path)

| file | role |
|---|---|
| `java_random.mjs` | exact `java.util.Random` (48-bit LCG in two 24-bit halves, all intermediates < 2^53 → exact), plus `jround`/`jrint`. Verified 180/180 draws identical to Java over 6 seeds × {nextDouble, nextInt(b) incl. power-of-2 and rejection branches, nextInt(), nextBoolean} |
| `sampler.mjs` | v3 core ported 1:1 from `SampleAndRender.java` (same draw order, same rejection loops, same `&&` short-circuits) + v4 additions |
| `xml.mjs` | MSM/MPM builders mirroring meico's own serialization (`Double.toString` via `jd()`, `%.2f`-stripped via `fmt()`) |
| `augmented_msm.mjs` | reads a meico-augmented MSM into the *exact* shape `performMsmToData` returns, so both renderers are interchangeable inputs to the same code |
| `generate_v4.mjs` | CLI. `--renderer espressivo\|java`, `--maps`, `--v3-compat`, `--with-accentuation` (default OFF), `--probe-no-pow`, `--dump-dir`, `--print-domain`, `--two-part-prob/--movement-prob/--asynchrony-prob`, `--movement-max-step` |
| `verify_v4.mjs` | `cross` (both renderers + JSONL losslessness, per-field-class, ULP-classified), `v3compat`, `invariants` (canonical-rule checker + realised-domain report) |

### (1) v3 port is exact — 0 diff, bit level
`generate_v4.mjs --v3-compat --renderer java` vs `java SampleAndRender` at the same seed: **89,639 scalar comparisons, 0 mismatches** over 200 pieces / 10,601 notes — sampled maps *and* rendered notes. This is the strongest available proof that the port (score sampler, R1–R8, A1–A5, T1–T4, D1, G7/G8, anti-skew frame-first rubato draw) is faithful: it reproduces the Java RNG stream and every rejection loop.

### (2) v4 additions
- **2-part scores**: part 2 = bass ({360,720,1440,2880} grid, pitch 24–60, 12 % rests, 10 % 2-note chords). All maps global except asynchrony. Articulation is sampled over the **union** of distinct onset dates (the map is global, meico applies it per part).
- **asynchronyMap**, part-2-local (rule AS0 — part 1 is the un-offset reference, so the offset is identifiable as a *relative* lead/lag). 1–3 beat-aligned segments ≥ 4 beats apart, integer ms in [−80,−8] ∪ [8,80], G8 merge.
  **New normative rule AS3 (deviation from the brief, deliberate):** the date-0 segment's offset must be **positive**. `AsynchronyMap.renderAsynchronyToMap` clamps `Math.max(0.0, ms + offset)` (`AsynchronyMap.java:139`), so a negative date-0 offset is silently truncated for every note whose un-offset ms date is below |offset| — with 32nd notes at 240 bpm that is the first three onsets — making the label unrecoverable from the render. Later segments start at beat ≥ 4, i.e. ≥ 1000 ms even at the fastest sampled tempo, so they carry either sign.
- **movementMap** (sustain only): beat-aligned boundaries ≥ 2 beats apart, position/transition.to 0..1 @2dp, transition depth ≥ 0.15 (MV4), 60 % continuity else a jump ≥ 0.10 (MV5), curvature [0,0.9] / protraction [−0.7,0.7] @2dp, chain ends on a constant at the piece end (MV3 — also *inert*: `renderMovementToMap` skips the last element, the movement analogue of G7/R6).
  JSONL `sustain_cc` is part 1's stream **verbatim**, duplicates included: `getMovementSegment` emits `[start,position]` twice per element and `[end,transitionTo]` twice per transition, and a *constant* element emits three identical points at its own date and nothing after → the held value is recoverable only under **last-wins state semantics**, the same convention the Vienna pedal ingest needed.

### (3) Domain randomization (all widenings, `--print-domain` prints this; `verify_v4.mjs invariants` measures the realised values)
| knob | v3 | v4 | realised on the pilot |
|---|---|---|---|
| piece length | 16 + U{0..32} = 16–48 beats | **16 + U{0..48} = 16–64** | min 21 / median 42 / max 60 |
| bpm | log-uniform [40,200] | **log-uniform [25,240]** | min 25.0, median 79.2, max 238.7 (n=518) |
| rhythm grid | {180,360,720,1440} p={.20,.40,.30,.10} | **{90,180,360,540,720,1440} p={.08,.20,.32,.10,.22,.08}** | 90:1231, 540:470 notes |
| dense episodes | none | **4 %/event → 1–2-beat run from {90,180} p={.6,.4}** | busiest 1-beat window: median 9, max 15 notes |
| chords | p=0.15, 2–4 | p=**0.18**, 2–4 | — |
| tempo segments | 4 + U{0..12} (mean 10) | **per piece segMax ∈ {6,8,12,16} → 4 + U{0..segMax−4}**, mean 5/6/8/10 ⇒ **up to 2× v3 density** | — |
| dynamics segments | 4 + U{0..12} | same scheme, drawn independently | — |
| parts | 1 | **2** | 60/60 |

### (4) VALIDATION — and the finding that changes the plan

**espressivo 0.11.2 (meico-ts@68d773c, dist built today 10:30) is NOT equivalent to the Java fork.** Three defects, all reproduced on *meico-serialized* fixtures (`ml/data/debug_v3/piece{0,1,2}.mpm`), so none is an artefact of the XML I write:

- **E1** `ArticulationMap.getArticulationDataOf` (`src/mpm/elements/maps/ArticulationMap.ts:103`) stops after `name.ref` and never reads the twelve numeric modifier attributes that `ArticulationMap.java` reads → every literal articulation renders as the **identity** (`relativeDuration`→1, `absoluteVelocityChange`→0). `ArticulationData`'s own XML constructor *does* parse them; it is simply not the path the map uses.
- **E2** `DynamicsMap.getDynamicsDataOf` (`src/mpm/elements/maps/DynamicsMap.ts:100`) never reads `curvature`/`protraction`; Java reads both via `ensure*Boundaries` → every dynamics transition renders on the wrong Bézier.
- **E3** `AccentuationPatternDef.ts:273` still has the pre-TD3 dead guard `i > length-1` (the file's own comment says "DELIBERATE JAVA BUG, STILL PORTED AS IS … belongs to item TD3"), while the Java fork has `i < size-1` since meico@1d662105. **TD3 has not landed in the built dist**, whatever "TD3 ungated" in meico-ts@68d773c suggests. 10-piece probe: 482/869 velocities differ, max 8.86 units; timing untouched. **The accentuation gate is therefore correctly still closed** — `--with-accentuation` stays default OFF and no supervision data was generated.

Neither E1 nor E2 is deliberate bug-for-bug parity; both are silent omissions. I did not touch meico-ts (not my files).

Response: `generate_v4.mjs` gained `--renderer espressivo|java` (both consume the *same* XML strings; the java path batches through `ml/java/RenderMpm --batch` in one JVM). The shipped pilot is **java-rendered**.

**A fourth difference class, characterised not excused:** 1–2 ULP disagreements in ms fields from Java's fdlibm vs macOS libm `pow`/`log` (LOG.md "Build-team wave 1"). A rendered onset can pass through two such calls in series (rubato warp → tempo power function), so the envelope is 2 ULP. This is *earned* by a control: `--probe-no-pow` strips tempo transitions and rubato, leaving only +−×÷ on the render path, and that configuration is **bit-exact, 133,328 comparisons, 0 diff** — which is exactly the run that proves 2-part scores, asynchronyMap (incl. its effect on the positionMap) and the whole movementMap curve machinery are logic-identical between the renderers.

### (5) Throughput (M1, `nice -n 15`, all v4 maps, 2 parts, ~120 notes/piece)
| stage | ms/piece | pieces/s |
|---|---|---|
| sampling + XML build (Node) | **~1.0** | ~1000 |
| espressivo render | 74.7 (49.9 without movementMap) | 13.4 |
| Java `RenderMpm --batch`, marginal | **7.3** (JVM startup ≈ 1.5 s, amortised) | 137 |
| end-to-end, `--renderer java`, 100 pieces | 23.6 incl. startup | 42.4 |

Extrapolated single-threaded cost of a 20k-piece v4 set: **~2.8 min via java**, ~25 min via espressivo. v3's `SampleAndRender.java` was 8.5 ms/piece for 1-part 16–48-beat pieces, so the java path is on par at ~8.3 ms/piece despite 2 parts, 2× length and the pedal map. movementMap costs ~0.7 ms/piece in Java and ~25 ms/piece in espressivo (both with `movementSampleMaxStep = 0.1`, meico's own default — kept so the cross-check is apples-to-apples).

### Design decisions worth the orchestrator's review
1. **movementMap is global** (per "both parts share global maps"), so meico renders one positionMap *per part*; part 2's is part 1's shifted by its asynchrony offset. JSONL keeps only part 1's. Making it part-1-local would halve pedal render cost with no information loss — say the word.
2. **AS3** (positive date-0 asynchrony offset) deviates from the brief's literal "[-80,80] excluding [-8,8]"; justification above. Reversible via one constant in `sampler.mjs`.
3. `pilot_v4.jsonl` is the **java-rendered** file deliberately: a downstream consumer reaching for the obvious name must not get E1/E2-corrupted velocities. The espressivo render is `pilot_v4_espressivo.jsonl`, kept only to measure the defect.
4. MV5's 0.10 jump deadband allows pedal *discontinuities* (two CC values on one millisecond) rather than forcing continuity — realistic for pedalling and fully observable, hence not an alias.
5. Not touched (not my files): `ml/LOG.md`, `ml/CANONICAL.md` (AS*/MV* rules currently live as normative docstrings in `sampler.mjs`; they should be folded into CANONICAL.md by whoever owns it), `ml/README.md`, `ml/java/SampleAndRender.java` (superseded but left in place), meico-ts.

## files_changed
[
 "/Users/nielspfeffer/Projects/mpmify/ml/node/package.json",
 "/Users/nielspfeffer/Projects/mpmify/ml/node/paths.mjs",
 "/Users/nielspfeffer/Projects/mpmify/ml/node/java_random.mjs",
 "/Users/nielspfeffer/Projects/mpmify/ml/node/sampler.mjs",
 "/Users/nielspfeffer/Projects/mpmify/ml/node/xml.mjs",
 "/Users/nielspfeffer/Projects/mpmify/ml/node/augmented_msm.mjs",
 "/Users/nielspfeffer/Projects/mpmify/ml/node/generate_v4.mjs",
 "/Users/nielspfeffer/Projects/mpmify/ml/node/verify_v4.mjs",
 "/Users/nielspfeffer/Projects/mpmify/ml/data/pilot_v4.jsonl",
 "/Users/nielspfeffer/Projects/mpmify/ml/data/pilot_v4_espressivo.jsonl",
 "/Users/nielspfeffer/Projects/mpmify/ml/data/pilot_v4_exact.jsonl"
]

## validation_output
=== A. java.util.Random port (6 seeds x {nextDouble, nextInt(b), nextInt(), nextBoolean}) ===
JavaRandom parity: 180/180 exact, 0 mismatches

=== B. v3 SAMPLING+RENDER PORT: node --v3-compat --renderer java  vs  java SampleAndRender, seed 4242, 200 pieces ===
Done: 200 pieces, 10601 notes, 200 CC points via java in 2437 ms (sample 184 ms + render 2253 ms; 12.19 ms/piece, 82.1 pieces/s)
v3-compat: 200 node lines vs 200 java lines | scalar comparisons 89639 | differing 0 | max |diff| 0
    other                             1 compared,       0 differ
    header                          400 compared,       0 differ
    render.notes                  74407 compared,       0 differ
    sampling.tempo                 3395 compared,       0 differ
    sampling.dynamics              4004 compared,       0 differ
    sampling.articulation          5188 compared,       0 differ
    sampling.rubato                2244 compared,       0 differ
V3_COMPAT_PASS (0-diff, bit level)

=== C. CONTROL --probe-no-pow (60 pieces, 2 parts, tempo+asynchrony+movement, no transcendental call on the render path) ===
Done: 60 pieces, 7082 notes, 8320 CC points via espressivo in 4128 ms (sample 80 ms + render 4048 ms)
pieces 60 | notes 7082 | sustain CC points (part 1) 4160 | JSONL rendered by espressivo
scalar comparisons 133328 | differing 0 | beyond 2 ulp 0 | max |diff| 0 | max ulp 0
    structure                       900 compared,       0 differ,       0 beyond 2 ulp
    note.id                        7082 compared,       0 differ,       0 beyond 2 ulp
    note.date                      7082 compared,       0 differ,       0 beyond 2 ulp
    note.duration                  7082 compared,       0 differ,       0 beyond 2 ulp
    note.pitch                     7082 compared,       0 differ,       0 beyond 2 ulp
    note.velocity                  7082 compared,       0 differ,       0 beyond 2 ulp
    note.ms.date                   7082 compared,       0 differ,       0 beyond 2 ulp
    note.ms.end                    7082 compared,       0 differ,       0 beyond 2 ulp
    cc.position.date               8320 compared,       0 differ,       0 beyond 2 ulp
    cc.position.ms                 8320 compared,       0 differ,       0 beyond 2 ulp
    cc.position.value              8320 compared,       0 differ,       0 beyond 2 ulp
    jsonl.note.date                7082 compared,       0 differ,       0 beyond 2 ulp
    jsonl.note.duration            7082 compared,       0 differ,       0 beyond 2 ulp
    jsonl.note.pitch               7082 compared,       0 differ,       0 beyond 2 ulp
    jsonl.note.ms.date             7082 compared,       0 differ,       0 beyond 2 ulp
    jsonl.note.ms.end              7082 compared,       0 differ,       0 beyond 2 ulp
    jsonl.note.velocity            7082 compared,       0 differ,       0 beyond 2 ulp
    jsonl.note.part                7082 compared,       0 differ,       0 beyond 2 ulp
    jsonl.sustain_cc.ms            4160 compared,       0 differ,       0 beyond 2 ulp
    jsonl.sustain_cc.value         4160 compared,       0 differ,       0 beyond 2 ulp
render time: espressivo 4240 ms, java fork 2136 ms (incl. JVM startup)
CROSS_RENDERER_PASS (0-diff, bit level)

=== D. pilot_v4_exact.jsonl — 60 pieces, tempo+rubato+asynchrony+movement, 2 parts, espressivo-rendered ===
pieces 60 | notes 7082 | sustain CC points (part 1) 4114 | JSONL rendered by espressivo
scalar comparisons 132960 | differing 20 | beyond 2 ulp 0 | max |diff| 3.637978807091713e-12 | max ulp 1
    structure                       900 compared,       0 differ,       0 beyond 2 ulp
    note.id                        7082 compared,       0 differ,       0 beyond 2 ulp
    note.date                      7082 compared,       0 differ,       0 beyond 2 ulp
    note.duration                  7082 compared,       0 differ,       0 beyond 2 ulp
    note.pitch                     7082 compared,       0 differ,       0 beyond 2 ulp
    note.velocity                  7082 compared,       0 differ,       0 beyond 2 ulp
    note.ms.date                   7082 compared,       7 differ,       0 beyond 2 ulp
    note.ms.end                    7082 compared,       7 differ,       0 beyond 2 ulp
    cc.position.date               8228 compared,       0 differ,       0 beyond 2 ulp
    cc.position.ms                 8228 compared,       6 differ,       0 beyond 2 ulp
    cc.position.value              8228 compared,       0 differ,       0 beyond 2 ulp
    jsonl.note.date                7082 compared,       0 differ,       0 beyond 2 ulp
    jsonl.note.duration            7082 compared,       0 differ,       0 beyond 2 ulp
    jsonl.note.pitch               7082 compared,       0 differ,       0 beyond 2 ulp
    jsonl.note.ms.date             7082 compared,       0 differ,       0 beyond 2 ulp
    jsonl.note.ms.end              7082 compared,       0 differ,       0 beyond 2 ulp
    jsonl.note.velocity            7082 compared,       0 differ,       0 beyond 2 ulp
    jsonl.note.part                7082 compared,       0 differ,       0 beyond 2 ulp
    jsonl.sustain_cc.ms            4114 compared,       0 differ,       0 beyond 2 ulp
    jsonl.sustain_cc.value         4114 compared,       0 differ,       0 beyond 2 ulp
render time: espressivo 2788 ms, java fork 1235 ms (incl. JVM startup)
CROSS_RENDERER_ULP_PASS (20 values differ, all within 2 ulp — the fdlibm/libm pow-log divergence, LOG.md "Build-team wave 1"; no logic difference)

=== E. pilot_v4.jsonl — 60 pieces, ALL v4 maps, java-rendered.  JSONL lossless (0 diff); renderers disagree = espressivo E1/E2 ===
pieces 60 | notes 7082 | sustain CC points (part 1) 3769 | JSONL rendered by java
scalar comparisons 131040 | differing 5611 | beyond 2 ulp 5579 | max |diff| 6047.052232196598 | max ulp 30174117503382320
    structure                      1380 compared,       0 differ,       0 beyond 2 ulp
    note.id                        7082 compared,       0 differ,       0 beyond 2 ulp
    note.date                      7082 compared,       0 differ,       0 beyond 2 ulp
    note.duration                  7082 compared,       0 differ,       0 beyond 2 ulp
    note.pitch                     7082 compared,       0 differ,       0 beyond 2 ulp
    note.velocity                  7082 compared,    3989 differ,    3989 beyond 2 ulp     <- E1+E2
    note.ms.date                   7082 compared,      14 differ,       0 beyond 2 ulp     <- libm only
    note.ms.end                    7082 compared,    1606 differ,    1590 beyond 2 ulp     <- E1
    cc.channelVolume.date           120 compared,       0 differ,       0 beyond 2 ulp
    cc.channelVolume.ms             120 compared,       0 differ,       0 beyond 2 ulp
    cc.channelVolume.value          120 compared,       0 differ,       0 beyond 2 ulp
    cc.position.date               7538 compared,       0 differ,       0 beyond 2 ulp
    cc.position.ms                 7538 compared,       2 differ,       0 beyond 2 ulp
    cc.position.value              7538 compared,       0 differ,       0 beyond 2 ulp
    jsonl.note.ms.date             7082 compared,       0 differ,       0 beyond 2 ulp
    jsonl.note.ms.end              7082 compared,       0 differ,       0 beyond 2 ulp
    jsonl.sustain_cc.ms            3769 compared,       0 differ,       0 beyond 2 ulp
    jsonl.sustain_cc.value         3769 compared,       0 differ,       0 beyond 2 ulp
render time: espressivo 2603 ms, java fork 1037 ms (incl. JVM startup)
CROSS_RENDERER_FAIL
(all seven jsonl.note.* and both jsonl.sustain_cc.* classes are 0-diff: the JSONL is a lossless
 view of its own render. The FAIL is renderer-vs-renderer only.)

=== F. E1/E2 isolated on MEICO-SERIALIZED fixtures (ml/data/debug_v3), i.e. not caused by our XML ===
piece0: n=74 velocity-diff=6  msDate-diff=0 msEnd-diff=6   (dynamics transition present: false)
piece1: n=26 velocity-diff=16 msDate-diff=0 msEnd-diff=5   (dynamics transition present: true)
piece2: n=55 velocity-diff=14 msDate-diff=0 msEnd-diff=5   (dynamics transition present: true)
espressivo parse of <articulation date="0.0" relativeDuration="0.66" absoluteVelocityChange="20.5"/>:
  {"relativeDuration":1,"absoluteVelocityChange":0,"absoluteDurationChange":0, ...}      <- E1
espressivo parse of <dynamics date="14400.0" volume="94.2" transition.to="48.3" curvature="0.4" protraction="0.44"/>:
  {"volume":94.2,"transitionTo":48.3,"curvature":null,"protraction":null}                <- E2

=== G. Accentuation gate probe (10 pieces, --with-accentuation, --probe-no-pow; NOT shipped) ===
scalar comparisons 15468 | differing 482 | beyond 2 ulp 482 | max |diff| 8.859375
    note.velocity                   869 compared,     482 differ,     482 beyond 2 ulp
    note.ms.date                    869 compared,       0 differ,       0 beyond 2 ulp
    note.ms.end                     869 compared,       0 differ,       0 beyond 2 ulp
CROSS_RENDERER_FAIL
meico-ts src/mpm/elements/styles/defs/AccentuationPatternDef.ts:273
    if (i > this.accentuations.length - 1) segmentEnd = ...    <- dead guard, pre-TD3
meico/src/meico/mpm/elements/styles/defs/AccentuationPatternDef.java:317
    if (i < (this.accentuations.size() - 1))  segmentEnd = ... <- fixed at meico@1d662105
=> TD3 has NOT landed in the espressivo dist; accentuation stays default-OFF.

=== H. Canonical invariants on the shipped pilot (G3/G4/G6/G7/G8, T1-T3, A2/A3, R1-R6/R8, AS0-AS4, MV1-MV7) ===
invariants over 60 pieces: all canonical rules hold
realised domain:
    piece length beats   min 21 median 42 max 60
    bpm literals         min 25 median 79.2 max 238.7 (n=518)
    notes per beat       piece mean: min 1.97 median 2.77 max 3.78; busiest 1-beat window: median 9 max 15
    note durations       90:1231 180:1485 270:7 360:1454 450:8 540:470 630:2 720:1331 810:3 1080:11 1260:5 1440:830 1800:1 2160:1 2520:3 2880:240
    2-part pieces        60/60; with asynchrony 60; with movement 60; with rubato 44
    movement segments    min 2 median 4 max 24 beats; sustain CC points/piece median 61 total 3769
    asynchrony offsets   min -78 max 80 ms, n=131
INVARIANTS_PASS
(pilot_v4_exact.jsonl and pilot_v4_espressivo.jsonl: INVARIANTS_PASS as well)

=== I. Throughput (M1, nice -n 15, all v4 maps, 2 parts) ===
espressivo,  10 pieces: 1060 ms (sample   17 + render 1043) = 106.0 ms/piece
espressivo, 100 pieces: 7544 ms (sample   73 + render 7471) =  75.4 ms/piece, 13.3 pieces/s
java,        10 pieces: 1611 ms (sample   21 + render 1590) = 161.1 ms/piece  (JVM startup dominates)
java,       100 pieces: 2356 ms (sample  106 + render 2250) =  23.6 ms/piece, 42.4 pieces/s
  -> marginal java render (2250-1590)/90 = 7.3 ms/piece; JVM startup ~1.5 s
without movementMap, 100 pieces: java 2303 ms (23.0 ms/piece) | espressivo 5043 ms (50.4 ms/piece)
  -> movementMap costs ~0.7 ms/piece (java) vs ~25 ms/piece (espressivo), at movementSampleMaxStep=0.1

## open_issues
[
 "BLOCKER for espressivo as the labelling renderer: E1 `ArticulationMap.getArticulationDataOf` (meico-ts src/mpm/elements/maps/ArticulationMap.ts:103) never reads the 12 numeric modifier attributes Java reads -> literal articulations render as the identity; E2 `DynamicsMap.getDynamicsDataOf` (DynamicsMap.ts:100) never reads curvature/protraction -> every dynamics transition uses the wrong Bezier. Both reproduced on meico-serialized fixtures, both silent, neither is deliberate parity. Needs the meico-ts team (I did not touch their files). Until fixed, v4 datasets containing articulation or dynamics transitions MUST be generated with `--renderer java`.",
 "E3 / accentuation gate: meico-ts is still pre-TD3 (AccentuationPatternDef.ts:273 keeps the dead `i > length-1` guard, with an in-file comment saying so), although meico-ts@68d773c reads as 'TD3 ungated'. 482/869 velocities differ on a 10-piece probe. --with-accentuation therefore stays DEFAULT OFF and no accentuation supervision data was generated. Re-run `verify_v4.mjs cross` on the accentuation probe once TD3 actually lands to close the gate.",
 "1-2 ULP libm divergence (Java fdlibm vs macOS libm pow/log) remains on any path with a tempo transition or rubato: 14/7082 note.ms.date and 2/7538 CC ms on the full pilot, max |diff| 3.6e-12 ms. Not fixable from the generator side; the project's Python remedy (python/java_libm.py) has no JS counterpart. If the program ever needs cross-language bit-exactness including transitions, someone must port fdlibm e_pow/e_log to JS (or keep java as the labelling renderer, which is also 3x faster).",
 "movementMap is global, so meico renders one positionMap per MSM part and part 2's copy is part 1's shifted by the asynchrony offset - redundant, and it doubles the (espressivo-side expensive) pedal render. Consider making it part-1-local; JSONL and validation already only use part 1's stream.",
 "The v4 rules AS0-AS4 and MV1-MV7 currently live as normative docstrings in ml/node/sampler.mjs; ml/CANONICAL.md (not my file) needs them folded in, together with the AS3 justification (meico's Math.max(0.0, ms+offset) asynchrony clamp) and the movement terminator's `renderMovementToMap` skip-last semantics.",
 "sustain_cc is emitted exactly as the renderer produces it, including the duplicate points getMovementSegment always emits and the 3-identical-points-then-silence shape of a constant element. Downstream feature extraction needs last-wins state semantics (same as the Vienna ingest) and will probably want a de-duplication pass; deliberately NOT done in the generator so the JSONL stays a lossless view of the render.",
 "ml/README.md and ml/LOG.md are not my files and were not updated; the v4 generator, its flags and the three pilot files are undocumented there.",
 "ml/java/SampleAndRender.java is now superseded but left in place - it is still the reference the v3-compat proof diffs against, so it should not be deleted until the v4 generator is the sole producer."
]

# espressivo-gen — verify

## evidence
All checks run under `nice -n 15` on the live machine (load avg 22 — v3.1 training + meico-ts vitest concurrent). Scratchpad: /private/tmp/claude-501/-Users-nielspfeffer-Projects-mpmify/6a63bc22-2929-4ad2-81f9-fd90f7b0b835/scratchpad/v (my own files only; I touched none of team D's files, none of meico-ts, none of ml/).

CONFIRMED — everything numerical they claim reproduced, most of it independently and at different seeds:

(1) java.util.Random port. I wrote my own `RngDump.java` (7 seeds incl. a negative one, 40x nextDouble, nextInt(b) for b in {2,3,7,8,9,16,33,73,1000,2147483647} covering both the power-of-2 shortcut and the rejection branch, 20x nextInt(), 20x nextBoolean, then a 200-draw interleaved stream) and diffed against ml/node/java_random.mjs: **2030/2030 exact, 0 mismatches** — a superset of their 180/180.

(2) v3 sampling+render port. `node generate_v4.mjs … 100 4242 --v3-compat --renderer java` vs `java SampleAndRender … 100 4242 tempo,dynamics,articulation,rubato` → `V3_COMPAT_PASS`, **45,152 scalar comparisons, 0 differing, max |diff| 0** (render.notes 37,550 / sampling.tempo 1,675 / dynamics 2,008 / articulation 2,568 / rubato 1,150). Scales consistently with their 200-piece/89,639 figure. Note this proof is *stronger* than advertised: the node side is rendered from node-written XML through the Java fork and matches SampleAndRender's in-memory meico object graph bit-for-bit, so it also proves `xml.mjs` is a faithful serializer.

(3) probe-no-pow control, my seed 4242 (not theirs): `--maps tempo,asynchrony,movement --probe-no-pow --renderer espressivo`, 60 pieces/7251 notes → `CROSS_RENDERER_PASS`, **135,110 comparisons, 0 differ, max ulp 0**. Confirms 2-part scores, asynchronyMap (incl. its effect on the positionMap) and the whole movement Bézier→CC machinery are logic-identical across renderers.

(4) E1/E2 on meico-serialized fixtures, reproduced exactly to the digit: piece0 n=74 vel-diff 6, msDate 0, msEnd 6; piece1 n=26 / 16 / 0 / 5; piece2 n=55 / 14 / 0 / 5. Source-level confirmed: meico-ts `ArticulationMap.ts:getArticulationDataOf` stops after `name.ref` (its own docstring says the modifiers "live on the referenced articulationDef") while `ArticulationMap.java:310-356` reads twelve inline numeric attributes; `DynamicsMap.ts:getDynamicsDataOf` reads curvature/protraction only in the *no*-transition branch while `DynamicsMap.java:344-350` reads them via ensure*Boundaries in the transition branch.

(5) E3 gate. `AccentuationPatternDef.ts:273` still `i > this.accentuations.length - 1` (dead) vs Java `i < (size - 1)` at meico@1d662105. My 10-piece `--with-accentuation --probe-no-pow` probe: **836/1426 velocities differ, max 9.71**, timing 0-diff. Gate correctly closed; `--with-accentuation` is default OFF and warns on stderr.

(6) Shipped-artifact blast radius, pilot_v4 vs pilot_v4_espressivo (maps byte-identical, so same seed/config): velocity 3989/7082, ms.end 1606/7082, ms.date 14/7082, sustain_cc 1/3769 — exactly their numbers.

(7) Strongest independent check I ran: I rebuilt MSM+MPM **from pilot_v4.jsonl's labels alone** (my own script, using only xml.mjs/augmented_msm.mjs as helpers) and re-rendered with the Java fork → 7082 notes, **msDate diff 0, msEnd diff 0, velocity diff 0, 3769/3769 CC points 0 diff**. The shipped file is genuinely java-rendered, and label→render is exactly reproducible from the JSONL with no hidden state.

(8) `verify_v4.mjs invariants` INVARIANTS_PASS on all three shipped pilots; realised-domain table reproduces line-for-line.

(9) AS3 rationale verified in source (`AsynchronyMap.java` `startDateMs = Math.max(0.0, … + offset)`), and empirically: part 1's positionMap starts at ms 0, part 2's at ms 15 (= its offset) — so `sustain_cc` really is the un-offset stream.

(10) Domain-randomization arithmetic checked against the code: segSpan = segMax−3 ⇒ tempo boundary step 4..6 / 4..8 / 4..12 / 4..16 (means 5/6/8/10) vs v3's 4..16 — the "up to 2× density" claim is right; piece length `16 + nextInt(49)` = 16..64; bpm log-uniform [25,240]; grid/dense/chord probabilities match the DOMAIN table.

Files exist, all seven .mjs pass `node --check`, both renderers import/execute cleanly, `--print-domain`, `--two-part-prob 0 --movement-prob 0`, and `--renderer java|espressivo` all work.

KEY REPRO COMMANDS FOR THE ISSUES:
- I1: `node generate_v4.mjs X 60 4242 --maps tempo,rubato,asynchrony,movement --renderer espressivo --dump-dir D` then `node verify_v4.mjs cross X D espressivo` → `CROSS_RENDERER_FAIL`, `piece19.p0.n23.ms.date: 3766.7262448526417 !== 3766.7262448526403 (3 ulp)`. Deterministic (re-ran identical). Seed 777, same config: max ulp 2, passes.
- I3: on pilot_v4.jsonl, `last CC value` vs `movement[-1][1]`: piece0 final position 0.67, last CC 69.85 (=0.55·127 = previous segment's end).
- I4: pilot_v4 sustain_cc → 3741/3769 values non-integer; vienna_infer.jsonl sustain_cc → 0/3385 non-integer, range 1..127.
- I5: 5 pieces, `--movement-max-step 0.5 --renderer java` → CC counts 36,49,42,62,50; `--movement-max-step 0.1 --renderer java` → identical 36,49,42,62,50; `--movement-max-step 0.5 --renderer espressivo` → 23,28,22,33,29. `grep -c movementSampleMaxStep ml/java/RenderMpm.java` = 0.
- I6: `--maps tempo,dynamcs` → runs clean, `dynamics` length 0,0,0, no warning.
- I8: empty-manifest JVM startup measured at 0.17–0.19 s (not ~1.5 s); 100 pieces java end-to-end 2942 ms (29.4 ms/piece), 10 pieces 563 ms ⇒ marginal (2799−539)/90 = 25.1 ms/piece.

## issues
[
 "I1 (HIGH \u2014 the verification gate itself is unsound). `verify_v4.mjs` hard-codes ULP_ENVELOPE = 2 and turns any larger difference into CROSS_RENDERER_FAIL. The bound is asserted, not derived: the stated reasoning ('an onset passes through at most two pow calls in series, so 2 ULP') ignores that the tempo integration accumulates over segments. It is exceeded in practice. Running exactly the pilot_v4_exact configuration at seed 4242 (60 pieces, tempo+rubato+asynchrony+movement, espressivo) I get a deterministic CROSS_RENDERER_FAIL: piece19.p0.n23.ms.date 3766.7262448526417 vs 3766.7262448526403 = 3 ULP, 1 of 7251. Seed 777 passes with max ulp 2. So roughly half of all 60-piece runs fail, and a 20k-piece generation gate fails with certainty. The magnitude (1.4e-12 ms) is harmless; the gate is not. Their 'max ulp 1, beyond 2 ulp 0' on pilot_v4_exact is a seed-lucky sample, not a property.",
 "I2 (HIGH \u2014 the shipped pilot is off-domain w.r.t. the normative doc, which landed the same minute). ml/CANONICAL.md (mtime 10:46; their files 10:17\u201310:47) already defines v4 movement as rules M1\u2013M10 (\u00a79) and asynchrony as Y1\u2013Y6 (\u00a710), not MV*/AS*. Material conflicts, not just naming: (a) M4 requires positions on the 128-value CC alphabet, round(127\u00b7p)/127 \u2014 the sampler draws 2-decimal positions in [0,1], off-alphabet; (b) M3 requires a 1/4-beat grid (180 ticks) with segments >= 180 ticks \u2014 the sampler uses whole beats with segments >= 2 beats, so the data can never contain a sub-beat pedal boundary, which is what real pedalling needs; (c) M9 requires curvature/protraction to be OMITTED when equal to meico's defaults 0.4/0.0 (writing them is a pure alias) \u2014 the sampler always writes both on a transition; (d) Y3 caps |offset| at 60 ms with a (-5,5) deadband \u2014 AS2 samples [8,80], out of range at both ends. Only AS0/AS3 map cleanly onto Y1/Y5. Their open_issue #5 ('CANONICAL.md needs AS*/MV* folded in') assumes the doc is silent; it is not, it disagrees. Reconcile before any large generation, or 20k pieces get regenerated.",
 "I3 (HIGH \u2014 unlearnable labels in the shipped pilot, from their own rule MV3). MV3 makes the final movement element inert but, unlike G7 (last tempo constant) and R6 (rubato terminator intensity = 1.0), does not force it NEUTRAL: the terminator's `position` is drawn with the same 60%-continuity / 40%-jump rule as any other boundary. Measured on pilot_v4.jsonl: in 32/60 pieces the final movement element's position differs from the previous segment's end value and has ZERO footprint in the rendered CC stream (piece0: final position 0.67, last CC value 69.85 = 0.55\u00b7127; piece1: 0.62 vs last CC 34.29 = 0.27\u00b7127; \u2026). In 21/60 pieces the preceding element is a constant too, so the final element's DATE is unobservable as well. Separately, the MV7 merge can delete the piece-end terminator outright: in 24/60 pieces the movement chain stops before the last note, by up to 17 beats \u2014 which also contradicts MV3's own 'chain ends on a constant at the piece end' and CANONICAL M1. `verify_v4.mjs invariants` checks only that the last instruction is not a transition, so none of this is caught.",
 "I4 (HIGH \u2014 sim2real schema drift on the new `sustain_cc` field). Synthetic sustain_cc carries the raw positionMap doubles: 3741/3769 values in pilot_v4.jsonl are non-integer (e.g. 69.85000000000001). The real Vienna corpus writes the SAME KEY NAME with integer MIDI values: 0/3385 non-integer in vienna_infer.jsonl, range 1..127. The actual MIDI observable is `Math.round` (Msm.java:1113, `int value = Math.round(Float.parseFloat(...))`), and CANONICAL M4 says so explicitly. Their 'lossless view of the render' rationale is defensible for the render but makes the field non-transferable: a v4 pedal model trained on synthetic streams sees a value distribution that cannot occur in real data \u2014 the same class of domain gap LOG.md blames for v1's Vienna transfer failure.",
 "I5 (MEDIUM \u2014 silent no-op flag on the shipped code path). `--movement-max-step` is plumbed only into the espressivo call (`performMsmToData(..., {movementSampleMaxStep})`). The `--renderer java` path \u2014 the one the report recommends and used for pilot_v4 \u2014 never sets `MovementMap.movementSampleMaxStep` (a public static in meico, 0 references in ml/java/RenderMpm.java), so the flag is silently ignored. Demonstrated: 5 pieces, java at 0.5 and at 0.1 both emit CC counts 36,49,42,62,50; espressivo at 0.5 emits 23,28,22,33,29. Consequences: a java dataset generated with a non-default step silently carries 0.1, and any cross-renderer check at a non-default step reports a spurious structural FAIL that would be misread as a logic divergence. Currently masked only because the default happens to be meico's default.",
 "I6 (MEDIUM \u2014 silent fallback). `--maps` is matched with `String.includes` and never validated. `--maps tempo,dynamcs` (typo) runs to completion, emits no warning, and produces a dataset with an empty dynamicsMap (verified: dynamics length 0,0,0 over 3 pieces). Any misspelling silently drops that map's supervision; and because the omitted map's draws are skipped, the RNG stream shifts too, so the result is not even comparable to the intended run.",
 "I7 (MEDIUM \u2014 the headline proof is not reproducible from the report as written). The report's v3-compat claim is 'node --v3-compat --renderer java vs java SampleAndRender at the same seed'. `SampleAndRender`'s optional [maps] argument defaults to TEMPO ONLY. Run literally as reported, the comparison FAILS: 39,726 comparisons, 9,104 differing (I hit this first: java velocities all 100, dynamics/articulation/rubato arrays empty). The correct invocation needs `tempo,dynamics,articulation,rubato`, which is recorded nowhere \u2014 not in the report, not in verify_v4.mjs's usage text, not in a script. A one-line runner or a docstring note would make the proof re-runnable.",
 "I8 (MEDIUM \u2014 throughput claim not reproducible; affects v4 planning). Reported: java marginal 7.3 ms/piece, 23.6 ms/piece end-to-end at 100 pieces, 'JVM startup ~1.5 s', '20k-piece v4 set ~2.8 min'. I measure JVM+meico startup for an empty batch at 0.17\u20130.19 s, not ~1.5 s, and 100 pieces end-to-end at 2942 ms = 29.4 ms/piece with marginal (t100\u2212t10)/90 = 25.1 ms/piece \u2014 i.e. ~10 min for 20k, not 2.8. My machine is under load avg 22 (the v3.1 training plus meico-ts' vitest), so this is a floor-vs-ceiling difference rather than a contradiction, but their derivation of the 7.3 ms figure back-solves a 1.5 s startup that the direct measurement does not support. Treat 2.8 min as a best-case idle-machine number.",
 "I9 (LOW \u2014 silent swallow + dormant fallbacks). `quiet()` in generate_v4.mjs replaces BOTH console.log and console.error for the entire render loop, so any espressivo warning (parse failure, defaulted attribute) is discarded for every piece with no record. It pairs with augmented_msm.mjs's silent defaults \u2014 `velocity ?? 100`, `milliseconds.date ?? date`, `milliseconds.date.end ?? date+duration`, and `section()` locating `<score>` / `<positionMap>` / `<channelVolumeMap>` by exact attribute-less tag (returning '' or null otherwise, i.e. zero notes or a dropped CC stream). I verified all of these are currently dormant (the Java render always writes velocity and milliseconds.date, and emits attribute-less tags; espressivo's pipeline.ts:250 uses the same `?? 100`), so this is a latent-degradation risk, not a live defect \u2014 but on the java path a dropped positionMap would surface as a silently empty `sustain_cc`, not an error.",
 "I10 (LOW \u2014 invariants coverage gaps). `verify_v4.mjs invariants` does not check: G8 merge for tempo/dynamics/movement (only AS4 for asynchrony), G6 decimal places on dynamics volume, that the movement chain reaches the piece end (see I3), or that the rubato terminator inherits frameLength. It derives piece length from note ends rather than totalTicks, so it cannot detect a map that runs past or stops short of the sampled piece length \u2014 which is exactly how the I3 terminator loss slips through.",
 "I11 (LOW \u2014 cross-team row-shape drift on the movement row). Team E's ml/python/validate_v4.py specifies movement rows as 6-tuples including the controller (`[0, 0.6, None, None, None, \"sustain\"]`); team D's JSONL movement rows are 5-tuples with no controller field; CANONICAL \u00a711's DSL has no controller token but M7 admits both \"sustain\" and \"soft\". Three shapes in flight. If soft-pedal chains land in v5, D's JSONL row has nowhere to put the controller. Worth freezing the row shape now, while only 60 pilot pieces exist.",
 "I12 (LOW \u2014 provenance framing). The report and the ESPRESSIVO_DEFECTS docstring pin the finding to 'espressivo 0.11.2 (meico-ts@68d773c, dist built today 10:30)'. meico-ts package.json says 0.8.8 (0.11.2 is the exported meico-tracking VERSION in their README), HEAD is now f788c93 with 20+ modified files including AccentuationPatternDef.ts (mtime 10:35), and dist/api/pipeline.js was rebuilt at 10:40 \u2014 i.e. after the cited commit. The dist is a live, concurrently-edited artifact, so E1/E2/E3 are findings against a moving target. I re-confirmed all three against the current src AND the current dist, so the substance stands, but the pinned-commit framing is not accurate and a re-check is needed at whatever commit the meico-ts team finally freezes."
]

## verdict
ISSUES

# espressivo-gen — fixed

## report
## Team D fix round — all 12 issues resolved, revalidated

Every issue is fixed in `ml/node/` only. `java_random.mjs`, `paths.mjs`, `package.json` were correct and are untouched; the three pilot JSONLs are regenerated because the sampler changed.

| # | disposition |
|---|---|
| **I1** verification gate unsound | **Fixed by derivation.** See below — plus a field-class tightening the review did not ask for. |
| **I2** off-domain vs CANONICAL §9/§10 | **Fixed.** M3, M4, M9, Y3 adopted; MV*/AS* numbering deleted. |
| **I3** unlearnable terminator labels | **Fixed**, and the fix is *forced*, not chosen. |
| **I4** sim2real drift on `sustain_cc` | **Fixed.** 0/12219 non-integer, range 0..127 — matches Vienna's 0/312380, 0..127. |
| **I5** silent `--movement-max-step` no-op | **Fixed.** Hard error on the java path. |
| **I6** `--maps` typo silently drops a map | **Fixed.** Split + validated against `KNOWN_MAPS`. |
| **I7** headline proof not reproducible | **Fixed.** New `verify_v4.mjs v3proof <n> <seed> <dir>` runs both generators itself. |
| **I8** throughput not reproducible | **Re-measured.** Reviewer was right; numbers below. |
| **I9** silent swallow + dormant fallbacks | **Fixed.** Console captured and classified; `augmented_msm.mjs` throws instead of defaulting. |
| **I10** invariants coverage gaps | **Fixed.** +G8 on three maps, +G6 on dynamics/meanTempoAt, +chain-reaches-piece-end via new `total_ticks`, +rubato terminator frameLength. |
| **I11** movement row-shape drift | **Fixed.** 6-tuple with controller, matching `python/validate_v4.py`. |
| **I12** provenance framing | **Fixed** — and re-checking found **E3 is now FIXED upstream**. |

### I1 — the gate, derived instead of asserted

The old `ULP_ENVELOPE = 2` came from "an onset passes through ≤2 `pow` calls in series". Wrong premise: a millisecond date is an **accumulated sum**, `ms = Σ_{i<s} computeDiffTiming(segment i) + computeDiffTiming(partial s)` (`TempoMap.renderTempoToMap:384-404`), one Simpson integral with its own `Math.pow` per tempo instruction. `k` terms, each independently ≤1 libm ULP off ⇒ the sum is off by ~`k` ULP. Reproduced the reviewer's failure first (seed 4242: `piece19.p0.n23.ms.date`, 3 ULP, `CROSS_RENDERER_FAIL`).

Replaced with **two independent constraints, both derived**:

1. **ULP budget `4·(1 + #tempo + rubato?)`**, per piece, from the record itself. The 4 is the standard bound for a positive sum of `k` terms each carrying ≤1 ULP relative error (rel ≤ `k·2⁻⁵² + k·2⁻⁵³`; a ULP step is 1–2 units of `2⁻⁵²` relative ⇒ ≤3k, rounded to 4k).
2. **Magnitude ≤ 1e-6 ms**, unit-ful, non-scaling — so a long tempo map cannot buy a real bug slack. The constant sits in a *measured* gap: on the 60-piece all-maps pilot the libm population tops out at **3.64e-12 ms** (n=8) and the smallest genuine logic divergence (E1's dropped articulation) is **0.0167 ms** (n=5635, median 10, max 5395). 1e-6 is 4.6 orders above one and 4.2 below the other.

**Additional tightening:** only `note.ms.date`, `note.ms.end`, `cc.*.ms` get *any* envelope. Everything else — velocities, CC values, tick dates, pitches, and **all** `jsonl.*` fields — must be bit-exact. Justified by grepping meico: the only transcendentals on the in-scope render path are `TempoMap:299,336` and `RubatoMap:336`; `DynamicsData`'s `Math.pow` lines are commented out, so dynamics/movement Béziers are pure arithmetic. The old gate would have accepted a 2-ULP *velocity* difference. `jsonl.*` is compared against the render that produced it, so a difference there is a serialization bug and never libm.

Seed sweep (6 seeds, the reviewer's own reproduction case included): 6/6 pass, worst observed/budget **0.188** — 5.3× headroom, where the old constant failed roughly half the time.

### I2 — reconciled with CANONICAL.md §9/§10

The private MV*/AS* rules are gone. Four were not renames but **disagreements**, all resolved in the document's favour:

| was | now | consequence in the data |
|---|---|---|
| MV1 2-dp positions in [0,1] | **M4** `round(127·p)/127` | positions drawn as `k/127`, `k = nextInt(128)`; verified 0 off-alphabet |
| MV2 whole beats, ≥2-beat segments | **M3** 1/4-beat grid (180 ticks), segments ≥180 | segment lengths drawn in 1/4-beat units `{1,2,3,4,6,8,12,16}` p=`{.10,.16,.16,.18,.14,.12,.08,.06}` (mean 1.25 beats). Realised: min 180 / median 720 / max 6480 ticks, n=1721 over 60 pieces |
| MV6 always writes curvature/protraction | **M9** omit at the 0.4/0.0 defaults | done in `xml.mjs`; exercised 12×/8× in the pilot and 8×/8× inside a **bit-exact** control run, so both renderers' defaults are proven equal, not assumed |
| AS2 \|offset\| ∈ [8,80] | **Y3** [5,60], deadband (−5,5) | realised −58..59 ms |

Depth/jump floors moved to CC units (≥19 ≈ 0.15, ≥13 ≈ 0.10) so M5 non-degeneracy is checked on the observable. AS0→Y1 and AS3→Y5 map over unchanged.

### I3 — the terminator rule is forced, not preferred

The reviewer found the terminator's position freshly drawn (32/60 pieces carried a label with zero CC footprint) and the G8 merge deleting it outright (24/60 chains stopped short). The fix follows from `renderMovementToMap` skipping the last element:

- terminator **neutral** — position is the value already in force, never a draw;
- neutrality ⇒ if the element before it were a constant, the two are adjacent equal constants ⇒ G8 either deletes the terminator (the observed bug) or needs an exemption written for it. The way out is that **the last rendering element is always a ramp** (`rng.nextDouble() < 0.55 || i === last`, `||` short-circuits so the RNG stream is unshifted). Then the terminator's date is observable (it ends that ramp), its position determined, and G8 needs no exemption.

This also makes CANONICAL §12 step 16 ("append a terminator *if* the last instruction has a `transition.to`") a fixed point instead of a contradiction with G8. Measured on the new pilot: terminator position ≠ value in force **0/60**; chain ends before the piece **0/60**; terminator preceded by a constant **0/60**.

### I4 — `sustain_cc` is the MIDI observable

`Math.round(value)` per `Msm.parsePositionMap` (`Msm.java:1113`) and CANONICAL M4. Synthetic **0/12219 non-integer, 0..127**; real `vienna_infer.jsonl` **0/312380 non-integer, 0..127**. Losslessness is still checked — against `Math.round(point.value)` — so the JSONL remains a faithful view of *the observable*, which is the transferable thing.

### I9 — captured, classified, and no more silent defaults

`quiet()` → `captureConsole()`: messages matching known espressivo progress patterns are counted (`"espressivo: 300 progress message(s), all recognised."`), anything else is reported in full as `WARNING: … UNRECOGNISED`. In `augmented_msm.mjs`, `velocity ?? 100` / `ms ?? date` / `ms.end ?? date+dur` are replaced by `req()`, which throws — an unperformed note on the java path is now an error, not plausible-looking data. `section()` was matching the literal `<name>`; it now handles attributes and the self-closing form (which meico emits), so a `<positionMap/>` can no longer read as "absent" and yield a silently empty `sustain_cc`.

### I8 — throughput, re-measured (M1, `nice -n 15`, load avg 16–20, i.e. **not** an idle machine)

| stage | 10 pieces | 100 pieces | marginal |
|---|---|---|---|
| java end-to-end | 815 ms (81.5/pc) | **2372 ms (23.7 ms/pc)** | 17.3 ms/pc |
| espressivo end-to-end | 1878 ms | 18734 ms (187.3 ms/pc) | — |
| JVM+meico startup, empty batch ×5 | **0.09–0.23 s** (not ~1.5 s) | | |
| java, no movementMap | | 2119 ms (21.2 ms/pc) | movement ≈ **2.3 ms/pc** |
| espressivo, no movementMap | | 4106 ms (41.1 ms/pc) | movement ≈ **146 ms/pc** |

20k v4 pieces via java ≈ **7.4 min under load**; the earlier "2.8 min" back-solved a 1.5 s startup that direct measurement does not support. M3's finer grid raised espressivo's pedal cost ~6× (25→146 ms/pc); java absorbs it. Java stays the labelling renderer on both correctness (E1/E2) and cost grounds.

### I12 — provenance, and the E3 finding reversed

meico-ts moved **68d773c → f788c93 → 8283853 → 415bbd2** during this session with `dist/` rebuilt three times, so `ESPRESSIVO_DEFECTS` now pins a *state* (HEAD 415bbd2 + dirty tree, dist built 11:29; Java fork 1d662105), not a commit, and says why. Re-checking at that state:

- **E1 live** — `ArticulationMap.getArticulationDataOf` still stops after `name.ref`. (The `relativeDuration` hits in the built `dist/…/ArticulationMap.js` are in `addArticulation`, the *serializer* — worth recording, it is an easy false clear.)
- **E2 live** — `DynamicsMap.getDynamicsDataOf` still ignores `curvature`/`protraction`.
- **E3 FIXED** — TD3 landed (`AccentuationPatternDef.ts:272` now `i < size - 1`). Verified, not assumed: 20 pieces / 2679 notes render **bit-identically** in both renderers *and* the map is non-vacuous (accentuation moves **2679/2679** velocities by up to 13.04 units vs the same seed with the flag off). `--with-accentuation` still defaults OFF and **no accentuation supervision data was generated** — the technical gate is met, the program decision is the orchestrator's.

### Other changes worth knowing

- JSONL gains **`total_ticks`** (v4 rows only; `--v3-compat` output is byte-unchanged). Without it a validator cannot distinguish "map ends with the piece" from "map stops short" — exactly how I3 slipped through.
- `jd()` no longer byte-matches Java's `Double.toString` for M4's `k/127` positions (JDK ≤18 emits an extra digit for some values; `String(v)` is shortest-round-trip). Harmless and documented: nothing diffs this text against meico's serialization, both parsers are correctly rounded, and the bit-exact control run proves it end to end — an off-by-one-ULP position would move CC values.
- `verify_v4.mjs` now imports the movement constants from `sampler.mjs`, so rule and checker cannot drift apart.


## files_changed
[
 "/Users/nielspfeffer/Projects/mpmify/ml/node/sampler.mjs",
 "/Users/nielspfeffer/Projects/mpmify/ml/node/xml.mjs",
 "/Users/nielspfeffer/Projects/mpmify/ml/node/augmented_msm.mjs",
 "/Users/nielspfeffer/Projects/mpmify/ml/node/generate_v4.mjs",
 "/Users/nielspfeffer/Projects/mpmify/ml/node/verify_v4.mjs",
 "/Users/nielspfeffer/Projects/mpmify/ml/data/pilot_v4.jsonl",
 "/Users/nielspfeffer/Projects/mpmify/ml/data/pilot_v4_exact.jsonl",
 "/Users/nielspfeffer/Projects/mpmify/ml/data/pilot_v4_espressivo.jsonl"
]

## validation_output
=== 0. I1 REPRODUCED FIRST, on the pre-fix code (60 pieces, seed 4242, pilot_v4_exact config) ===
    jsonl.sustain_cc.value         3973 compared,       0 differ,       0 beyond 2 ulp
render time: espressivo 5378 ms, java fork 1803 ms (incl. JVM startup)
  FAIL piece19.p0.n23.ms.date: 3766.7262448526417 !== 3766.7262448526403 (3 ulp)
CROSS_RENDERER_FAIL

=== A. java.util.Random port: 6 seeds x {nextDouble, nextInt(b) for b in 2,3,16,73,128,1000, nextInt(), nextBoolean} ===
JavaRandom parity: 270/270 draws byte-identical, 0 mismatches

=== B. v3 SAMPLING+RENDER PORT, now reproducible in ONE command (verify_v4.mjs v3proof) ===
[v3proof] 200 pieces, seed 4242, maps tempo,dynamics,articulation,rubato
v3-compat: 200 node lines vs 200 java lines | scalar comparisons 89639 | differing 0 | max |diff| 0
    other                             1 compared,       0 differ,       0 not bit-exact 
    header                          400 compared,       0 differ,       0 not bit-exact 
    render.notes                  74407 compared,       0 differ,       0 not bit-exact 
    sampling.tempo                 3395 compared,       0 differ,       0 not bit-exact 
    sampling.dynamics              4004 compared,       0 differ,       0 not bit-exact 
    sampling.articulation          5188 compared,       0 differ,       0 not bit-exact 
    sampling.rubato                2244 compared,       0 differ,       0 not bit-exact 
V3_COMPAT_PASS (0-diff, bit level)

=== C. CONTROL --probe-no-pow (60 pieces, 2 parts, tempo+asynchrony+movement; no transcendental on the render path) ===
Done: 60 pieces, 7251 notes, 25104 CC points via espressivo in 13117 ms (sample 117 ms + render 13000 ms; 218.62 ms/piece, 4.6 pieces/s)
pieces 60 | notes 7251 | sustain CC points (part 1) 12552 | JSONL rendered by espressivo
scalar comparisons 202830 | differing 0 | out of envelope 0 | max |diff| 0 | max ulp 0
ulp budget 4*(1 + #tempo + rubato?): min 8 max 52; worst observed/budget 0.000; |diff| tolerance 0.000001 ms, worst 0.00e+0 of it
    structure                       900 compared,       0 differ,       0 not bit-exact 
    note.id                        7251 compared,       0 differ,       0 not bit-exact 
    note.date                      7251 compared,       0 differ,       0 not bit-exact 
    note.duration                  7251 compared,       0 differ,       0 not bit-exact 
    note.pitch                     7251 compared,       0 differ,       0 not bit-exact 
    note.velocity                  7251 compared,       0 differ,       0 not bit-exact 
    note.ms.date                   7251 compared,       0 differ,       0 out of envelope
    note.ms.end                    7251 compared,       0 differ,       0 out of envelope
    cc.position.date              25104 compared,       0 differ,       0 not bit-exact 
    cc.position.ms                25104 compared,       0 differ,       0 out of envelope
    cc.position.value             25104 compared,       0 differ,       0 not bit-exact 
    jsonl.note.date                7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.duration            7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.pitch               7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.ms.date             7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.ms.end              7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.velocity            7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.part                7251 compared,       0 differ,       0 not bit-exact 
    jsonl.sustain_cc.ms           12552 compared,       0 differ,       0 not bit-exact 
    jsonl.sustain_cc.value        12552 compared,       0 differ,       0 not bit-exact 
render time: espressivo 11426 ms, java fork 3225 ms (incl. JVM startup)
CROSS_RENDERER_PASS (0-diff, bit level)
  -> this run contains 2 parts, asynchrony, the full M3/M4/M9 movement machinery incl. 8 curvature
     and 8 protraction omissions at the meico defaults, and M4's 17-digit k/127 positions. Bit-exact.

=== D. pilot regeneration (final code) ===
Done: 60 pieces, 7251 notes, 24558 CC points via java in 4475 ms -> ml/data/pilot_v4.jsonl
Done: 60 pieces, 7251 notes, 24258 CC points via espressivo in 21523 ms -> ml/data/pilot_v4_exact.jsonl
WARNING: at the meico-ts state recorded in ESPRESSIVO_DEFECTS, espressivo renders articulation as the identity (E1) and ignores dynamics curvature/protraction (E2). Use --renderer java for correct labels, or re-check E1/E2 if meico-ts has moved.
Done: 60 pieces, 7251 notes, 24558 CC points via espressivo in 24004 ms -> ml/data/pilot_v4_espressivo.jsonl

=== E. pilot_v4_exact.jsonl -- 60 pieces, tempo+rubato+asynchrony+movement, 2 parts, espressivo-rendered ===
     (this is the exact configuration + seed that FAILED the old gate; see block 0)
pieces 60 | notes 7251 | sustain CC points (part 1) 12129 | JSONL rendered by espressivo
scalar comparisons 199446 | differing 38 | out of envelope 0 | max |diff| 7.275957614183426e-12 | max ulp 3
ulp budget 4*(1 + #tempo + rubato?): min 8 max 56; worst observed/budget 0.107; |diff| tolerance 0.000001 ms, worst 7.28e-6 of it
    structure                       900 compared,       0 differ,       0 not bit-exact 
    note.id                        7251 compared,       0 differ,       0 not bit-exact 
    note.date                      7251 compared,       0 differ,       0 not bit-exact 
    note.duration                  7251 compared,       0 differ,       0 not bit-exact 
    note.pitch                     7251 compared,       0 differ,       0 not bit-exact 
    note.velocity                  7251 compared,       0 differ,       0 not bit-exact 
    note.ms.date                   7251 compared,       8 differ,       0 out of envelope
    note.ms.end                    7251 compared,      10 differ,       0 out of envelope
    cc.position.date              24258 compared,       0 differ,       0 not bit-exact 
    cc.position.ms                24258 compared,      20 differ,       0 out of envelope
    cc.position.value             24258 compared,       0 differ,       0 not bit-exact 
    jsonl.note.date                7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.duration            7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.pitch               7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.ms.date             7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.ms.end              7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.velocity            7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.part                7251 compared,       0 differ,       0 not bit-exact 
    jsonl.sustain_cc.ms           12129 compared,       0 differ,       0 not bit-exact 
    jsonl.sustain_cc.value        12129 compared,       0 differ,       0 not bit-exact 
render time: espressivo 16593 ms, java fork 3044 ms (incl. JVM startup)
CROSS_RENDERER_ULP_PASS (38 values differ, every one inside its piece's derived libm envelope and 1e-5 of the magnitude tolerance — the fdlibm/libm pow-log divergence, LOG.md "Build-team wave 1"; no logic difference)

=== F. pilot_v4.jsonl -- ALL v4 maps, java-rendered. JSONL lossless (0 diff); renderers disagree = espressivo E1/E2 ===
pieces 60 | notes 7251 | sustain CC points (part 1) 12219 | JSONL rendered by java
scalar comparisons 201006 | differing 5664 | out of envelope 5635 | max |diff| 5395.348837209302 | max ulp 28288235159420930
ulp budget 4*(1 + #tempo + rubato?): min 12 max 56; worst observed/budget 242025832247420.094; |diff| tolerance 0.000001 ms, worst 5.40e+9 of it
    structure                      1380 compared,       0 differ,       0 not bit-exact 
    note.id                        7251 compared,       0 differ,       0 not bit-exact 
    note.date                      7251 compared,       0 differ,       0 not bit-exact 
    note.duration                  7251 compared,       0 differ,       0 not bit-exact 
    note.pitch                     7251 compared,       0 differ,       0 not bit-exact 
    note.velocity                  7251 compared,    4053 differ,    4053 not bit-exact      <- E1+E2
    note.ms.date                   7251 compared,       9 differ,       0 out of envelope    <- libm only
    note.ms.end                    7251 compared,    1590 differ,    1582 out of envelope    <- E1 (8 are libm)
    cc.channelVolume.date           120 compared,       0 differ,       0 not bit-exact 
    cc.channelVolume.ms             120 compared,       0 differ,       0 out of envelope
    cc.channelVolume.value          120 compared,       0 differ,       0 not bit-exact 
    cc.position.date              24438 compared,       0 differ,       0 not bit-exact 
    cc.position.ms                24438 compared,      12 differ,       0 out of envelope
    cc.position.value             24438 compared,       0 differ,       0 not bit-exact 
    jsonl.note.date                7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.duration            7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.pitch               7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.ms.date             7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.ms.end              7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.velocity            7251 compared,       0 differ,       0 not bit-exact 
    jsonl.note.part                7251 compared,       0 differ,       0 not bit-exact 
    jsonl.sustain_cc.ms           12219 compared,       0 differ,       0 not bit-exact 
    jsonl.sustain_cc.value        12219 compared,       0 differ,       0 not bit-exact 
render time: espressivo 8940 ms, java fork 1761 ms (incl. JVM startup)
  FAIL piece0.p0.n3.velocity: 87.8 !== 106.8 (1337006139375616 ulp, budget 0, |diff| 19)
CROSS_RENDERER_FAIL
(all nine jsonl.* classes 0-diff: the JSONL is a lossless view of its own render. The FAIL is renderer-vs-renderer only.)

=== F2. The two difference populations, measured (this is where ABS_TOLERANCE_MS = 1e-6 comes from) ===
nonzero diffs 5643; libm-scale (<1e-9) 8, largest of those 3.637978807091713e-12
logic-scale diffs: n=5635, min 0.016688967915243325, median 10, max 5395.348837209302
  -> 1e-6 ms sits 4.6 orders above the largest libm difference and 4.2 orders below the smallest logic one.

=== G. Canonical invariants on all three pilots (G3/G4/G6/G7/G8, T1-T3, D1, A2/A3, R1-R8, Y1-Y5, M1-M9) ===
--- pilot_v4.jsonl ---
invariants over 60 pieces: all canonical rules hold
realised domain:
    piece length beats   min 16 median 43 max 64
    bpm literals         min 25.2 median 73.3 max 238 (n=510)
    notes per beat       piece mean: min 1.53 median 2.82 max 3.64; busiest 1-beat window: median 9 max 15
    note durations       90:1337 180:1485 270:11 360:1514 450:7 540:464 630:1 720:1306 810:1 900:1 1080:5 1170:4 1350:1 1440:872 1800:1 2160:8 2520:3 2880:230
    2-part pieces        60/60; with asynchrony 60; with movement 60; with rubato 45
    movement segments    min 180 median 720 max 6480 ticks (n=1721, 1/4 beat = 180); sustain CC points/piece median 203 total 12219
    asynchrony offsets   min -58 max 59 ms, n=125
INVARIANTS_PASS
--- pilot_v4_exact.jsonl ---
invariants over 60 pieces: all canonical rules hold
    movement segments    min 180 median 720 max 9000 ticks (n=1693, 1/4 beat = 180); sustain CC points/piece median 198 total 12129
    asynchrony offsets   min -59 max 60 ms, n=128
INVARIANTS_PASS
--- pilot_v4_espressivo.jsonl ---
invariants over 60 pieces: all canonical rules hold
INVARIANTS_PASS

=== G2. I3 and I4 audited directly on the shipped pilot ===
synthetic sustain_cc: 0/12219 non-integer, range 0..127
real Vienna sustain_cc (88 rows): 0/312380 non-integer, range 0..127
movement terminators over 60 pieces: position != value in force 0; chain ends before the piece 0; terminator preceded by a constant 0

=== G3. M4 alphabet + schema spot-check on pilot_v4 line 0 ===
keys: id,ppq,total_ticks,notes,tempo,dynamics,articulation,rubato,asynchrony,movement,sustain_cc
total_ticks: 12240  notes[0] (7-tuple): [0,720,53,0,903.6144578313251,87.8,1]
movement[0] (6-tuple): [0,0.30708661417322836,0.8976377952755905,0.61,-0.21,"sustain"]
movement[last]: [12240,0.1889763779527559,null,null,null,"sustain"]
asynchrony: [[0,7]]
sustain_cc[0..3]: [[0,39],[0,39],[177.73178652108427,51],[234.31455313441265,63]]
positions off the CC alphabet: 0

=== G4. M9 default-omission actually exercised (not dead code) ===
scratchpad/final/ctrl.jsonl: 1112 movement transitions, curvature===0.4 (omitted per M9) 8, protraction===0.0 (omitted) 8
data/pilot_v4.jsonl:         1106 movement transitions, curvature===0.4 (omitted per M9) 12, protraction===0.0 (omitted) 8
<movement date="26460.0" position="0.031496062992125984" transition.to="0.8110236220472441" protraction="0.34" controller="sustain" />
  -> the control run containing these 8+8 omissions is block C: 0-diff, bit level.

=== H. Accentuation gate probe (20 pieces, --with-accentuation, --probe-no-pow; NOT shipped) ===
NOTE: --with-accentuation is on. TD3 has landed and both renderers agree bit-exactly on accentuated velocities at the state in ESPRESSIVO_DEFECTS (E3) — but shipping this as supervision data is a program decision, so re-confirm the gate before you do.
pieces 20 | notes 2679 | sustain CC points (part 1) 4758 | JSONL rendered by espressivo
scalar comparisons 75870 | differing 0 | out of envelope 0 | max |diff| 0 | max ulp 0
    note.velocity                  2679 compared,       0 differ,       0 not bit-exact 
    jsonl.note.velocity            2679 compared,       0 differ,       0 not bit-exact 
CROSS_RENDERER_PASS (0-diff, bit level)
non-vacuity control (same seed, flag off): accentuation effect: 2679/2679 velocities changed, max |delta| 13.0375
meico-ts src/mpm/elements/styles/defs/AccentuationPatternDef.ts:272
    if (i < this.accentuations.length - 1) segmentEnd = ...   <- TD3 HAS landed (was `i > length - 1`)
dist/mpm/elements/styles/defs/AccentuationPatternDef.js:237   <- and it is in the built dist

=== I. ULP-gate seed sweep: property, not seed luck (15 pieces x 6 seeds, tempo+rubato+asynchrony+movement) ===
seed 4242   cmp 56893 | differing 12 | out of envelope 0 | max |diff| 1.8189894035458565e-12 maxulp 1 worst obs/budget 0.036 ULP_PASS 
seed 777    cmp 55255 | differing  2 | out of envelope 0 | max |diff| 1.8189894035458565e-12 maxulp 1 worst obs/budget 0.028 ULP_PASS 
seed 1      cmp 34725 | differing 73 | out of envelope 0 | max |diff| 3.637978807091713e-12 maxulp 2 worst obs/budget 0.167 ULP_PASS 
seed 31337  cmp 26127 | differing  6 | out of envelope 0 | max |diff| 2.7284841053187847e-12 maxulp 3 worst obs/budget 0.188 ULP_PASS 
seed 2026   cmp 68101 | differing 91 | out of envelope 0 | max |diff| 3.637978807091713e-12 maxulp 2 worst obs/budget 0.071 ULP_PASS 
seed 88888  cmp 66221 | differing 19 | out of envelope 0 | max |diff| 3.637978807091713e-12 maxulp 2 worst obs/budget 0.063 ULP_PASS 
  -> 6/6 pass, worst headroom 5.3x.  (Second sweep at 20 pieces/seed, same 6 seeds: also 6/6, worst 0.188.)

=== J. Error paths that used to be silent (I5, I6) ===
$ node generate_v4.mjs out.jsonl 3 1 --maps tempo,dynamcs
Error: --maps: unknown map name(s) dynamcs; known: tempo, dynamics, articulation, rubato, asynchrony, movement
$ node generate_v4.mjs out.jsonl 3 1 --renderer java --movement-max-step 0.5
Error: --movement-max-step 0.5 is espressivo-only: ml/java/RenderMpm does not set MovementMap.movementSampleMaxStep, so --renderer java would silently render at 0.1. Re-run with --renderer espressivo, or drop the flag.
$ node generate_v4.mjs ms.jsonl 3 1 --movement-max-step 0.5
Done: 3 pieces, 234 notes, 544 CC points via espressivo in 438 ms   (espressivo honours it)

=== K. Console capture (I9) — nothing discarded ===
espressivo: 300 progress message(s), all recognised.
(unrecognised messages, i.e. parse warnings or defaulted attributes, would print as
 "WARNING: espressivo emitted N UNRECOGNISED console message(s) …" with texts and counts)

=== L. Throughput, re-measured (M1, nice -n 15, load avg 16-20 — NOT an idle machine) ===
JVM+meico startup, empty batch, 5 reps: real 0.23 / 0.09 / 0.20 / 0.12 / 0.12 s     (not ~1.5 s)
java        n=10:   815 ms (81.50 ms/piece)
java        n=100: 2372 ms (23.72 ms/piece, 42.2 pieces/s)   -> marginal (2372-815)/90 = 17.3 ms/piece
espressivo  n=10:  1878 ms (187.80 ms/piece)
espressivo  n=100: 18734 ms (187.34 ms/piece, 5.3 pieces/s)
java        n=100 without movementMap: 2119 ms (21.19 ms/piece)  -> movement ~2.3 ms/piece
espressivo  n=100 without movementMap: 4106 ms (41.06 ms/piece)  -> movement ~146 ms/piece
  -> 20k pieces via java ~ 7.4 min under this load (not 2.8 min).

=== M. Syntax / import sanity ===
node --check on all 8 ml/node/*.mjs: syntax OK


## open_issues
[
 "E1 and E2 are STILL LIVE in espressivo at meico-ts HEAD 415bbd2 + dirty tree (dist built 2026-08-09 11:29), re-confirmed in src AND dist during this round: `ArticulationMap.getArticulationDataOf` (src/mpm/elements/maps/ArticulationMap.ts:103) never reads the twelve numeric modifier attributes -> literal articulations render as the identity; `DynamicsMap.getDynamicsDataOf` (DynamicsMap.ts:100) never reads curvature/protraction -> every dynamics transition uses the wrong Bezier. Blast radius on the 60-piece pilot: 4053/7251 velocities, 1582/7251 milliseconds.date.end, min logic |diff| 0.0167 ms, max 5395 ms. Needs the meico-ts team (I did not touch their files). Until fixed, any v4 dataset with articulation or dynamics transitions MUST use `--renderer java`. Note for whoever checks: grepping the built dist for 'relativeDuration'/'curvature' gives a FALSE CLEAR -- those hits are in addArticulation/addDynamics, the serializers.",
 "E3 is FIXED (TD3 landed, meico-ts 8283853/415bbd2) and verified bit-exact cross-renderer on 20 pieces / 2679 accentuated notes, with a non-vacuity control (2679/2679 velocities move, max 13.04). The technical gate is therefore met, but `--with-accentuation` remains DEFAULT OFF and no accentuation supervision data was generated: that is the orchestrator's call, not the generator's. Whoever flips it should re-run `verify_v4.mjs cross` on an accentuated set at whatever commit meico-ts freezes.",
 "CANONICAL.md needs three amendments this round earned, and it is not my file. (a) M1 should state the two properties the render semantics FORCE and which the document currently leaves implicit: the terminator's position must be the value already in force, and the element before it must be a transition -- otherwise M1's terminator and G8's merge contradict each other and one of them silently wins (this was I3). (b) Section 12 step 16's conditional phrasing ('append a terminator IF the last instruction has a transition.to') is then exactly right, but only because (a) guarantees the antecedent. (c) Y3's [5,60] and M3/M4/M9 are now implemented as written -- the sampler's old MV*/AS* numbering is deleted and its changelog documents the four disagreements, but the doc should absorb that rather than leave it in a code comment.",
 "M3's 1/4-beat grid makes the pedal band dominate the description-length budget, which the orchestrator may want to price before a 20k run. Realised: 1721 movement instructions over 60 pieces (~29/piece, median segment 720 ticks), sustain CC points/piece median 203 (was 61 on the beat grid). At CANONICAL section 11's 5.1 tokens/segment that is ~145 movement tokens/piece against section 5's 85.5-token whole-piece tempo+dynamics budget. It also costs espressivo ~146 ms/piece (java ~2.3 ms). The grid is normative so I implemented it; if the token budget binds, the lever is the segment-length distribution in sampler.mjs (MOV_SEG_Q/MOV_SEG_P), not the grid.",
 "movementMap is still global, so meico renders one positionMap PER PART and part 2's is part 1's shifted by its asynchrony offset -- redundant, and now that the chains are ~3x denser it is the single largest avoidable render cost on the espressivo path. JSONL and validation already only use part 1's stream. Making it part-1-local is a one-line change in xml.mjs; I left it alone because it is a canonical-form decision (global vs local placement), not a bug.",
 "The 1-2 ULP libm divergence (Java fdlibm vs macOS libm pow/log) is unchanged and unfixable from the generator side: 38/199446 values on the exact pilot, max |diff| 7.3e-12 ms. It is now GATED correctly rather than tolerated by a magic constant, and the project's Python remedy (python/java_libm.py) still has no JS counterpart. If cross-language bit-exactness including tempo transitions is ever required, someone must port fdlibm e_pow/e_log to JS -- or keep java as the labelling renderer, which is also 8x faster now.",
 "`sustain_cc` values are now Math.round'ed integers (the MIDI observable, matching Vienna), but times and DUPLICATES are still verbatim: getMovementSegment emits [start,position] twice per element and [end,transitionTo] twice per transition, and a constant element emits three identical points at its own date and nothing after. Downstream feature extraction still needs last-wins state semantics and will probably want a de-duplication pass; deliberately not done in the generator so the JSONL stays a lossless view of the observable.",
 "Row-shape freeze is now half-done: the JSONL movement row is a 6-tuple ending in the controller, matching python/validate_v4.py, but CANONICAL section 11's DSL production has no controller token while M7 admits both 'sustain' and 'soft'. Someone owning the DSL needs to decide before a soft-pedal chain lands in v5.",
 "ml/README.md and ml/LOG.md are still not updated (not my files): the v4 generator, its flags, `verify_v4.mjs v3proof`, the derived ULP gate, the new `total_ticks` and 6-tuple movement row, and the three pilot files are undocumented there.",
 "ml/java/SampleAndRender.java is superseded but must NOT be deleted: `verify_v4.mjs v3proof` runs it as the reference the port is diffed against. Its `[maps]` argument defaulting to tempo-only is the trap that made the original proof non-reproducible; v3proof now hard-codes the correct list, so the trap is contained but still present for anyone invoking it by hand.",
 "pilot_v4_espressivo.jsonl contains knowingly-wrong velocities and note ends (E1/E2) and exists only to measure the defect. It passes INVARIANTS (the maps are canonical) which makes it look shippable. If a downstream consumer might glob ml/data/pilot_v4*.jsonl, it should be renamed or moved out of data/."
]

