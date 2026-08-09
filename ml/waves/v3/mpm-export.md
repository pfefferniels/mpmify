# mpm-export — built

## report
## Team C — MPM export bridge: DONE, 0.0 divergence end-to-end

The loop is closed: model-space maps → real `.mpm` file → meico parser+renderer → augmented MSM → **bit-identical** to the generator's own rendering, and the emitted XML is **byte-identical** to meico's own serializer output.

### Deliverables

**`ml/python/dsl_to_mpm.py`** — `maps_to_mpm(tempo_map, dyn_map=None, ppq=720, name="generated", beat_length=0.25, parts=(("Piano",1,0,0),)) -> str`
- Row formats exactly as in the JSONL / `dsl.decode_piece()`: tempo `[date, bpm, transition.to|None, meanTempoAt|None]`, dynamics `[date, volume, to|None, curvature|None, protraction|None]`. `None` fields are omitted; `meanTempoAt`/`curvature`/`protraction` are only emitted when a `transition.to` is present.
- Reproduces the generator's vocabulary and attribute ORDER: `<tempo date bpm [transition.to] beatLength [meanTempoAt]/>`, `<dynamics date volume [transition.to] [curvature] [protraction]/>`, root `<mpm xmlns="http://www.cemfi.de/mpm/ns/1.0"><performance name pulsesPerQuarter><global><header/><dated>…maps…</dated></global><part …><header/><dated/></part></performance></mpm>`.
- Two number formatters mirroring the Java side: `_jd()` = `Double.toString` (dates, beatLength, meanTempoAt, curvature, protraction — meico writes these from doubles) and `_num()` = `SampleAndRender.fmt()` i.e. `String.format("%.2f")` with trailing zeros stripped (bpm/volume/transition.to — meico stores these as *strings*, since MPM allows literal tempo names). `_num` now falls back to full round-trip repr when 2 decimals would lose precision, so a model emitting more digits than the sampler never silently rounds while canonical values stay byte-identical.

**`ml/java/RenderMpm.java`** — `RenderMpm <in.msm> <in.mpm> <out_augmented.msm> [perfIndex]`. `new Msm(File)` / `new Mpm(File)` (both exist and both call `parseData()`), `mpm.getPerformance(idx)`, `perf.perform(msm)`, write `augmented.toXML()`. `Locale.setDefault(Locale.US)`. Exit 1 usage / 2 no performance / 3 perform() returned null.

**`ml/python/validate_export.py`** — two modes:
- default: pilot pieces → `maps_to_mpm` → `.mpm` → `RenderMpm` → parse augmented MSM → compare every `milliseconds.date` / `milliseconds.date.end` / `velocity` against the JSONL, plus a byte-compare of our `.mpm` against the generator's.
- `--stress N [seed]`: random maps that deliberately leave canonical form (non-beat-aligned dates incl. 45.0 and 1234.5 ticks, omitted meanTempoAt/curvature/protraction, dangling final transitions) checked against `tempo_math`/`dynamics_math` as an independent oracle.
- Paths overridable via `EXPORT_JSONL` / `EXPORT_DEBUG` / `EXPORT_WORK` (added because `--stress` takes n/seed positionally, and other agents share `/tmp/exp_debug`; I ran everything against isolated `/tmp/expC_*`).

### meico parser quirks discovered (probed empirically, one JVM render per case, compared against a reference render)

1. **`beatLength` is MANDATORY on every `<tempo>`, and omitting it fails SILENTLY.** `TempoMap.getTempoDataOf()` returns null when the attribute is absent (`TempoMap.java:210-212`), so the instruction is dropped; meico exits 0 and the augmented MSM carries `date.perf`/`duration.perf`/`velocity` but **no `milliseconds.*` attributes at all**. This is the single most dangerous omission for an export bridge — it looks like a crash-free render. Hence beatLength is emitted unconditionally.
2. **The namespace is completely ignored.** meico resolves everything through `Helper.getFirstChildElement` (`getLocalName().equals(name)`) and `Helper.getAllChildElements` (XPath `local-name()`). Missing `xmlns`, a *wrong* `xmlns`, and a prefixed declaration all render **bit-identically** to the correct one. We still emit the official namespace for schema validity / other tools.
3. Attribute order irrelevant; `<?xml?>` declaration optional; the `<part>` element is optional when all instructions are global. All three render identically.
4. **`performance/@pulsesPerQuarter` is semantic, not cosmetic** — it is the tick scale dates are read in. 360 vs 720 against the same MSM diverged by 14.2 s. Must equal the MSM's ppq.
5. `meanTempoAt` omitted ≡ `meanTempoAt="0.5"` (default exponent 1.0, linear) — both diverged from the 0.57 reference by exactly the same 114.458 ms, confirming `TempoMap.java:261-264`. Also: `meanTempoAt <= 0` collapses to a constant at the TARGET value, `>= 1` to a constant at the START value, so those are not usable transition shapes.
6. **Dangling final transitions are inert** for tempo *and* dynamics (confirmed in the stress run's separate accounting: 348 notes, 0.0 diff), consistent with the canonical-form assumption in LOG.md.

### Bug found in a read-only port (worked around in my file, NOT fixed there)

`tempo_math.TempoTimeline` / `dynamics_math.DynamicsTimeline` use `float("inf")` as the end date of the last instruction. meico uses `Double.MAX_VALUE` (`TempoMap.getEndDate:279`, `DynamicsMap.getEndDate:376`). For a **dangling final dynamics transition** this makes `dynamics_math._t_for_date`'s Bezier bisection (`while abs(diff) >= 1.0`, `diff = cubic(t)*s - d` with `s = inf`) **never terminate** — my first stress run spun at 96% CPU for 3.5 min before I killed it; reproduced deterministically at trial 9 of seed 7 with final instruction `[24808.5, 86.8, 41.1, 0.346, -0.166]`. Fix in my file: `JavaTempoTimeline` / `JavaDynamicsTimeline` subclasses restoring the finite sentinel (`DOUBLE_MAX = 1.7976931348623157e308`). With it both engines agree the transition is inert. Tempo is unaffected in practice (`pow(tiny, exp)*(to-bpm) + bpm == bpm` exactly at either sentinel) but uses the same sentinel for faithfulness. **Owner of `dynamics_math.py` should adopt `Double.MAX_VALUE` if that port is ever fed non-canonical maps.**

### Constraints honoured
Training `train.py 12 v2` (PID 19527) left untouched. Everything `nice -n 15`; 3-piece pilot only (134 ms generation); no dataset regeneration, no training started. Only my three files written; `javac` emitted only `out/RenderMpm.class` (did not recompile `SampleAndRender`, which another agent recompiled at 18:47). Isolated `/tmp/expC_*` paths used so the shared `/tmp/exp_debug` was not clobbered.

## files_changed
[
 "/Users/nielspfeffer/Projects/mpmify/ml/python/dsl_to_mpm.py",
 "/Users/nielspfeffer/Projects/mpmify/ml/java/RenderMpm.java",
 "/Users/nielspfeffer/Projects/mpmify/ml/python/validate_export.py"
]

## validation_output
$ cd /Users/nielspfeffer/Projects/mpmify/ml/java && nice -n 15 javac -cp "/Users/nielspfeffer/Projects/meico/out/production/meico:/Users/nielspfeffer/Projects/meico/externals/*" -d out RenderMpm.java
COMPILE OK

$ nice -n 15 java -cp "out:$MEICO/out/production/meico:$MEICO/externals/*" SampleAndRender /tmp/expC_pilot.jsonl 3 5555 tempo,dynamics /tmp/expC_debug
...
huhu. Performance rendering finished. Time consumed: 3 milliseconds
Done: 3 pieces in 134 ms -> /tmp/expC_pilot.jsonl

=== 1. PILOT EXPORT VALIDATION (maps -> our .mpm -> meico RenderMpm -> augmented MSM) ===
$ cd ml/python && nice -n 15 python3 validate_export.py /tmp/expC_pilot.jsonl /tmp/expC_debug /tmp/expC_export
piece0:   64 notes  tempo=2 dyn=4  max|onset|=0.000000000 ms  max|offset|=0.000000000 ms  max|velocity|=0.000000000  mpm bytes identical
piece1:   41 notes  tempo=2 dyn=3  max|onset|=0.000000000 ms  max|offset|=0.000000000 ms  max|velocity|=0.000000000  mpm bytes identical
piece2:   69 notes  tempo=4 dyn=4  max|onset|=0.000000000 ms  max|offset|=0.000000000 ms  max|velocity|=0.000000000  mpm bytes identical

pieces validated = 3/3, notes compared = 174
max |onset diff|    = 0.000000000 ms
max |offset diff|   = 0.000000000 ms
max |velocity diff| = 0.000000000
MPM byte-identical to meico's own serialization: 3/3
RESULT: EXACT (0.0 divergence)
exit=0

=== 2. STRESS VALIDATION (30 random non-canonical maps vs tempo_math/dynamics_math oracle) ===
$ EXPORT_JSONL=/tmp/expC_pilot.jsonl EXPORT_DEBUG=/tmp/expC_debug EXPORT_WORK=/tmp/expC_export nice -n 15 python3 validate_export.py --stress 30 7
canonical (last constant)   :   1392 notes  max|onset|=0.000000000 ms  max|offset|=0.000000000 ms  max|velocity|=0.000000000
dangling final transition   :    348 notes  max|onset|=0.000000000 ms  max|offset|=0.000000000 ms  max|velocity|=0.000000000

30 random maps (seed 7) vs tempo_math/dynamics_math oracle
RESULT: EXACT (0.0 divergence)
exit=0

=== 3. MEICO PARSER TOLERANCE PROBE (scratchpad script, one render per case vs reference) ===
reference: 69 notes, first (0.0, 732.2014975071014, 44.1), last (33151.03968150688, 35258.76801874341, 79.9)
no-xmlns               IDENTICAL   first=(0.0, 732.2014975071014, 44.1)
wrong-ns               IDENTICAL   first=(0.0, 732.2014975071014, 44.1)
prefixed-ns            IDENTICAL   first=(0.0, 732.2014975071014, 44.1)
no-beatLength          NO milliseconds.* attributes emitted; note attrs = accidentals,date,date.perf,duration,duration.perf,midi.pitch,modified,octave,pitchname,velocity,{http://www.w3.org/XML/1998/namespace}id
no-meanTempoAt-05      DIFFERS max 114.458003   first=(0.0, 725.4312444454255, 44.1)
explicit-mta-05        DIFFERS max 114.458003   first=(0.0, 725.4312444454255, 44.1)
attr-order-shuffled    IDENTICAL   first=(0.0, 732.2014975071014, 44.1)
no-decl                IDENTICAL   first=(0.0, 732.2014975071014, 44.1)
ppq-mismatch-360       DIFFERS max 14176.920804   first=(0.0, 736.5555231599039, 44.1)
no-part-element        IDENTICAL   first=(0.0, 732.2014975071014, 44.1)

=== 4. HANG DIAGNOSIS (inf vs Double.MAX_VALUE end-date sentinel) ===
$ python3 -c "<replay stress trial loop with the unmodified inf-based ports, 3 s alarm per trial>"
0 ok
1 ok
2 ok
3 ok
4 ok dangling
5 ok
6 ok
7 ok
8 ok
9 HANG (inf port) dangling= True last dyn= [24808.5, 86.8, 41.1, 0.346, -0.166]

=== 5. NUMBER FORMATTER UNIT CHECK ===
181.7                  _num=181.7                  _jd=181.7
43.0                   _num=43                     _jd=43.0
0.0                    _num=0                      _jd=0.0
100.8                  _num=100.8                  _jd=100.8
0.15                   _num=0.15                   _jd=0.15
-0.68                  _num=-0.68                  _jd=-0.68
100.123456             _num=100.123456             _jd=100.123456
0.3333333333333333     _num=0.3333333333333333     _jd=0.3333333333333333
2.675                  _num=2.675                  _jd=2.675
0.005                  _num=0.005                  _jd=0.005
0.0001                 _num=0.0001                 _jd=0.0001
12345678.0             _num=12345678               _jd=12345678.0

emitted document (constant tempo + transition + dynamics):
<?xml version="1.0"?>
<mpm xmlns="http://www.cemfi.de/mpm/ns/1.0"><performance name="y" pulsesPerQuarter="720"><global><header /><dated><tempoMap><tempo date="0.0" bpm="100.5" transition.to="90.25" beatLength="0.25" meanTempoAt="0.4" /><tempo date="2880.0" bpm="90.25" beatLength="0.25" /></tempoMap><dynamicsMap><dynamics date="0.0" volume="64" /></dynamicsMap></dated></global><part name="Piano" number="1" midi.channel="0" midi.port="0"><header /><dated /></part></performance></mpm>

generator reference for comparison (/tmp/expC_debug/piece2.mpm, written by meico's own serializer):
<?xml version="1.0"?>
<mpm xmlns="http://www.cemfi.de/mpm/ns/1.0"><performance name="perf" pulsesPerQuarter="720"><global><header /><dated><tempoMap><tempo date="0.0" bpm="81.1" transition.to="113.5" beatLength="0.25" meanTempoAt="0.57" /><tempo date="7200.0" bpm="54.1" transition.to="187.2" beatLength="0.25" meanTempoAt="0.17" /><tempo date="15840.0" bpm="42.7" beatLength="0.25" /><tempo date="23040.0" bpm="104.2" beatLength="0.25" /></tempoMap><dynamicsMap><dynamics date="0.0" volume="44.1" transition.to="79.9" curvature="0.76" protraction="-0.55" /><dynamics date="3600.0" volume="79.9" transition.to="102.5" curvature="0.36" protraction="0.49" /><dynamics date="15120.0" volume="109.6" transition.to="62.9" curvature="0.67" protraction="-0.14" /><dynamics date="25200.0" volume="62.9" /></dynamicsMap></dated></global><part name="Piano" number="1" midi.channel="0" midi.port="0"><header /><dated /></part></performance></mpm>

## open_issues
[
 "`ml/python/dynamics_math.py` (not my file): `DynamicsTimeline` uses float('inf') as the last instruction's end date, where meico uses Double.MAX_VALUE. On a dangling final dynamics transition the Bezier bisection in `_t_for_date` never terminates (infinite loop, reproduced at stress trial 9 / seed 7). `tempo_math.TempoTimeline` has the same inf sentinel but is numerically unaffected. I worked around it with `JavaTempoTimeline`/`JavaDynamicsTimeline` inside validate_export.py; the ports themselves should adopt Double.MAX_VALUE if they are ever fed non-canonical maps.",
 "`maps_to_mpm` currently covers tempoMap + dynamicsMap only. articulationMap / rubatoMap (v3) and movementMap (v4) still need element vocabulary + a matching validation pass; the v3 sampler already emits those maps into the JSONL (`articulation`, `rubato` keys), so this is the obvious next extension.",
 "`maps_to_mpm` emits all instructions in `<global>` and MPM parts with empty `<dated/>`. Per-part maps, styleDefs/style switches (v6 MDL compression) and non-0.25 beatLength are parameterized but untested.",
 "Default paths `/tmp/exp_pilot.jsonl` and `/tmp/exp_debug` are shared with other agents' scripts (I saw `piece*_rt.msm` there from another agent). I validated against isolated `/tmp/expC_*` and added EXPORT_JSONL/EXPORT_DEBUG/EXPORT_WORK env overrides; consider giving each team its own default dir.",
 "The `--stress` mode spawns one JVM per trial (~4-6 s each under the running training), so 30 trials take ~2-3 min and must be backgrounded; a batch mode in RenderMpm (many mpm/msm pairs per JVM) would make larger stress sweeps cheap.",
 "beatLength is mandatory and silently dropped when absent (no error, exit 0, no milliseconds.* in the output). Any future map-export code path must be checked for the same class of silent-drop attribute requirements before trusting a non-crashing render."
]

# mpm-export — verify

## evidence
ALL HEADLINE CLAIMS REPRODUCE EXACTLY. Independent re-runs (all `nice -n 15`, isolated scratchpad paths, train.py PID 26844 left running and still alive at 25:11 elapsed; no repo file touched — deliverable mtimes unchanged 18:39/19:07/19:07).

1) Files exist, compile, import: `javac -Xlint:all` on /Users/nielspfeffer/Projects/mpmify/ml/java/RenderMpm.java → exit 0, only "bad path element" warnings for missing meico externals jars; class is 2552 B, byte-size-identical to the committed out/RenderMpm.class. `import dsl_to_mpm, validate_export` clean on Python 3.13.5. RenderMpm exit codes verified live: no args → 1 + usage line; perfIndex 9 → 2 + "no performance at index 9".

2) Pilot mode re-run (fresh 3-piece pilot, seed 5555, generated in-run): piece0 64 notes tempo=2 dyn=4, piece1 41 notes tempo=2 dyn=3, piece2 69 notes tempo=4 dyn=4; 174 notes; max|onset|=max|offset|=max|velocity|=0.000000000; "MPM byte-identical … 3/3"; RESULT: EXACT; exit 0. Identical to reported numbers.

3) Stress mode re-run (`--stress 30 7`): canonical 1392 notes 0.000000000 / dangling 348 notes 0.000000000; RESULT: EXACT; exit 0. Identical to reported numbers. (Note the printed %.9f could hide a sub-ns diff, but the verdict uses `max(worst)==0.0`, i.e. it is a true bit-exact gate.)

4) Byte-identity generalizes beyond the reported 3 pieces: I generated 5 fresh pilots (seeds 11/22/33/44/55, 3 pieces each) and compared `maps_to_mpm()` output to meico's own serializer output → 15/15 byte-identical.

5) Formatter claim brute-forced against real Java (`String.format("%.2f")` + strip, and `Double.toString`) over 125,012 values: on all canonical value classes (bpm/volume 1 dp, mta/curvature/protraction 2 dp; 80,000 samples) `_num` == Java `fmt()` with 0 mismatches. On >2-decimal values `_num` intentionally differs (fallback) — 43,045 cases — and in 0 of them does the emitted string parse to a different double. Claim holds.

6) Parser quirks independently confirmed. From meico source: TempoMap.getTempoDataOf returns null when `beatLength` is absent (src/meico/mpm/elements/maps/TempoMap.java ~L209-212); meanTempoAt absent → 0.5/exponent 1.0; <=0 → constant at target, >=1 → constant at start; getEndDate → Double.MAX_VALUE (TempoMap L279, DynamicsMap L376); DynamicsData.computeInnerControlPointsXPositions defaults null curvature/protraction to 0.0 (so the ports' `curv or 0.0` is faithful). Recomputing their probe diffs from the .msm files they left in scratchpad reproduces their exact figures: no-meanTempoAt-05 and explicit-mta-05 both DIFFER max 114.458003; ppq-mismatch-360 DIFFERS max 14176.920804; no-beatLength → no milliseconds.* attributes; no-xmlns / wrong-ns / prefixed-ns / attr-order-shuffled / no-decl / no-part-element all IDENTICAL.

7) Harness is NOT vacuous — my own negative controls (fresh renders): bpm+0.1 on the last tempo instruction → 76.275226 ms; volume+1 → 1.000000 velocity; tempo date +1 tick → 1.461491 ms; ppq 360 → 12627.286077 ms; beatLength stripped → note carries no milliseconds.* (and validate_export.parse_notes would raise TypeError, i.e. loud). Running validate_export.py on a v3 pilot (articulation+rubato present, which maps_to_mpm drops) yields RESULT: MISMATCH (304.26 ms onset, 24.9 velocity, 0/3 byte-identical) — the acknowledged v3 gap fails loudly.

8) The reported dynamics_math hang reproduces: dynamics_at(30000.0, [24808.5,86.8,41.1,0.346,-0.166], float('inf')) does not return within a 4 s alarm; with 1.7976931348623157e308 it returns 86.8 (== volume, i.e. inert). Tempo confirmed unaffected: segment_ms identical (694.4444444444443) under both sentinels.

The issues listed below are ADDITIONAL risks I found; none of them falsify the 0.0-divergence results, all are outside the canonical-form envelope the team validated.

## issues
[
 "UNSORTED MAP ROWS: dsl_to_mpm.maps_to_mpm emits rows in the order given, without sorting by date. meico SORTS the map on parse; tempo_math/dynamics_math (and validate_export's JavaTempoTimeline._seg_index) assume sorted input. Reproduced: tempo map [[0,120],[3600,60],[7200,180]] reversed renders in meico bit-identically to the sorted version (last note 16166.667 ms both), while the Python oracle is off by max 9166.666667 ms. Consequence: an unsorted model output would render one way in the real MPM and another in the Python render-space evaluator \u2014 silently, with no error. maps_to_mpm should sort (and probably reject duplicate/negative dates).",
 "OUT-OF-RANGE curvature/protraction NOT CLAMPED ON EXPORT: meico clamps on parse (DynamicsMap.getDynamicsDataOf \u2192 ensureCurvatureBoundaries [0,1] / ensureProtractionBoundaries [-1,1], src/meico/mpm/elements/maps/DynamicsMap.java:249,266), dsl_to_mpm emits verbatim and dynamics_math does not clamp. Reproduced with curvature=1.5, protraction=-2.0 over 64 notes: max |meico velocity \u2212 dynamics_math velocity| = 46.591434 (worst at date 180: meico 32.325, oracle 78.917); against a pre-clamped oracle (1.0/-1.0) the same render is 0.000000000. meico only warns on stderr ('Invalid curvature value: 1.5 > 1.0. Setting it to 1.0.'), and validate_export.run() captures stderr but inspects only returncode, so the clamp is invisible to the harness. Same class of risk as the beatLength silent-drop they documented, but on the emit side and for exactly the unconstrained model outputs the bridge exists to carry.",
 "EMPTY tempo_map SILENTLY RENDERS AT MEICO'S DEFAULT TEMPO: maps_to_mpm([], dyn) emits an <mpm> with no <tempoMap>; RenderMpm exits 0 and the augmented MSM DOES carry milliseconds.date/.end (verified live) \u2014 i.e. a model that emits no tempo instruction produces a plausible-looking but meaningless render. No guard in maps_to_mpm (nor a note in its docstring, which only warns about the beatLength case).",
 "validate_export.main()'s pass/fail does not include the byte-identity result: `ok = not failures and max(worst.values()) == 0.0 and tot_notes > 0`. A serializer-vocabulary regression would print 'MPM byte-identical to meico's own serialization: 0/3' and still exit 0 with 'RESULT: EXACT' as long as the rendered values match. The claim advertised most prominently in the report is therefore not gated by the exit code.",
 "validate_export.py --stress has no note-count guard: `python3 validate_export.py --stress 0` prints 'RESULT: EXACT (0.0 divergence)' and exits 0 with zero notes compared (verified). main() has the `tot_notes > 0` guard, stress() does not. Related: stress() compares with `zip(parse_notes(out_msm), score)`, which silently truncates to the shorter list instead of failing on a note-count mismatch (main() does check note counts).",
 "_jd() is not Double.toString outside [1e-3, 1e7): it returns Python repr, so 1e7 \u2192 '10000000.0' (Java '1.0E7'), 0.0005 \u2192 '0.0005' (Java '5.0E-4'), 1e20 \u2192 '1e+20' (Java '1.0E20'). Also _jd(-0.0) returns '0.0' because the `v == 0.0` early return loses the sign (Java writes '-0.0'). Measured over 125,012 values: 64 _jd mismatches (58 of them -0.0, plus 1e-4/1e-5/1e7/1e20/5e-324/\u2026), 0 of them value-changing under Double.parseDouble. So semantics are safe, but the byte-identity property is canonical-range-only, and the module docstring's claim that it fixes 'the notation threshold' is wrong \u2014 it never emits Java-style scientific notation.",
 "probe_parser.py's 'prefixed-ns' case only prefixes the root element (<m:mpm xmlns:m=\u2026> \u2026 </m:mpm>) and leaves every descendant unprefixed, i.e. the children end up in NO namespace rather than in the MPM namespace. It does demonstrate namespace-insensitivity, but it is not the 'prefixed declaration' document the report describes; a fully-prefixed document was not tested.",
 "Both sides of the velocity comparison default a missing value to 100.0 (validate_export.parse_notes: `100.0 if vel is None else float(vel)`; main(): `float(note[5]) if len(note) > 5 else 100.0`). If a dynamicsMap were ever silently dropped on a tempo-only JSONL, the velocity check would pass vacuously. Low severity (my vol+1 negative control confirms the comparison is live for real dynamics data), but it is the one comparison in the file that cannot fail loudly the way the milliseconds.* comparison does."
]

## verdict
ISSUES

# mpm-export — fixed

## report
## Team C "mpm-export" — all 8 verified issues fixed, re-validated

Only the three team files touched: `ml/python/dsl_to_mpm.py`, `ml/python/validate_export.py`, `ml/java/RenderMpm.java` (+ recompiled `ml/java/out/RenderMpm.class`). Probes live in the session scratchpad. Training PID for `train.py 12 v2` untouched, everything `nice -n 15`, one 3-piece pilot reused (no regeneration).

### Fixes, one per verified issue

1. **Unsorted rows** — new `canonicalize_tempo_map` / `canonicalize_dynamics_map` / `canonicalize_maps` in `dsl_to_mpm.py`; `maps_to_mpm` runs them before emitting. Python's stable `list.sort` matches meico's stable parse-time insertion sort (`GenericMap` ctor lines 100-123 + `sortXml()`), so equal dates keep document order in both. Proof: `--selftest` shows reversed rows emit the *byte-identical* sorted document, meico renders them identically, oracle-on-raw-rows diverges by **9083.333 ms** (the bug) vs **0.000000000 ms** after the fix; stress category "rows in reverse order" = exact 0.0 over 458 notes.
   Duplicate dates are **not** rejected: measured to be safe. meico assigns a note at a boundary to the *earlier* instruction (`renderTempoToMap:396` breaks only when `key > td.endDate`) which yields exactly `startDateMilliseconds` of the next one, i.e. bit-identically what `_seg_index`'s last-wins does. Stress category "duplicate dates": 453 notes, residual 4.5e-13 (ULP, see below).
2. **curvature/protraction not clamped** — clamped on export to meico's own ranges (`CURVATURE_RANGE (0,1)`, `PROTRACTION_RANGE (-1,1)`; `DynamicsMap.java:249/266`). `--selftest`: curvature 1.5 / protraction -2.0 emit as `1.0`/`-1.0`; meico renders the raw and the clamped document identically; oracle-on-raw-values diverges by **28.815162 velocity** vs **0.000000000** after the fix. Both harness modes now also *fail* if meico's stderr contains `Invalid curvature/protraction value` — the clamp is no longer invisible.
3. **Empty tempo map** — `maps_to_mpm` raises `MpmExportError` unless `allow_no_tempo=True`. `--selftest` renders the opt-in case to document the hazard: meico happily writes `milliseconds.*` on all 69 notes (last 28080.0 ms at its default 100 bpm / `computeMillisecondsForNoTempo = 600*date/ppq`).
4. **Byte-identity not gated** — `ok` now requires `byte_checked == compared and byte_identical == byte_checked`; a *missing* generator `.mpm` to compare against is itself a failure. Result string is now "EXACT (0.0 divergence, byte-identical XML)".
5. **`--stress` guards** — `n_trials < 1` exits 1 (`--stress 0` → "needs at least 1 trial", exit 1); `total_notes > 0` gate; the `zip` truncation is gone — `compare()` raises on any note-count mismatch (proven by a negative control that trims the score by one note).
6. **`_jd` is now really `Double.toString`** — full Java format: `NaN`/`Infinity`/`-Infinity`, signed zero (`-0.0`), plain decimals only for `1e-3 <= |v| < 1e7`, else computerized scientific (`1.0E7`, `5.0E-4`, `1.0E20`, `1.2345678E7`). New `--formats` mode diffs it against this JVM over 146,239 values: **0 spelling mismatches in the project value domain (26,216) and in [1e-3,1e7) (70,000)**; 166 spelling-only mismatches at extreme exponents, **0 value-changing** — those are JDK 17's pre-JDK-19 non-shortest `Double.toString` (e.g. java `-4.6398703355621528E16` vs ours `-4.639870335562153E16`, `9.999999999999999E22` vs `1.0E23`, `4.9E-324` vs `5.0E-324`), all round-tripping to the identical double. Docstring corrected accordingly (the old "fixes the notation threshold" claim is gone).
7. **probe_parser prefixed-ns** — scratchpad probe rewritten: `prefix_all()` prefixes root *and every descendant* and declares `xmlns:m`; that document renders IDENTICAL to the reference, as does the root-only variant (now labelled `prefixed-root-only`). All 12 cases now run in one JVM.
8. **Velocity default 100.0 on both sides** — `parse_notes` now returns `None` for an absent `velocity` attribute and **raises** if `milliseconds.date{,.end}` are absent (that is exactly the silent beatLength-drop signature). `main()` counts velocity comparisons and fails when a record has a dynamicsMap but any note could not be velocity-compared; the exit code requires `vel_compared == tot_notes`. Raw MSMs carry no `velocity`, so a dropped dynamicsMap can no longer pass vacuously.

### Beyond the issue list
- **`RenderMpm --batch <manifest.tsv>`** (msm⇥mpm⇥out[⇥perfIndex] per line, `#`/blank ignored, exit 4 on any failure) — all harness modes now use one JVM instead of one per render (40-trial stress: ~40 JVMs → 1). Single-render mode and its exit codes (0/1/2/3) unchanged and re-verified.
- `main()` additionally asserts the canonicalizer is a **no-op on the generator's own maps** — that is what keeps byte-identity intact.
- New modes: `--selftest` (guards + both bug reproductions + negative controls: bpm×1.01 → 165.017 ms, volume+1 → 1.000 velocity, note-count mismatch raises) and `--formats`.

### Key discovery: meico↔Python exactness has a floor
Three stress categories left a **~1e-12 ms residual**. Root-caused with a scratchpad probe over the 7,682 distinct `(x, meanTempoAt)` pairs those maps actually evaluate: **JVM `Math.log(0.5)/Math.log(mta)` differs from CPython for 434 of them, `Math.pow(x, exponent)` for 935, always by 1 ULP (rel ≈1.6e-16)**. Accumulated over ~30 instructions that is ≤9.1e-13 ms. Not an export bug and not a `tempo_math` bug — a runtime libm difference. Consequently: pilot mode (canonical value grid) still demands and gets **exact 0.0**; stress mode accepts `TOL = 1e-9` (the project's stated tolerance), prints the actual residual per category, and says which categories were exactly 0.0. This bounds the project-wide "bit-exact port" claim to canonical value grids — worth knowing before v3/v4 evaluators are trusted at sub-ULP level.

### API changes other agents must know
- `maps_to_mpm` now raises `MpmExportError` (subclass of `ValueError`) on: empty tempo map, first tempo instruction not at date 0, negative/NaN/inf date, bpm ≤ 0, non-numeric field, ppq ≤ 0, beatLength ≤ 0.
- New public helper `canonicalize_maps(tempo, dyn) -> (tempo, dyn)`: the rows the exported MPM will actually contain. **Any Python render-space evaluator must call it before scoring a model map**, otherwise it scores a map meico would never render (sorting, clamping, meanTempoAt ≤0/≥1 collapse per `TempoMap.java:250-257`).

## files_changed
[
 "/Users/nielspfeffer/Projects/mpmify/ml/python/dsl_to_mpm.py",
 "/Users/nielspfeffer/Projects/mpmify/ml/python/validate_export.py",
 "/Users/nielspfeffer/Projects/mpmify/ml/java/RenderMpm.java",
 "/Users/nielspfeffer/Projects/mpmify/ml/java/out/RenderMpm.class (recompiled)",
 "/private/tmp/claude-501/-Users-nielspfeffer-Projects-mpmify/6a63bc22-2929-4ad2-81f9-fd90f7b0b835/scratchpad/probe_parser.py (scratchpad, fixed prefixed-ns case)",
 "/private/tmp/claude-501/-Users-nielspfeffer-Projects-mpmify/6a63bc22-2929-4ad2-81f9-fd90f7b0b835/scratchpad/pow_check.py + PowProbe.java (scratchpad, ULP root-cause probe)",
 "/private/tmp/claude-501/-Users-nielspfeffer-Projects-mpmify/6a63bc22-2929-4ad2-81f9-fd90f7b0b835/scratchpad/diag_stress.py, jd_check.py, JdProbe.java (scratchpad diagnostics)"
]

## validation_output
$ cd /Users/nielspfeffer/Projects/mpmify/ml/java && nice -n 15 javac -cp "$MEICO/out/production/meico:$MEICO/externals/*" -d out RenderMpm.java
COMPILE_OK
-rw-r--r--  1 nielspfeffer  staff  4016  8 Aug. 19:37 out/RenderMpm.class

=== 1. PILOT (maps -> our .mpm -> meico RenderMpm --batch -> augmented MSM) ===
piece0:   64 notes  tempo=2 dyn=4  max|onset|=0.000000000 ms  max|offset|=0.000000000 ms  max|velocity|=0.000000000 (64 compared)  mpm bytes identical
piece1:   41 notes  tempo=2 dyn=3  max|onset|=0.000000000 ms  max|offset|=0.000000000 ms  max|velocity|=0.000000000 (41 compared)  mpm bytes identical
piece2:   69 notes  tempo=4 dyn=4  max|onset|=0.000000000 ms  max|offset|=0.000000000 ms  max|velocity|=0.000000000 (69 compared)  mpm bytes identical

pieces validated = 3/3, notes compared = 174, velocities compared = 174
max |onset diff|    = 0.000000000 ms
max |offset diff|   = 0.000000000 ms
max |velocity diff| = 0.000000000
MPM byte-identical to meico's own serialization: 3/3
RESULT: EXACT (0.0 divergence, byte-identical XML)
exit=0

=== 2. STRESS (40 non-canonical maps, 5 categories, 1 JVM) ===
canonical (last constant)   :   8 trials    481 notes  max|onset|=0.000000000 ms  max|offset|=0.000000000 ms  max|velocity|=0.000000000   (exact 0.0)
dangling final transition   :   8 trials    453 notes  max|onset|=0.000000000 ms  max|offset|=0.000000000 ms  max|velocity|=0.000000000   ULP residual 9.095e-13
rows in reverse order       :   8 trials    458 notes  max|onset|=0.000000000 ms  max|offset|=0.000000000 ms  max|velocity|=0.000000000   (exact 0.0)
out-of-range curv/prot/mta  :   8 trials    481 notes  max|onset|=0.000000000 ms  max|offset|=0.000000000 ms  max|velocity|=0.000000000   ULP residual 9.095e-13
duplicate dates             :   8 trials    453 notes  max|onset|=0.000000000 ms  max|offset|=0.000000000 ms  max|velocity|=0.000000000   ULP residual 4.547e-13

40 random maps (seed 7) vs tempo_math/dynamics_math oracle, 2326 notes compared, no meico clamp warnings
RESULT: EXACT within tolerance -- max residual 9.095e-13 (<= 1e-09); JVM/CPython Math.pow+Math.log 1-ULP, see module docstring
exit=0

=== 3. SELFTEST (guards + bug reproductions + negative controls) ===
1. input guards (no JVM)
  OK   empty tempo map                                      -> MpmExportError: empty tempo map: meico would render this file at its default tempo and
  OK   negative date                                        -> MpmExportError: row 0: date must be >= 0, got -1.0
  OK   NaN bpm                                              -> MpmExportError: row 0: bpm must be finite, got nan
  OK   bpm = 0                                              -> MpmExportError: row 0: bpm must be > 0, got 0.0
  OK   no instruction at date 0                             -> MpmExportError: first tempo instruction is at date 720.0, not 0: notes before it have
  OK   non-numeric row field                                -> MpmExportError: row 0: bpm is not a number: 'allegro'
2. canonicalization is visible in the emitted XML (no JVM)
  OK   reversed rows emit the sorted document
  OK   curvature 1.5 / protraction -2.0 emitted as 1.0 / -1.0
  OK   meanTempoAt 1.7 collapses to a constant at the start value
3. against meico (one JVM, 6 renders)
  OK   canonical export vs oracle: on=0.000000000 off=0.000000000 vel=0.000000000
  OK   meico renders reversed rows exactly like the sorted document
       pre-fix (oracle on raw rows) : max|onset| = 9083.333333 ms  <- the bug
       fixed   (canonicalized rows) : max|onset| = 0.000000000 ms
  OK   meico renders raw 1.5/-2.0 exactly like the clamped export (it clamps on parse)
       pre-fix (oracle on raw values): max|velocity| = 28.815162  <- the bug
       fixed   (clamped export)      : max|velocity| = 0.000000000
       meico stderr clamp warnings   : ['Invalid curvature value', 'Invalid protraction value'] (from the raw-1.5 job only)
  OK   empty tempoMap renders with milliseconds.* on all 69 notes (first onset 0.0, last 28080.0 ms) -> guarded by default
  OK   negative control (bpm x1.01): max|onset| = 165.017 ms
  OK   negative control (volume +1): max|velocity| = 1.000
  OK   note-count mismatch raises: self_ref.msm: note count 69 != 68 in the score

RESULT: ALL SELFTESTS PASS
exit=0

=== 4. FORMATS (_jd vs this JDK's Double.toString) ===
_jd vs Double.toString on java openjdk version "17.0.1" 2021-10-19 LTS

domain                                       n  spelling!=  value!=
project domain (dates/mta/curv/prot)     26216           0        0
random in [1e-3, 1e7)                    70000           0        0
random bit patterns (any exponent)       50000         164        0
edge cases                                  23           2        0
TOTAL                                   146239         166        0

spelling mismatches [random bit patterns (any exponent)] (first 4 of 164), all value-identical:
   java=-4.6398703355621528E16       ours=-4.639870335562153E16        same double=True
   java=-2.15837146700674112E17      ours=-2.158371467006741E17        same double=True
   java=1.13487810963718042E18       ours=1.1348781096371804E18        same double=True
   java=4.9195802481480212E18        ours=4.919580248148021E18         same double=True

spelling mismatches [edge cases] (first 4 of 2), all value-identical:
   java=9.999999999999999E22         ours=1.0E23                       same double=True
   java=4.9E-324                     ours=5.0E-324                     same double=True

_num spot check: ['181.7', '43', '0', '-0', '100.123456', '2.675']
RESULT: EXACT in the project domain, value-preserving everywhere
exit=0

=== 5. ARG GUARDS ===
$ python3 validate_export.py --stress 0
--stress needs at least 1 trial
exit=1
$ python3 validate_export.py --bogus
unknown mode --bogus  (+ usage, exit 1)

=== 6. _jd VALUES THAT WERE WRONG BEFORE ===
   10000000.0               -> 1.0E7          (was "10000000.0")
   0.0005                   -> 5.0E-4         (was "0.0005")
   1e+20                    -> 1.0E20         (was "1e+20")
   -0.0                     -> -0.0           (was "0.0")
   0.0001                   -> 1.0E-4         (was "0.0001")
   12345678.0               -> 1.2345678E7    (was "12345678.0")
   nan/inf/-inf             -> NaN/Infinity/-Infinity   (was Python repr)
   0.0 -> 0.0 ; 0.25 -> 0.25 (unchanged, canonical domain)

=== 7. CANONICALIZATION DEMO (unsorted + out-of-range input) ===
in : tempo [[7200,60,None,None],[0,120,90,1.4],[3600,80,100,0.3]]
     dyn   [[3600,90,None,None,None],[0,40,90,1.5,-2.0]]
out: <tempoMap><tempo date="0.0" bpm="120" beatLength="0.25" /><tempo date="3600.0" bpm="80" transition.to="100" beatLength="0.25" meanTempoAt="0.3" /><tempo date="7200.0" bpm="60" beatLength="0.25" /></tempoMap>
     <dynamicsMap><dynamics date="0.0" volume="40" transition.to="90" curvature="1.0" protraction="-1.0" /><dynamics date="3600.0" volume="90" /></dynamicsMap>
canonicalized rows the oracle must use:
([[0.0, 120.0, None, None], [3600.0, 80.0, 100.0, 0.3], [7200.0, 60.0, None, None]],
 [[0.0, 40.0, 90.0, 1.0, -1.0], [3600.0, 90.0, None, None, None]])
(meanTempoAt 1.4 collapsed to a constant at the start value, exactly as TempoMap.java:255-257 does)

=== 8. MEICO PARSER TOLERANCE PROBE (re-run, 12 cases, ONE JVM, prefixed-ns case FIXED) ===
RenderMpm batch: 12 jobs, 0 failed | stderr: No MPM part found that corresponds to MSM part 1 "Piano"
reference: 69 notes, first (0.0, 732.2014975071014, 44.1), last (33151.03968150688, 35258.76801874341, 79.9)
no-xmlns               IDENTICAL   first=(0.0, 732.2014975071014, 44.1)
wrong-ns               IDENTICAL   first=(0.0, 732.2014975071014, 44.1)
prefixed-root-only     IDENTICAL   first=(0.0, 732.2014975071014, 44.1)
prefixed-everything    IDENTICAL   first=(0.0, 732.2014975071014, 44.1)      <- the case that was never tested
no-beatLength          NO milliseconds.* ->  accidentals,date,date.perf,duration,duration.perf,midi.pitch,modified,octave,pitchname,velocity,...
no-meanTempoAt-05      DIFFERS max 114.458003   first=(0.0, 725.4312444454255, 44.1)
explicit-mta-05        DIFFERS max 114.458003   first=(0.0, 725.4312444454255, 44.1)
attr-order-shuffled    IDENTICAL   first=(0.0, 732.2014975071014, 44.1)
no-decl                IDENTICAL   first=(0.0, 732.2014975071014, 44.1)
ppq-mismatch-360       DIFFERS max 14176.920804   first=(0.0, 736.5555231599039, 44.1)
no-part-element        IDENTICAL   first=(0.0, 732.2014975071014, 44.1)
fully prefixed document actually emitted:
<?xml version="1.0"?>
<m:mpm xmlns:m="http://www.cemfi.de/mpm/ns/1.0"><m:performance name="perf" pulsesPerQuarter="720"><m:global><m:header /><m:dated><m:tempoMap><m:tempo date="0.0" bpm="81.1" transition.to="113.5" beatLength="0.25" meanTempoAt="0.57" />...

=== 9. ROOT CAUSE OF THE ~1e-12 ms STRESS RESIDUAL (scratchpad probe) ===
$ python3 diag_stress.py
trial 23 [out-of-range curv/prot/mta] note 13 date=5760.0 diff=9.094947017729282e-13
   meico=6226.416094860049 ours=6226.416094860048
trial 34 [duplicate dates] note 3 date=1440.0 diff=1.1368683772161603e-13
trial 36 [dangling final transition] note 11 date=4860.0 diff=9.094947017729282e-13
trial 39 [duplicate dates] note 12 date=5040.0 diff=4.547473508864641e-13
$ python3 pow_check.py
7682 distinct (x, meanTempoAt) pairs from the 40 stress maps
log(0.5)/log(mta) differs: 434/7682
Math.pow(x, e)   differs: 935/7682
   x=0.875              mta=0.785 java=0.6822538348602609  python=0.682253834860261   rel=1.627e-16
   x=0.6875             mta=0.785 java=0.3420164628120441  python=0.3420164628120442  rel=1.623e-16
   x=0.9375             mta=0.785 java=0.8312709696243874  python=0.8312709696243875  rel=1.336e-16
   x=0.625              mta=0.834 java=0.16617328974526985 python=0.16617328974526982 rel=1.670e-16
=> the residual is a JVM-vs-CPython transcendental 1-ULP difference, not an export or port bug.

=== 10. BACKWARDS COMPATIBILITY / ENVIRONMENT ===
$ java ... RenderMpm /tmp/expC_debug/piece0.msm /tmp/expC_export/piece0_export.mpm /tmp/expC_export/single_check.msm
RenderMpm: wrote /tmp/expC_export/single_check.msm      single-mode exit=0
$ java ... RenderMpm            -> usage on stderr, exit 1
$ python3 -m py_compile dsl_to_mpm.py validate_export.py  -> py_compile OK
$ ps | grep -c "[t]rain.py 12 v2"  -> 3   (training left running throughout)

## open_issues
[
 "`ml/python/infer.py` (not my file) calls `maps_to_mpm(tempo, row.get('dyn_map'))` in a loop and now can raise `MpmExportError` \u2014 `dsl.decode_piece` is deliberately tolerant, so a model can emit bpm 0, a negative date, or a non-numeric field. One-line fix for its owner: wrap in `try: ... except MpmExportError as e: row['export_error'] = str(e)` (import from dsl_to_mpm) so one bad piece cannot abort a whole inference run.",
 "Render-space evaluators (`infer.py::render_rmse`, `evaluate.py`) score model maps with tempo_math/dynamics_math on the RAW rows. They must call `dsl_to_mpm.canonicalize_maps()` first, otherwise they score a map meico would never render (unsorted rows, curvature/protraction outside [0,1]/[-1,1], meanTempoAt <=0 or >=1 \u2014 the last one makes tempo_math raise ZeroDivisionError/ValueError outright at mta==1.0 or mta<0).",
 "Still open from the original report: `dynamics_math.DynamicsTimeline` / `tempo_math.TempoTimeline` use float('inf') as the last instruction's end date where meico uses Double.MAX_VALUE; on a dangling final dynamics transition the Bezier bisection never terminates. validate_export still works around it with JavaTempoTimeline/JavaDynamicsTimeline.",
 "Exactness floor discovered: JVM `Math.pow`/`Math.log` vs CPython libm differ by 1 ULP for ~12%/6% of the evaluated operands, so meico-vs-Python renders can only be *exactly* 0.0 on canonical value grids; off-grid maps carry <=1e-12 ms. Any future claim of 'bit-exact' for v3+ maps (rubato/articulation/movement, all of which use pow/exp) should quote a tolerance, not 0.0.",
 "`maps_to_mpm` still covers tempoMap + dynamicsMap only; articulationMap/rubatoMap (v3) and movementMap (v4) need element vocabulary plus a matching validation pass. The v3 sampler already writes `articulation`/`rubato` into the JSONL.",
 "Per-part maps, styleDefs/style switches (v6 MDL compression) and non-0.25 beatLength are parameterized but untested; `require_start_at_zero` is enforced for tempo only \u2014 a dynamicsMap starting after date 0 is emitted as-is and was not stress-tested (dynamics_math returns 100.0 before the first instruction; meico's behaviour there is unverified).",
 "Default paths /tmp/exp_pilot.jsonl and /tmp/exp_debug are still shared with other agents' scripts; I validated against isolated /tmp/expC_* via EXPORT_JSONL/EXPORT_DEBUG/EXPORT_WORK. Giving each team its own default dir is still worth doing.",
 "beatLength remains mandatory and silently dropped when absent (no error, exit 0, no milliseconds.* in the output) \u2014 parse_notes now raises on that signature, but any *new* map-export code path must be checked for the same class of silent-drop attribute requirement before trusting a non-crashing render."
]

