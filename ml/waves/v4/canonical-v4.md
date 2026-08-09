# canonical-v4 — built

## report
## Team F deliverables — canonical spec v4 + the Vienna representation ceiling

### Headline results (both are program-level decisions)

**1. THE OPEN QUESTION IS CLOSED: the tempo representation ceiling is NOT what broke v1 sim2real.**
On the same 40 Vienna windows v1 was evaluated on, the *oracle* canonical tempo map (best member of the v1/v3 hypothesis class, fitted with full knowledge of the target) reaches a median **53.2 ms** render RMSE. At the model's **own 65-token budget** an oracle reaches **76.5 ms**. v1 produced **3456 ms**, and is worse than a one-instruction constant tempo in **40/40 windows**. Per-piece the ceiling explains **0.9 / 1.3 / 1.8 / 1.9 %** of the v1 error (op10/3, op38, K331, D783) — i.e. **98–99 % is domain gap + model failure**. Domain randomisation (already queued in LOG.md) is the right fix; no change to CANONICAL.md §§1–7 is needed.

**2. The movementMap is by far the most expensive map in MPM, and its fidelity is a function of segment duration in *milliseconds*, not beats.** A real Bösendorfer sustain trace (sd 32.2 cc, 88.9 % of elapsed time strictly between 0 and 127 — genuine half-pedalling) costs **959–2223 canonical tokens per performance** (9–21 tokens/second) vs the **85.5-token** whole-piece tempo+dynamics budget. A 1-beat grid explains essentially nothing (29.8 cc vs sd 32.2); a 1/4-beat grid reaches 19.1 cc (12.1 cc with free curvature/protraction). RMSE ≈ halves per halving of segment duration below ~1 s: 9.5 cc @128 ms, 15.5 @256, 24.8 @512, ~30 @≥1 s. Recommendation: v4 samples the **notational** pedal band (pedal cycles at 1 per 2–4 beats, ~170 tokens for a 32-beat piece) and evaluates with **CC-64 threshold agreement** alongside CC RMSE; the residual 12–19 cc is a v5 movement-imprecision band.

### Secondary findings worth the orchestrator's attention

- **Correction to findings.md §A (important, honest).** On *real* performances the power-transition family does **not** dominate the staircase at equal DL: medians of per-window ratios `stair-4/power-8 = 0.83 RMSE at 0.91× DL`, `stair-2/power-4 = 0.91 at 0.96× DL`; some staircase dominates power-4 in **28/40** windows, no power chain dominates stair-2 in **0/40**. Against a staircase on the *same* grid the transition still wins (`power-4/stair-4 = 0.73` RMSE at 2.12× DL). Reading: human rubato lives at the 0.5–2 beat scale, below the canonical ≥4-beat segment. H1 stays as the attribution rule; findings.md §A's MDL dominance is sampler-internal and must not be quoted about humans. Recorded as decision **D2** in CANONICAL.md §14.
- **The irreducible timing floor is 16.8 ms and it is *entirely* chord asynchrony.** `isotonic == chord-floor` in **40/40** windows (per-tick mean onsets are already monotone). A ½-beat staircase reaches **1.03×** that floor, so ~440 ms is the granularity at which a tempoMap saturates. Consequence: `ImprecisionMap` is a **~9 ms** effect (16.8 ms floor × the 27 % a constant asynchrony cannot explain), not a seconds effect — v5 priority is realism, not residual reduction (decision **D3**).
- **Asynchrony is cheap and well-posed.** Top-voice lead on 40 windows: median **21.6 ms** (p10 8.9, p90 32.3), sd 13.8 ms, and a single constant offset explains **73 %** of its second moment. Positive in 40/40 windows, which makes "part 1 = leading voice" (rule Y5, dodging meico's `Math.max(0.0, …)` clamp) the natural assignment. ~27 tokens per piece. **Recommendation: ship asynchrony before movement.**
- **Two NEW fork defects, both reproduced against meico@1d662105** (probes run from scratchpad; not committed):
  - `MovementMap.getPreviousPosition` loops `for (j = index-1; j > 0; --j)` → **instruction #1 can never inherit `position`**; chain `[0: .1→.9][720: omit→.2]` renders `114.3 → 0.0` (full pedal drop). Index ≥2 inherits correctly.
  - Same method dereferences `getAttribute("transition.to").getValue()` unguarded → **NullPointerException at `MovementMap.java:203`** when an omitted `position` follows a plateau.
  Both one-line fixes (`j >= 0`; null-guard). They cost **36 % of the movement DL** (959 → 1508 tokens) because canonical form must currently write `position` on every instruction (rule M6). Also flagged: `Msm.parsePositionMap` maps any unknown `controller` string to `controllerNumber = 0` = **CC 0 Bank Select MSB** (hence rule M7 restricting controller to sustain/soft).
- **Renderer property that fixes the minimum segment length**: `MovementData.getTForDate` stops at an x-error < 1 **tick**, so a segment of `L` ticks carries up to `127/L` CC of systematic error — measured exactly (2.82 cc @45 ticks, 0.71 @180, 0.50 @254). Below ~180 ticks the renderer's own inversion error exceeds the CC quantiser and curvature/protraction stop meaning anything → **M3: 1/4-beat grid, segments ≥ 180 ticks**.
- **`movementSampleMaxStep = 0.1` is the right default**: zero-order-hold sampling costs only +1.2…+1.8 cc; 0.02 buys ~0.4 cc for 4.7× the events and 4.7× the quadratic sampling time.
- **The tick-0 burst caveat resolves cleanly**: on 20/20 performances `n_dropped_duplicates == n_burst − 1` *exactly* — every duplicate timestamp lies inside the opening burst, so last-wins collapsing is one rewrite, not two. Collapsed opening state is > 0 in 20/20 (median CC 85).

### What was written

**`ml/CANONICAL.md`** — appended a v4 addendum (§§8–14); nothing above §7 rewritten. §8 attribution amendment + H6 (movement owns the CC stream) / H7 (asynchrony owns the between-part difference, tempo the common mode); §9 rules **M1–M10** + §9.9 identifiability of the pedal band; §10 rules **Y1–Y6** + §10.9; §11 v4 DSL (`G`, `Z`, `Y`, `J`; vocab 31→35, appended so earlier ids stay stable) with the measured DL table; §12 canonicalisation steps 12–19; §13 new residual ill-posedness; §14 decision record **D1/D2/D3**.

**`ml/analysis/pedal_fit.py`** (NEW) — fits a canonical movement chain to a real `sustain_cc` stream. Exact vectorised port of `MovementData.getPositionAt` / `getMovementSegment`; last-wins + burst collapse; empirical tick↔ms map from matched onsets; bounded LS for positions (the chain is *linear* in the position vector for fixed shape), alternating per-segment curvature/protraction grid search; uniform-grid and Douglas-Peucker adaptive families; DL counter for three encodings; renderer-faithful re-render (sample + round + ZOH). Modes: `validate`, `--java-proof`, `--n`, `--quick`. ~6 min for 20 performances.

**`ml/analysis/vienna_ceiling.py`** (NEW) — the oracle ceiling. Reuses `staircase_fit` for stair-8/4/2/1/0.5 and the sub-beat greedy; adds `fit_power_chain` (continuous power-transition chain on a G-beat grid, `meanTempoAt` bounded to canonical [0.15,0.85], `scipy.least_squares` over the exact renderer), a weighted-PAVA isotonic floor, a chord floor, a DL-matched oracle vs `vienna_infer_windows.preds.json`, and `asynchrony_stats`. Modes: `validate`, `asynchrony`, `--n`, `--quick`. ~13 min for 40 windows; writes an incremental `out/vienna_ceiling.partial.json` so an interrupted run is not lost.

**`ml/analysis/findings_v4.md`** (NEW) — §0 proofs, §A pedal band (signal characterisation, bandwidth law, grid/shape/DL tables, the two fork defects), §B ceiling (B1 table, B2 v1 post-mortem, B3 granularity, B4 the findings.md §A correction), §C v4 sampler recommendations (movement, asynchrony, the granularity/imprecision verdict), §D chord asynchrony.

### API / implementation discoveries useful downstream

- `curvature = protraction = 0` makes the movement Bézier an **exact linear ramp** in value (up to the 127/L tick-resolution floor) — useful for any linear-algebra fitter; and `curvature = 0.4 / protraction = 0` are meico's field defaults, so those are the free-to-omit values (a "linear" canonical default would cost +4 tokens on every segment for 0.1–0.7 cc).
- `MovementMap.renderMovementToMap` iterates `movementIndex < size()-1`: **the last instruction never renders** → a terminator is mandatory (movement analogue of G7/R6).
- `positionMap` is pushed through tempo + asynchrony but **not** rubato and **not** imprecision (`Performance.java:514-551`) → the dependency graph is strictly triangular, and pedal event times are the only *noise-free* observation of the tempo curve once v5 lands.
- Perf note for anyone reusing `python/tempo_math.py` in an optimiser loop: `java_libm.java_pow` is **75× slower** than `math.pow` (15.3 µs vs 0.20 µs/call). `vienna_ceiling.FastTimeline` is a vectorised libm twin proven equal to the exact renderer to 7e-12 ms (proof V4) — reuse it for fitting, keep the exact one for reporting.
- Another agent landed `ml/python/movement_math.py` / `asynchrony_math.py` concurrently (scalar exact ports of the same renderer code). No conflict: `pedal_fit.py` needs a *vectorised* Bézier for its LS design matrix and proves it 0-diff against Java directly. A follow-up could have `pedal_fit` import `movement_math.get_movement_segment` for the scalar path — they must agree by construction.

## files_changed
[
 "/Users/nielspfeffer/Projects/mpmify/ml/CANONICAL.md",
 "/Users/nielspfeffer/Projects/mpmify/ml/analysis/pedal_fit.py",
 "/Users/nielspfeffer/Projects/mpmify/ml/analysis/vienna_ceiling.py",
 "/Users/nielspfeffer/Projects/mpmify/ml/analysis/findings_v4.md"
]

## validation_output
$ nice -n 15 python3 pedal_fit.py validate --java-proof
==============================================================================
Exactness proofs (project standard: 0-diff)
==============================================================================
V1 vectorised Bezier vs python/dynamics_math (audited scalar port) : 4000/4000 bit-identical, max |diff| = 0
V2 vectorised Bezier vs meico MovementData.getPositionAt        : 4000/4000 bit-identical, max |diff| = 0
V3 movement_segment vs MovementData.getMovementSegment(0.1)     : 17/17 points, max |diff| = 0
V4 renderer resolution floor (curvature=0, exact answer is linear):
     segment    45 ticks -> max |curve - line| =  2.821 cc (= 127/L =  2.822)
     segment    90 ticks -> max |curve - line| =  1.411 cc (= 127/L =  1.411)
     segment   180 ticks -> max |curve - line| =  0.705 cc (= 127/L =  0.706)
     segment   254 ticks -> max |curve - line| =  0.500 cc (= 127/L =  0.500)
     segment   360 ticks -> max |curve - line| =  0.352 cc (= 127/L =  0.353)
     segment   720 ticks -> max |curve - line| =  0.176 cc (= 127/L =  0.176)

$ nice -n 15 python3 vienna_ceiling.py validate
====================================================================================
Exactness proofs (project standard: <= 1e-9 ms)
====================================================================================
V1 staircase design matrix vs meico constant-tempo rendering : max |diff| = 0.000000000007 ms (200 staircases x 40 notes)
V2 degenerate power chain vs closed-form constant tempo       : max |diff| = 0.000000000004 ms (200 chains x 30 notes)
V3 isotonic <= chord-mean <= 1-beat staircase on 20 windows   : 0 violations
V4 fast (libm) power renderer vs exact (fdlibm) tempo_math    : max |diff| = 0.000000000007 ms (120 chains x 60 notes)

$ nice -n 15 python3 vienna_ceiling.py --n 40          # 790 s
40 Vienna windows over 4 pieces, 10 pianists
====================================================================================
A. Representation ceiling -- render RMSE (ms), medians over 40 windows
====================================================================================
explanation           RMSE med  RMSE p90   DL med  instr  vs const
const                    316.8     487.9        8      1      1.00
stair-8                  131.5     274.0       50      6      0.42
power-8                   87.6     243.6      112      7      0.28
stair-4                   71.0     206.2      103     12      0.22
power-4                   53.2     112.1      217     13      0.17
stair-2                   46.7     142.1      205     24      0.15
stair-1                   36.0      60.2      410     46      0.11
stair-0.5                 24.8      49.0      574     65      0.08
greedy-best               24.8      32.4      473     48      0.08
dl-matched-oracle         76.5     231.0       60      -      0.24
v1-model                3455.9    9340.7       65      4     10.91
isotonic                  16.8      28.9        -      -      0.05
chord-floor               16.8      28.9        -      -      0.05

====================================================================================
C. Decomposition of the v1 sim2real error (medians)
====================================================================================
  Chopin_op10_no3        v1     9108 | canonical ceiling (power-4)    82.4 | DL-matched oracle   229.5 | sub-beat greedy   28.3 | any-tempo floor   16.2
                         -> ceiling explains   0.9 % of the v1 error; model failure  99.1 %
  Chopin_op38            v1     4181 | canonical ceiling (power-4)    56.2 | DL-matched oracle    70.7 | sub-beat greedy   20.4 | any-tempo floor   15.6
                         -> ceiling explains   1.3 % of the v1 error; model failure  98.7 %
  Mozart_K331_1st-mov    v1     2494 | canonical ceiling (power-4)    45.2 | DL-matched oracle    79.7 | sub-beat greedy   19.6 | any-tempo floor   14.9
                         -> ceiling explains   1.8 % of the v1 error; model failure  98.2 %
  Schubert_D783_no15     v1     2445 | canonical ceiling (power-4)    45.6 | DL-matched oracle    56.3 | sub-beat greedy   25.9 | any-tempo floor   25.8
                         -> ceiling explains   1.9 % of the v1 error; model failure  98.1 %

====================================================================================
D. Canonical granularity real playing demands (median RMSE by segment length)
====================================================================================
  stair-8    segment  8.0 beats =   6987 ms   RMSE   131.5 ms   DL    50 tokens
  stair-4    segment  4.0 beats =   3493 ms   RMSE    71.0 ms   DL   103 tokens
  stair-2    segment  2.0 beats =   1747 ms   RMSE    46.7 ms   DL   205 tokens
  stair-1    segment  1.0 beats =    873 ms   RMSE    36.0 ms   DL   410 tokens
  stair-0.5  segment  0.5 beats =    437 ms   RMSE    24.8 ms   DL   574 tokens

====================================================================================
E. Chord asynchrony ('top voice' vs 'the rest'), 40 windows
====================================================================================
quantity                              median       p10       p90
per-window median lead (ms)           21.615     8.854    32.292
per-window mean lead (ms)             21.364     5.505    30.758
per-window sd of the lead (ms)        13.849    10.271    24.954
variance share of a CONSTANT offset     0.728     0.063     0.860
chords per window                         66

paired checks (medians of per-window ratios, 40 windows):
  stair-4      / power-8       rmse ratio  0.83   dl ratio  0.91
  stair-2      / power-4       rmse ratio  0.91   dl ratio  0.96
  power-4      / stair-4       rmse ratio  0.73   dl ratio  2.12
  power-4            / v1 = 0.0159      dl-matched-oracle / v1 = 0.0248
  isotonic           / v1 = 0.0048      const             / v1 = 0.0838
  windows where v1 is WORSE than the constant baseline: 40/40
  windows where some staircase dominates power-4 (<=DL and <RMSE): 28/40
  windows where a power chain dominates stair-2: 0/40
  floor == chord-floor in all windows: True ;  stair-0.5 / floor = 1.03 ;  power-4 / floor = 3.25

$ nice -n 15 python3 pedal_fit.py --n 20 --java-proof   # 315 s
20 Vienna performances: Chopin_op10_no3, Chopin_op38, Mozart_K331_1st-mov, Schubert_D783_no15
==============================================================================
A. Canonical movement chain vs real half-pedalling (medians over 20 performances)
==============================================================================
family        shape      n_seg  seg ms    RMSE  RMSE_tw  rendered      DL  tok/seg   tok/s
uniform-4     default       26    3743   31.10    35.50     31.74     138      5.2      1.4
uniform-2     default       52    1889   30.65    34.86     31.38     268      5.1      2.7
uniform-1     default      104     953   29.82    35.25     31.50     544      5.1      5.3
uniform-1     free         104     953   27.39    31.25     30.11    1286     12.3     12.7
uniform-0.5   default      208     478   25.82    29.15     27.12    1049      5.1     10.5
uniform-0.25  default      416     239   19.06    20.25     20.98    2033      5.1     21.0
uniform-0.25  free         416     239   12.13    12.65     15.14    4059     10.5     44.2
rdp-50        default       48    2087   29.96    33.25     31.10     266      5.6      2.6
rdp-200       default      187     564   21.15    24.59     22.37     959      5.2      9.0
rdp-200       free         187     564   16.96    19.47     18.81    2223     12.2     21.3
rdp-400       default      338     332   14.41    17.17     16.16    1656      5.0     15.5
constant      -              1       -   32.23
signal std (cc): median 32.23   values strictly in (0,127): 98.0 %

B. Per-piece breakdown
piece                   beat ms    std  u1 RMSE   u0.25   rdp200  rdp200 DL   tok/s
Chopin_op10_no3            1804   33.6    30.23   26.61    21.63       1124     8.8
Chopin_op38                 941   32.1    29.41   20.06    24.79       1671     7.9
Mozart_K331_1st-mov         968   29.7    27.09   19.45    21.15       1596     9.2
Schubert_D783_no15          410   39.5    34.12   11.89     7.22       1520    23.9

C. Encoding cost of one movement chain (rdp-200, medians)
  shape = default  (187 segments, 0 non-default shapes)
    beats_norm      1968 tokens   (10.5 / segment)
    beats_cc        1668 tokens   (8.9 / segment)
    delta_cc         959 tokens   (5.1 / segment)
    delta_cc + explicit position    1508 tokens   (8.1 / segment)
  shape = free  (187 segments, 174 non-default shapes)
    delta_cc        2223 tokens   (11.9 / segment)

burst-collapse audit (20/20 performances): n_dropped_duplicates == n_burst - 1 exactly
opening state after collapse: [5,11,11,18,50,59,68,70,79,81,89,114,117,118,122,123,124,125,125,126]  (median 85, >0 in 20/20)

$ fork-defect probes (meico@1d662105, compiled+run from scratchpad)
InheritProbe: chain [0: .1->.9][720: omit->.2][1440: term]
  date=720.0 value=114.3 / date=720.0 value=0.0     <-- index-1 inheritance broken
  (same omission at index 2 inherits correctly: value stays 63.5 -> 114.3)
NpeProbe: omitted position after a plateau
  THROWS java.lang.NullPointerException at meico.mpm.elements.maps.MovementMap.getPreviousPosition(MovementMap.java:203)

$ python3 -c "import ast; [ast.parse(open(f).read(),f) for f in ('pedal_fit.py','vienna_ceiling.py')]"
AST OK

## open_issues
[
 "GATE respected: no accentuation supervision data generated (none of my code touches accentuation). Also no dataset generation and no training were run; all compute was <= 20 min chunks at nice -n 15 alongside the v3.1 run.",
 "Two NEW meico fork defects found and reproduced but NOT fixed (../bugs.md and ../meico are outside my file allowlist): MovementMap.getPreviousPosition off-by-one loop bound (`j > 0` should be `j >= 0`) and an unguarded getAttribute(\"transition.to\").getValue() -> NPE at MovementMap.java:203. Fixing both unlocks position inheritance and cuts movement DL by 36 % (CANONICAL.md M6 relaxes automatically). meico-ts mirrors this code bug-for-bug by design, so a fix needs the same coordination as the 2026-08-08 round.",
 "Msm.parsePositionMap maps any unknown `controller` string to controllerNumber = 0 (CC 0 = Bank Select MSB) instead of rejecting. Currently handled by normative rule M7 (controller in {sustain, soft} only); a renderer-side guard would be safer.",
 "CANONICAL.md \u00a70's scope caveat now has an answer but I did not edit \u00a70 (instructed to append only). The v4 header and \u00a714 carry the pointer; someone with \u00a70 in scope should update its last sentence (\"it has not been run\").",
 "The v4 DSL token assignment (G, Z, Y, J -> vocab 35) is proposed, not implemented: python/dsl.py still stops at the v3 vocab of 31. Needs the same B1 vocab-freeze discipline (per-version sizes, resume-mismatch abort) when it lands.",
 "vienna_ceiling.py's default POWER_GRIDS = (8, 4). A 2-beat power chain costs ~33 s/window (vs ~10 s at 4 beats) and only interpolates between stair-2 and stair-1, so it is off by default; add 2 to POWER_GRIDS to price it.",
 "A first 40-window run was killed at ~55 min by the harness before writing its JSON. The script now writes out/vienna_ceiling.partial.json after every window; the completed run took 790 s after dropping power-2.",
 "pedal_fit.py duplicates a vectorised Bezier that another agent's new ml/python/movement_math.py now covers scalar-side. Both are proven 0-diff against meico, so they must agree; consolidating (pedal_fit importing movement_math for the scalar path) is a safe cleanup once that file is stable."
]

# canonical-v4 — verify

## verdict
ISSUES

## issues
[
 "I1 (most material) \u2014 the headline \"959 canonical tokens\" is measured on a chain that VIOLATES M3. CANONICAL.md \u00a711's DL table row \"**1/4-beat delta dates, integer CC positions** (canonical) \u2014 **959** \u2014 **5.1**\" and the report's \"959\u20132223 canonical tokens per performance\" both come from the `rdp-200` family. In /Users/nielspfeffer/Projects/mpmify/ml/analysis/pedal_fit.py:580-590 that family snaps boundaries to `step = 0.125 * PPQ` = **90 ticks** with `min_gap = step`, and prices dates with `grid_ticks=step` (1/8-beat units, not the 1/4-beat units \u00a711 specifies). I measured the resulting segment lengths: Chopin_op10_no3_p01 \u2192 83 of 149 segments are exactly 90 ticks; Chopin_op38_p01 \u2192 24 of 198. M3 mandates a 180-tick grid and segments \u2265180 ticks. The M3-compliant chain is `uniform-0.25`: **2033** tokens (default shape) / **4059** (free). The qualitative conclusion (\"movement is 10\u201325\u00d7 the whole tempo+dynamics budget\") is unchanged or strengthened, but the number labelled canonical is not a canonical chain.",
 "I2 \u2014 `fit_chain` is NOT bounded least squares, contrary to its docstring, CANONICAL.md M8 step (4) (\"fit positions by bounded least squares\") and findings_v4 \u00a7A3. pedal_fit.py:260 and :276 run unconstrained `scipy.sparse.linalg.lsqr` then `np.clip(p, 0.0, 1.0)`. The bound is genuinely active: 22/150 and 19/199 fitted positions sit at 0 or 1 on the two performances I checked. Against a true `scipy.optimize.lsq_linear` bounded solve the shipped fit is 0.42\u20130.76 cc WORSE at the 1/4-beat grid (0.000 cc at 1-beat). Direction is conservative (the reported pedal residual is a slight over-estimate), but an \"oracle/ceiling\" framing implies optimality it does not have.",
 "I3 \u2014 `movement_segment` diverges from meico for plateau instructions. meico's `MovementData.getMovementSegment` appends the trailing `[endDate, transitionTo]` point only `if (this.transitionTo != null)`; pedal_fit.py:168 appends it unconditionally. I confirmed the divergence two ways: a 200-case Java probe against meico@1d662105 (190 transition cases 0-diff; **10/10 plateau cases off by one point**) and against the concurrent `ml/python/movement_math.py` (500/500 transition cases 0.0 diff; **500/500 plateau length mismatches**). No reported number is wrong (pedal_fit always passes an explicit `p1`), but M5 makes plateaus the dominant canonical instruction, so reuse of this function on a canonical chain will diverge. The shipped V3 proof exercises exactly ONE parameter tuple, which is why this was invisible. `movement_math.py` (Q4) handles it correctly \u2014 the report's \"they must agree by construction\" is false for this case.",
 "I4 \u2014 \"some staircase dominates power-4 in 28/40 windows\" (report, findings_v4 \u00a7B4, CANONICAL.md \u00a714 D2) is **28/28 stair-2**, i.e. a 2-beat competitor that violates canonical T1 (segments \u22654 beats). Restricted to canonical (\u22654-beat) staircases the count is **1/40**. The statistic appears bare in a normative decision record; the surrounding prose does explain the granularity mechanism, but the number invites misquotation. The fully-canonical version is sound and stronger: stair-4/8 dominates power-8 in **36/40**, and the quoted `stair-4 / power-8 = 0.83 RMSE at 0.91\u00d7 DL` is a legitimate intra-canonical comparison.",
 "I5 \u2014 undisclosed sampling bias: all 40 ceiling windows are `_w0`. `vienna_ceiling.select()` strides `sorted(by_piece[p], key=id)[::step][:10]`, which on this corpus (220 windows = 88 w0 + 88 w1 + 44 w2) lands EXCLUSIVELY on the first window of each performance. Every \u00a7A\u2013\u00a7E number therefore describes piece OPENINGS, not a representative sample. Consequence visible in the data: per-piece v1 medians here (9108/4181/2494/2445) differ from LOG.md's all-window figures (8990/3959/3565/2889). Neither the report nor findings_v4 \u00a7B states this.",
 "I6 \u2014 two output blocks quoted as script output are produced by no committed script. The \"paired checks (medians of per-window ratios, 40 windows)\" block and the \"burst-collapse audit / opening state after collapse\" lines are absent from `vienna_ceiling.main()`, `pedal_fit.main()` and from `out/vienna_ceiling.log` / `out/pedal_fit.log`. I reproduced every one of those numbers independently from the JSON and raw corpus (all exact), so they are correct \u2014 but findings_v4.md's \"Reproduce everything with\" recipe does not regenerate them.",
 "I7 \u2014 findings_v4 \u00a7A1 mislabels its aggregation. The rows \"time share with 0<cc<127 = 88.9 % (5.3 % down, 5.9 % up)\" and \"time-weighted quantiles p05 0, p25 28, p50 74, p75 102, p95 127\" are POOLED dwell-weighted statistics across all 20 performances, not \"median over the 20 performances\" as the column header says. Median-of-per-performance gives 91.6 % and [1.5, 38, 74, 93.5, 116]; the pooled computation reproduces the reported values exactly (0.8886 / 0.0525 / 0.0589 and [0, 28, 74, 102, 127]). Pooling is dominated by the longest performances. `analyse()` stores only the UNWEIGHTED 98.0 %, so neither row is recoverable from `out/pedal_fit.json`.",
 "I8 \u2014 the plateau/release levels that feed the v4 sampler recommendation do not reproduce and are unauditable. findings_v4 \u00a7A1/\u00a7C1 quote \"plateau (local maxima >40 cc) p10 56, med **89**, p90 **124**\" and \"release (local minima <90 cc) p10 0, med **8**, p90 **66**\", which become the sampler ranges `plateau ~ U[56,124]` / `release ~ U[0,66]`. With a plain local-extremum definition I get med **86** / p90 123 and med **13** / p90 **73**. The extremum definition exists in no committed script.",
 "I9 \u2014 mixed DL accounting for the DL-matched oracle. `vienna_ceiling.analyse` uses `preds[\"dl_tokens\"]` (= `len(decoded ids)` from `infer.py`) as the budget, while every competitor's DL comes from `mdl.dl_tempo_map`. On the v1 maps the two counters differ by up to 20 tokens (medians 65 vs 63). Small, and in the oracle's favour, so it does not threaten the headline \u2014 but the \"model's own 65-token budget\" is not the same unit as the 60-token oracle DL it is compared against.",
 "I10 \u2014 forward/inverse tick\u2194ms maps disagree past the last note. `render_chain_cc` (pedal_fit.py:410) uses `np.interp`, which CONSTANT-clamps outside `tmap.ticks`, while `ScoreTimeMap.to_ticks` linearly EXTRAPOLATES the same map (pedal outlives the last note, as its own docstring notes). Measured exposure: 31/1289 and 17/1823 chain events, and 103/3100 and 70/5496 observed points, fall outside the note range on the two performances checked \u2014 so `rmse_rendered_step0.1/0.02` is slightly degraded at the tail. The primary `rmse` column is unaffected.",
 "I11 \u2014 three minor internal inconsistencies in CANONICAL.md \u00a79/\u00a711. (a) M9 says \"only ~7 % of the RMSE gain of free shapes survives at canonical density, but at 1/4-beat density free shapes cut RMSE by 36 %\" \u2014 self-contradictory, since M3 MAKES 1/4-beat the canonical density; the ~7 % (actually 6.1 % = 0.42/6.93) is the 4-beat grid. (b) \u00a711's grammar gives the terminator as `G <date> C` with no `position`, while M6 requires `position` on EVERY instruction; `dl_movement_chain` (pedal_fit.py:390) follows the grammar, so spec and counter disagree by ~4 tokens per chain. (c) \u00a711's \"absolute fractional-beat dates cost 1.9\u00d7 as many tokens\" \u2014 the measured medians of per-performance ratios are 2.02 (`beats_norm/delta_cc`) and 1.73 (`beats_cc/delta_cc`); 1.9 is neither.",
 "I12 \u2014 terminology drift on the 73 %, and a heuristic presented as a derivation. `asynchrony_stats` computes `mu\u00b2/(mu\u00b2+var)`, i.e. the share of the **second moment**; findings_v4 \u00a7D states this correctly, but CANONICAL.md \u00a710.9 and the report call it \"variance share\". Relatedly, D3's \"\u22488\u20139 ms left for ImprecisionMap\" is `sqrt(1\u22120.73) \u00d7 16.8 ms` \u2014 it applies the residual share of the *between-voice lead* to the *chord-floor's note-level RMSE*, two different quantities. Order of magnitude is right; it is not an identity. Also p10 of that share is 0.06, so the median 0.73 is far from robust across windows \u2014 D3 quotes it unqualified."
]

## evidence
SCOPE/HYGIENE. All 4 claimed files exist. `git diff --stat ml/CANONICAL.md` = **263 insertions, 0 deletions**, single hunk `@@ -373,0 +374,263 @@` — the "nothing above §7 rewritten" claim is exactly true. `ml/LOG.md` is also dirty but its diff is the orchestrator's v3.1/v4-wave entries, not Team F's. Both new scripts pass `ast.parse` and import cleanly. GATE respected: zero accentuation code or data (only two prose mentions). `python/dsl.py` VOCAB is still 31 tokens `['<pad>','<bos>','<eos>','T','B','C','R','M','0'..'9','.','D','V','Q','P','-','U','F','I','X','A','L','W']` — `G/Z/Y/J` unused, so the 31→35 append-only proposal is consistent and correctly flagged as un-landed. CANONICAL.md §5's "85.5 tokens" (line 288) checks out.

EXACTNESS PROOFS RE-RUN (nice -n 15, my own invocations). `pedal_fit.py validate --java-proof` → V1 4000/4000 bit-identical max|diff|=0; V2 4000/4000 vs `MovementData.getPositionAt` max|diff|=0; V3 17/17 points max|diff|=0; V4 resolution table byte-identical to the report (2.821/1.411/0.705/0.500/0.352/0.176 cc). The Java path really runs — `subprocess.run(..., check=True)` on both javac and java, no silent fallback. `vienna_ceiling.py validate` → 0.000000000007 / 0.000000000004 / 0 violations / 0.000000000007 ms. All reproduce to the printed digit.

AGGREGATES RECOMPUTED FROM out/*.json. Every row of tables A–E reproduces: const 316.85, stair-8 131.54, power-8 87.64, stair-4 71.03, power-4 53.17, stair-2 46.74, stair-1 36.01, stair-0.5 24.83, greedy 24.77, dl-matched 76.50, v1 3455.86, isotonic = chord-floor 16.81. The un-scripted "paired checks" block reproduces exactly: stair-4/power-8 0.829@0.913, stair-2/power-4 0.914@0.956, power-4/stair-4 0.726@2.117, power-4/v1 0.0159, dl-matched/v1 0.0248, isotonic/v1 0.0048, const/v1 0.0838, v1 worse than const **40/40**, staircase dominates power-4 **28/40**, power dominates stair-2 **0/40**, isotonic==chord-floor **40/40**, stair-0.5/floor 1.031, power-4/floor 3.255. pedal_fit tables A/B/C all reproduce to the last digit (uniform-1 29.82, uniform-0.25 12.13 free, rdp-200 21.15/959/1508, cc_std 32.23, burst audit 20/20, opening-state list identical incl. median 85). findings_v4 §A2's bucket table reproduces exactly with geometric bucket edges 128·2^(k±0.5) (9.5/9.5, 15.5/17.7, 24.8/27.6, 28.4/33.4, 30.2/34.1, 30.7/35.2, 32.8/38.5).

INDEPENDENT CROSS-CHECKS I ADDED (all pass). (1) Re-rendered v1's stored `tempo_map` through the exact `tempo_math.TempoTimeline`: max |mine − preds.render_rmse| = **3.6e-12 ms** over 40 windows → the "3456 ms vs 76.5 ms" comparison is metric-identical, not apples-to-oranges. (2) Re-ran `vienna_ceiling.analyse()` on 3 windows: **13/13 rows bit-identical** to stored on each. (3) Optimiser robustness — the shipped power-chain fits terminate on tolerance (nfev max 84 vs a ≥840 budget); a 6-restart multi-start at `max_nfev=4000, tol=1e-12` on 4 windows reproduces power-4 **to the last decimal** (73.60/47.31/41.58/51.73). D2 is therefore not an optimiser artifact. (4) The hand-rolled weighted PAVA in `isotonic_floor` matches `sklearn.isotonic.IsotonicRegression` on **0/300** mismatches over randomised pooling-active cases, and the per-tick means really are monotone in **40/40** real windows (so isotonic==chord-floor is a fact, not a code artifact). (5) `staircase_fit`'s silent-fallback counters over the whole 40-window × 5-grid workload: **6770 segments fitted, 0 bad_slope, 0 bpm_clamp, 0 linalg_error** — the rival explanation was never silently weakened.

FORK DEFECTS INDEPENDENTLY REPRODUCED (my own probe, meico@1d662105, /private/tmp/.../scratchpad/verify/VerifyProbe.java). Chain `[0: .1→.9][720: omit→.2][1440: term]` renders `date=720.0 value=114.3` then `date=720.0 value=**0.0**` — index-1 inheritance broken exactly as claimed; the same omission at index 2 inherits correctly (63.5→114.3→25.4). Omitted `position` after a plateau throws `java.lang.NullPointerException at meico.mpm.elements.maps.MovementMap.getPreviousPosition(MovementMap.java:203)`. Source confirms `for (int j = index - 1; j > 0; --j)` and the unguarded `getAttribute("transition.to").getValue()`. Also confirmed by source: `renderMovementToMap` iterates `movementIndex < this.size() - 1` (M1 rationale); `Msm.parsePositionMap:1115` initialises `short controllerNumber = 0` and overwrites only for "sustain"/"soft" (M7 rationale); `Performance.java` renders positionMap through `TempoMap` + `AsynchronyMap` only, never rubato, never imprecision (§9.9.3); `AsynchronyMap.java:142` `Math.max(0.0, …)` and `:163` `Math.max(ms, startDateMs+1)` (Y5/Y6 rationale). All renderer-property claims in the v4 addendum check out against the source.

BOTTOM LINE. Every numeric claim I could re-derive is real and reproducible, the two new fork defects are genuine, and the two headline verdicts (ceiling explains ~1–2 % of the v1 sim2real error; movement is the expensive map) survive scrutiny — the ceiling verdict is in fact conservative, because the canonical class also contains stair-4 and a mixed step/transition chain that the script never fits. The issues above are labelling, method-description and scoping defects, not arithmetic errors. Priority for fixes: I1 (relabel the DL headline or re-measure on the M3 grid), I3 (plateau port gap — will bite v4 sampler code), I2/I4/I5 (wording + disclosure), then the rest.

# canonical-v4 — fixed

## report
## Fix round for team `canonical-v4` — all 12 issues fixed, both measurements re-run from scratch

Every issue is fixed **in code**, not in prose: each one now either changes a number or is asserted/printed by the run that produces the number. Both scripts were re-executed end to end at `nice -n 15` alongside the v3.1 training (pedal 2098 s, ceiling 1613 s; no dataset generation, no training, no accentuation supervision).

**Two of the fixes moved headline results.** They are corrections in the honest direction and the qualitative conclusions survive.

### The two material corrections

**1 (I5) — the ceiling sample was piece openings only.** `vienna_ceiling.select()` strode `sorted(by_piece)[::step]` over a corpus whose 2–3 windows per performance are consecutive in id order (220 = 88 w0 + 88 w1 + 44 w2), so all 40 windows were `_w0`. Replaced with an explicit stratification (deterministic pianist permutation + window-index rotation, `SELECT_SEED`); the run now prints the realised mix (**w0 18 / w1 16 / w2 6, 19 pianists**). Every §B/§D number was re-measured:

| | first release (all `_w0`) | **corrected** |
|---|---|---|
| const baseline | 316.8 ms | **383.9** |
| power-4 (canonical ceiling) | 53.2 | **57.8** |
| stair-0.5 | 24.8 | **24.7** |
| DL-matched oracle | 76.5 | **100.6** |
| v1 model | 3456 | **5287** |
| isotonic == chord floor | 16.8 | **20.4** (p90 50.2) |
| v1 worse than const | 40/40 | **39/40** |
| ceiling share of v1 error | 0.9–1.9 % | **1.1–1.4 %** |
| median top-voice lead / share of 2nd moment / positive-lead windows | 21.6 ms / 0.73 / 40 of 40 | **21.5 ms / 0.39 / 35 of 40** |

The verdict is unchanged and slightly stronger (v1 is now **91×** above its own ceiling). But `Y5`'s empirical support drops from 40/40 to 35/40, and §10.9's constant-offset share drops from 0.73 to **0.39 (p10 ≈ 0.00)** — openings have larger, steadier melody lead than the corpus. Y5 stays as the canonical rule; its rationale now says a real-data fitter must pick part 1 from the *sign of the fitted offset*, per piece.

**2 (I1) — the "canonical" pedal DL was measured on an M3-violating chain.** The adaptive family snapped to a 1/8-beat grid with `min_gap = 90` ticks (below M3's 180) and was priced in 1/8-beat units. Fixed: `M3_GRID_TICKS = 180`, `M3_MIN_SEGMENT_TICKS = 180`, priced in 1/4-beat units; every fit now carries `m3_conforming` and the run asserts **0 violating fits out of 420**. Combined with I11b (M6 is canonical, so `position` on every rendering instruction is the canonical cost, not the inheriting variant):

| | first release | **corrected (M3 + M6)** |
|---|---|---|
| canonical fixed 1/4-beat chain | — | **3350 tok @ 18.5 cc** (416 seg) |
| canonical adaptive chain | 959 tok @ 21.2 cc (1/8-beat, inheriting) | **1282 tok @ 24.7 cc** (159 seg) |
| + free curvature/protraction | 2223 | **5398 @ 12.0 cc** |
| headline range | 959–2223 tok, 10–25× | **1282–5398 tok, 15–63×** |

The §A2 "9.5 cc at ~128 ms segments" row was deleted rather than relabelled — those were 90-tick fits where the renderer's own `getTForDate` inversion contributes 1.4 cc. The M3-legal bandwidth law is now **11.1 / 18.5 / 24.7 / 29.3 / 30.2 / 30.6 cc** for `<180 / 180–360 / 360–720 / 0.7–1.4 s / 1.4–2.9 s / ≥2.9 s`, and the new sharp point is that **M3's floor is binding on the slow pieces**: 1/4 beat is 102 ms on Schubert but 451 ms on Chopin op10/3, so the `<180 ms` bucket is unreachable there at any legal grid (25.9 cc is that piece's canonical floor). Also: the C1 budget check now shows the M6 chain (~270 tok) **does not fit** the 448 target budget — a fact the inheriting number hid.

### The other ten

- **I2 bounded LS.** `_bounded_solve` = `scipy.optimize.lsq_linear(bounds=(0,1), lsq_solver="lsmr")`, replacing `lsqr` + `np.clip`. New proof **V5** (200 synthetic problems with active bounds: bounded better in 112/200, **never** worse) plus a real-data audit in §D: **84 of 418** positions on a bound at 1/4-beat density, clip is **+0.40 cc** worse there and +0.00 cc at 1 beat. "Oracle" now means oracle.
- **I3 plateau divergence.** `movement_segment(..., p1=None)` now reproduces meico exactly — `getDatePosition` returns `{startDate, position}` for every `t`, the subdivision never fires, and the trailing `[endDate, transitionTo]` is **not** appended, so a plateau emits **three coincident points at `startDate`**. Proof **V3** rewritten from one tuple to a **200-tuple Java sweep including 10 plateaus** (200/200, 1496 points, 0-diff), and new proof **V6** cross-checks `python/movement_math.py` (250 transitions + **250 plateaus**, 0-diff) — the report's "they must agree by construction" is now true by test. `render_chain_cc` also emits plateaus wherever M5 makes the CC endpoints equal.
- **I4 dominance count.** New `_dominates(rows, challengers, target)` reports canonical vs any-staircase separately. **Canonical staircases (≥4 beats) dominate `power-4` in 0/40**, not 28/40; the 26/40 winner is `stair-2`, which violates T1. The genuinely intra-canonical result is stronger: `stair-4` dominates `power-8` in **31/40** at 0.90× DL. D2 rewritten as a three-row table with the canonical/non-canonical column first.
- **I6 unbacked output blocks.** `vienna_ceiling.report_paired_checks()` (new, table F) and `pedal_fit.report()` §D now print the paired ratios and the burst audit. Both scripts gained `--from-json` so the write-ups regenerate without a refit.
- **I7 mislabelled aggregation.** `signal_stats` stores a 128-bin **dwell histogram in ms** per performance; the report prints *median over performances* and *pooled* side by side and says which is which (`0<cc<127`: **91.6 % vs 88.9 %**; quantiles `2/38/74/94/116` vs `0/28/74/102/127`). Both are now recoverable from the JSON.
- **I8 unauditable extrema.** Explicit definition: local extremum with topographic prominence ≥ `PEAK_PROMINENCE_CC = 16` cc (`scipy.signal.find_peaks`), the same 16 cc that C1 uses as the depth deadband. Per-cycle levels stored in the JSON. New numbers (pooled over 2798 / 2059 cycles): plateau p10 **53** / med **88** / p90 **124**; release **0 / 3 / 23**; cycles/s **1.52** (was an unreproducible 0.87). C1's sampler ranges updated to `plateau ~ U[53,124]`, `release ~ U[0,23]`.
- **I9 mixed DL units.** The DL-matched oracle's budget is now `mdl.dl_tempo_map(pred["tempo_map"])` — one counter for every row including the model's. Both are printed (`mdl` 64 vs `infer.py` decoded 66).
- **I10 tick↔ms asymmetry.** `ScoreTimeMap.to_ms()` added, edge-slope extrapolation, exact inverse of `to_ticks`; `render_chain_cc` uses it instead of clamping `np.interp`. Exposure printed: median **83 of 3498** observations past the last matched note.
- **I11 spec inconsistencies.** (a) M9 restated without self-contradiction: **~1 % at 4 beats, 35 % at the canonical 1/4-beat grid** — the payoff *grows* as the grid fines, which points the same way as M3. (b) The terminator carries **no `Z`**: its `position` never renders, and the compiler must still emit it into the XML (because `getMovementDataOf` *is* called on the last index and would re-enter the defective `getPreviousPosition`), so it is compiler-generated and free. M6 now exempts it explicitly, §12 step 15 matches, and `dl_movement_chain`'s default flipped to `inherit_position=False` = canonical. (c) "1.9×" replaced by the measured **1.36×** (date encoding alone) and **1.59×** (dates + positions).
- **I12 terminology.** `frac_explained_by_constant` → `share_of_second_moment` everywhere, with the label "share of the SECOND MOMENT" in the report and a printed caveat. D3's `sqrt(1−0.73) × 16.8` derivation is **deleted** and replaced by an explicit bracket-not-identity paragraph naming the error; the conclusion now rests only on the ordering (ImprecisionMap lives inside a **20.4 ms** budget, two orders of magnitude below the 5287 ms v1 error).

### API / implementation notes for downstream

- `MovementData.getMovementSegment` on a plateau returns **3 points, all at `startDate`** — the plateau is carried by the zero-order hold, not by an event at `endDate`. Anything that assumes a segment spans its own interval is wrong for the *majority* canonical instruction under M5/M6.
- `MovementMap.renderMovementToMap` calls `getMovementDataOf(last)` even though it never renders it. A terminator with an omitted `position` therefore still enters `getPreviousPosition` and can hit the NPE — the terminator's `position` must be written.
- `pedal_fit.py` and `python/movement_math.py` are now proven interchangeable on the scalar path (V6, plateaus included); the vectorised Bézier here stays for the LS design matrix.
- `vienna_ceiling.select`'s aliasing failure mode is generic: any stride over an id-sorted corpus with a fixed number of sub-items per group lands on one sub-index. `report_window_mix` is one line and makes it visible in the log.

## files_changed
[
 "/Users/nielspfeffer/Projects/mpmify/ml/CANONICAL.md",
 "/Users/nielspfeffer/Projects/mpmify/ml/analysis/pedal_fit.py",
 "/Users/nielspfeffer/Projects/mpmify/ml/analysis/vienna_ceiling.py",
 "/Users/nielspfeffer/Projects/mpmify/ml/analysis/findings_v4.md"
]

## validation_output
$ nice -n 15 python3 pedal_fit.py --n 20 --java-proof     # 2098 s
==============================================================================
Exactness proofs (project standard: 0-diff)
==============================================================================
V1 vectorised Bezier vs python/dynamics_math (audited scalar port) : 4000/4000 bit-identical, max |diff| = 0
V2 vectorised Bezier vs meico MovementData.getPositionAt        : 4000/4000 bit-identical, max |diff| = 0
V3 movement_segment vs MovementData.getMovementSegment(0.1)     : 200/200 cases bit-identical (10/10 plateaus, 1496 points), max |diff| = 0
V4 renderer resolution floor (curvature=0, exact answer is linear):
     segment    45 ticks -> max |curve - line| =  2.821 cc (= 127/L =  2.822)
     segment    90 ticks -> max |curve - line| =  1.411 cc (= 127/L =  1.411)
     segment   180 ticks -> max |curve - line| =  0.705 cc (= 127/L =  0.706)
     segment   254 ticks -> max |curve - line| =  0.500 cc (= 127/L =  0.500)
     segment   360 ticks -> max |curve - line| =  0.352 cc (= 127/L =  0.353)
     segment   720 ticks -> max |curve - line| =  0.176 cc (= 127/L =  0.176)
V5 bounded LS (lsq_linear) vs clip-after-lsqr, active bounds     : bounded better in 112/200, NEVER worse (0/200); gain p50 0.000 / p90 0.012 / max 0.073 cc
V6 movement_segment vs python/movement_math (scalar port)       : 250/250 transitions, 250/250 plateaus bit-identical, max |diff| = 0

20 Vienna performances: Chopin_op10_no3, Chopin_op38, Mozart_K331_1st-mov, Schubert_D783_no15
  selected: Chopin_op10_no3_p01, ..._p05, ..._p09, ..._p13, ..._p17, Chopin_op38_p01, ... (5 pianists x 4 pieces)
  (2098 s)

==============================================================================
A. Canonical movement chain vs real half-pedalling (medians over 20 performances)
==============================================================================
DL = canonical tokens under M6 (explicit `position`); every family below conforms to M3
(1/4-beat grid, segments >= 180 ticks).  binAgr = time-weighted CC-64 threshold agreement.
family        shape      n_seg  seg ms  minTk    RMSE  RMSE_tw  rendered      DL  tok/seg   tok/s  binAgr  M3
uniform-4     default       26    3743   2880   31.00    35.55     31.36     214      8.1     2.2    0.55 yes
uniform-4     linear        26    3743   2880   31.02    35.35     31.36     320     12.1     3.2    0.55 yes
uniform-4     free          26    3743   2880   30.69    34.96     31.16     413     15.8     4.1    0.55 yes
uniform-2     default       52    1889   1440   30.64    34.88     30.93     424      8.1     4.2    0.54 yes
uniform-2     free          52    1889   1440   30.01    34.15     30.33     834     15.5     8.1    0.59 yes
uniform-1     default      104     953    720   29.76    34.30     30.00     864      8.1     8.4    0.58 yes
uniform-1     free         104     953    720   27.35    31.19     28.00    1602     15.3    15.7    0.62 yes
uniform-0.5   default      208     478    360   25.68    29.16     25.32    1724      8.1    16.8    0.70 yes
uniform-0.5   free         208     478    360   20.89    22.61     21.15    2984     14.9    30.7    0.80 yes
uniform-0.25  default      416     239    180   18.50    18.84     18.45    3350      8.3    34.2    0.86 yes
uniform-0.25  linear       416     239    180   17.15    17.96     17.21    5002     12.3    50.6    0.89 yes
uniform-0.25  free         416     239    180   11.95    11.43     12.72    5398     13.9    57.2    0.94 yes
rdp-25        default       22    4720    180   31.16    36.23     31.55     194      8.6     1.8    0.58 yes
rdp-50        default       44    2335    180   30.38    34.46     30.78     371      8.4     3.5    0.60 yes
rdp-100       default       86    1246    180   28.05    32.57     28.66     710      8.3     6.6    0.64 yes
rdp-200       default      159     679    180   24.67    28.90     24.63    1282      8.1    11.9    0.70 yes
rdp-200       free         159     679    180   22.03    25.46     21.83    2302     15.4    22.3    0.78 yes
rdp-400       default      244     423    180   21.42    24.48     20.82    1892      8.1    19.3    0.79 yes
constant      -              1       -      -   32.23

==============================================================================
A1. What the signal is -- per-performance stats, aggregated two ways
==============================================================================
Two aggregations of the same per-performance quantities.  They differ by 2-3 points
because pooling weights each performance by its recording length; quote which one.
quantity                                       median over perfs    POOLED (dwell)
time share with 0 < cc < 127                               91.6%             88.9%
time share fully up (cc = 0)                                3.5%              5.3%
time share fully down (cc = 127)                            1.1%              5.9%
time-weighted quantile p05                                     2                 0
time-weighted quantile p25                                    38                28
time-weighted quantile p50                                    74                74
time-weighted quantile p75                                    94               102
time-weighted quantile p95                                   116               127
signal sd (cc)                                              32.2              35.7   (right col = time-weighted)
CC events per performance                                   3498

pedal cycle levels (local extrema, prominence >= 16 cc, scipy.signal.find_peaks)
quantity                                           p10    median       p90  per perf
plateau level (local maximum)  [median of per-perf]        66        88       108       145
plateau level (local maximum)  [pooled over all cycles]        53        88       124      2798
release level (local minimum)  [median of per-perf]         0         2        19       106
release level (local minimum)  [pooled over all cycles]         0         3        23      2059
pedal cycles per second                           1.21      1.52      1.81

==============================================================================
A2. Fidelity vs segment duration in MILLISECONDS (all M3-conforming families pooled)
==============================================================================
mean segment duration       n fits   RMSE (cc)  RMSE_tw (cc)
0 - 180 ms                       6        11.1          12.0
180 - 360 ms                    25        18.5          19.0
360 - 720 ms                    43        24.7          26.6
720 - 1440 ms                   47        29.3          34.1
1440 - 2880 ms                  40        30.2          34.5
2880 - 5760 ms                  31        30.6          35.3
>= 5760 ms                       8        30.6          34.3
  for scale: the signal's own sd is 32.2 cc (time-weighted 35.7)
  M3 caps the finest canonical segment at 180 ticks, so the reachable bucket depends
  on tempo: 1/4 beat is 102 ms on Schubert D783/15 and 451 ms on Chopin op10/3.

==============================================================================
B. Per-piece breakdown (uniform-1 beat, default shape / rdp-200)
==============================================================================
piece                   beat ms    std  u1 RMSE   u0.25   rdp200  rdp200 DL   tok/s
Chopin_op10_no3            1804   33.6    30.23   25.85    28.27       1153    10.4
Chopin_op38                 941   32.1    29.30   19.71    27.28       1824    10.9
Mozart_K331_1st-mov         968   29.7    26.97   18.87    24.88       1811    12.0
Schubert_D783_no15          410   39.5    30.90   11.52    13.74       1696    32.7

==============================================================================
C. Encoding cost of one movement chain (medians over performances)
==============================================================================
  uniform-0.25, shape = default  (416 segments, 0 non-default shapes)
    fractional-beat dates, 0..1 positions (2 dec)          5510 tokens (13.2/seg)
    fractional-beat dates, integer CC positions            4578 tokens (11.0/seg)
    1/4-beat delta dates, integer CC  <- CANONICAL (M6)    3350 tokens (8.0/seg)
    ... same, with position inheritance (post-fork-fix)    2094 tokens (5.0/seg)
    ratio beats_norm / delta_cc                            1.59x
    ratio beats_cc   / delta_cc                            1.36x
    ratio M6-explicit / inherited                          1.61x  (inheritance saves 38 %)
  uniform-0.25, shape = free  (416 segments, 294 non-default shapes)
    1/4-beat delta dates, integer CC  <- CANONICAL (M6)    5398 tokens (13.0/seg)
    ... same, with position inheritance (post-fork-fix)    4124 tokens (9.9/seg)
  rdp-200, shape = default  (159 segments, 0 non-default shapes)
    fractional-beat dates, 0..1 positions (2 dec)          2180 tokens (13.7/seg)
    fractional-beat dates, integer CC positions            1726 tokens (10.9/seg)
    1/4-beat delta dates, integer CC  <- CANONICAL (M6)    1282 tokens (8.1/seg)
    ... same, with position inheritance (post-fork-fix)     808 tokens (5.1/seg)
    ratio beats_norm / delta_cc                            1.75x
    ratio beats_cc   / delta_cc                            1.34x
    ratio M6-explicit / inherited                          1.59x  (inheritance saves 37 %)
  rdp-200, shape = free  (159 segments, 144 non-default shapes)
    1/4-beat delta dates, integer CC  <- CANONICAL (M6)    2302 tokens (14.5/seg)

==============================================================================
D. Audits
==============================================================================
  burst-collapse: n_dropped_duplicates == n_burst - 1 in 20/20 performances
    opening burst sizes : [1, 1, 2, 3, 26, 32, 38, 39, 41, 49, 49, 50, 53, 53, 69, 77, 88, 101, 127, 286]
    collapsed opening state (cc): [5, 11, 11, 18, 50, 59, 68, 70, 79, 81, 89, 114, 117, 118, 122, 123, 124, 125, 125, 126]
    -> median 85, > 0 in 20/20
  M3 conformance (1/4-beat grid, segments >= 180 ticks): 0 violating fits out of 420
  movementSampleMaxStep 0.1 (fork default) vs 0.02, medians:
    family/shape            rmse@0.1  rmse@0.02  events@0.1  events@0.02
    uniform-1|default          30.00      29.73         254         1108
    uniform-0.25|default       18.45      18.43        2216        10114
    uniform-0.25|free          12.72      11.92        2256        10090
    rdp-200|default            24.63      24.62         678         3234
  bounded LS vs the clip-after-lsqr shortcut (real traces):
    uniform-1     positions at a bound    2 /  106   RMSE bounded  29.76  clipped  29.82  (clip is +0.00 cc worse)
    uniform-0.25  positions at a bound   84 /  418   RMSE bounded  18.50  clipped  19.06  (clip is +0.40 cc worse)
  tick<->ms extrapolation exposure (events past the last matched note): median 83 of 3498 observations (forward and inverse tick<->ms both extrapolate; see ScoreTimeMap)

wrote /Users/nielspfeffer/Projects/mpmify/ml/analysis/out/pedal_fit.json


$ nice -n 15 python3 vienna_ceiling.py --n 40            # 1613 s
====================================================================================
Exactness proofs (project standard: <= 1e-9 ms)
====================================================================================
V1 staircase design matrix vs meico constant-tempo rendering : max |diff| = 0.000000000007 ms (200 staircases x 40 notes)
V2 degenerate power chain vs closed-form constant tempo       : max |diff| = 0.000000000004 ms (200 chains x 30 notes)
V3 isotonic <= chord-mean <= 1-beat staircase on 20 windows   : 0 violations
V4 fast (libm) power renderer vs exact (fdlibm) tempo_math    : max |diff| = 0.000000000007 ms (120 chains x 60 notes)

40 Vienna windows over 4 pieces, 19 pianists
  window-index mix: w0=18, w1=16, w2=6   distinct pianists: 19

====================================================================================
A. Representation ceiling -- render RMSE (ms), medians over 40 windows
====================================================================================
DL is `mdl.dl_tempo_map` for EVERY row, the v1 model included.  'T1' marks the rows
inside the canonical hypothesis class (segments >= 4 beats); stair-2/1/0.5 and greedy
are deliberately NON-canonical competitors.
explanation           T1  RMSE med  RMSE p90   DL med  instr  vs const
const                yes     383.9    1854.7        8      1      1.00
stair-8              yes     165.3     438.2       52      6      0.43
power-8              yes      98.2     335.2      115      7      0.26
stair-4              yes      82.5     305.7      103     12      0.21
power-4              yes      57.8     185.3      216     13      0.15
stair-2                -      51.6     161.7      206     24      0.13
stair-1                -      41.3     126.3      410     46      0.11
stair-0.5              -      24.7      73.9      556     62      0.06
greedy-best            -      25.3      72.8      472     48      0.07
dl-matched-oracle      -     100.6     348.5       59      -      0.26
v1-model               -    5287.0   13523.5       64      4     13.77
isotonic               -      20.4      50.2        -      -      0.05
chord-floor            -      20.4      50.2        -      -      0.05

====================================================================================
B. Per piece (median over its windows)
====================================================================================
piece                  beat ms  notes        const      stair-4      power-4      stair-1    stair-0.5  greedy-best     isotonic  chord-floor     v1-model
Chopin_op10_no3           1914    314        700.5        223.9        120.1         74.7         46.9         29.1         23.3         23.3       8571.5
Chopin_op38                926    248        338.5         72.8         60.2         42.6         22.6         26.4         22.4         22.4       5445.4
Mozart_K331_1st-mov        977    210        383.9         81.3         54.9         40.3         18.0         25.0         17.1         17.1       4453.7
Schubert_D783_no15         390    162        274.7         68.1         42.5         23.2         22.0         22.1         22.0         22.0       3400.9

====================================================================================
C. Decomposition of the v1 sim2real error (medians)
====================================================================================
  Chopin_op10_no3        v1     8571 | canonical ceiling (power-4)   120.1 | DL-matched oracle   304.4 | sub-beat greedy   29.1 | any-tempo floor   23.3
                         -> ceiling explains   1.4 % of the v1 error; model failure  98.6 %
  Chopin_op38            v1     5445 | canonical ceiling (power-4)    60.2 | DL-matched oracle    83.1 | sub-beat greedy   26.4 | any-tempo floor   22.4
                         -> ceiling explains   1.1 % of the v1 error; model failure  98.9 %
  Mozart_K331_1st-mov    v1     4454 | canonical ceiling (power-4)    54.9 | DL-matched oracle   114.4 | sub-beat greedy   25.0 | any-tempo floor   17.1
                         -> ceiling explains   1.2 % of the v1 error; model failure  98.8 %
  Schubert_D783_no15     v1     3401 | canonical ceiling (power-4)    42.5 | DL-matched oracle    59.0 | sub-beat greedy   22.1 | any-tempo floor   22.0
                         -> ceiling explains   1.2 % of the v1 error; model failure  98.8 %

====================================================================================
D. Canonical granularity real playing demands (median RMSE by segment length)
====================================================================================
  stair-8    segment  8.0 beats =   7676 ms   RMSE   165.3 ms   DL    52 tokens
  stair-4    segment  4.0 beats =   3838 ms   RMSE    82.5 ms   DL   103 tokens
  stair-2    segment  2.0 beats =   1919 ms   RMSE    51.6 ms   DL   206 tokens
  stair-1    segment  1.0 beats =    959 ms   RMSE    41.3 ms   DL   410 tokens
  stair-0.5  segment  0.5 beats =    480 ms   RMSE    24.7 ms   DL   556 tokens

====================================================================================
E. Chord asynchrony ('top voice' vs 'the rest'), 40 windows
====================================================================================
quantity                                        median       p10       p90
per-window median lead (ms)                     21.484     8.854    33.333
per-window mean lead (ms)                       19.318    -1.729    30.497
per-window sd of the lead (ms)                  18.079    11.040    52.001
share of the SECOND MOMENT a constant explains     0.388     0.002     0.854
chords per window                                   64
windows with a POSITIVE mean lead                35/40
  note: mu^2/(mu^2+var) is a share of E[lead^2], not of Var[lead]; and it is not
  robust across windows (p10 above), so quote it with its spread.

====================================================================================
F. Paired checks (medians of per-window ratios; n = 40 windows)
====================================================================================
  stair-4      / power-8      rmse ratio   0.88   dl ratio   0.90
  stair-2      / power-4      rmse ratio   0.91   dl ratio   0.96
  power-4      / stair-4      rmse ratio   0.66   dl ratio   2.11
  power-8      / stair-8      rmse ratio   0.71   dl ratio   2.21

  power-4            / v1-model = 0.0115
  dl-matched-oracle  / v1-model = 0.0244
  isotonic           / v1-model = 0.0037
  const              / v1-model = 0.0894
  greedy-best        / v1-model = 0.0044

  windows where v1 is WORSE than the constant baseline: 39/40
  dominates power-4  [CANONICAL staircases only (>=4 beats)    ]: 0/40
  dominates power-8  [CANONICAL staircases only (>=4 beats)    ]: 31/40   (stair-4:31)
  dominates power-4  [ANY staircase incl. non-canonical 2/1/0.5]: 26/40   (stair-2:26)
  dominates power-8  [ANY staircase incl. non-canonical 2/1/0.5]: 31/40   (stair-4:31)
  windows where a power chain dominates stair-2: 1/40
  windows where a power chain dominates stair-4: 0/40

  isotonic == chord-floor: 40/40 windows
  stair-0.5  / floor = 1.03
  stair-1    / floor = 1.91
  power-4    / floor = 2.73

  v1 DL: mdl.dl_tempo_map median 64 tokens vs infer.py decoded-length median 66   (the budget above uses the former, for unit consistency)

wrote /Users/nielspfeffer/Projects/mpmify/ml/analysis/out/vienna_ceiling.json


$ python3 pedal_fit.py --from-json && python3 vienna_ceiling.py --from-json
(both re-print the full report from the committed JSON; every table above reproduces byte-for-byte)

$ python3 -c "import ast; [ast.parse(open(f).read(),f) for f in ('pedal_fit.py','vienna_ceiling.py')]"
AST OK

$ full-main-path smoke test of the refactored vienna_ceiling (OUT redirected to scratchpad, --n 4 --quick)
EXIT 0 ; out/vienna_ceiling.json untouched: main json still has 40 windows

## open_issues
[
 "GATE respected: no accentuation supervision data generated (none of this code touches accentuation), no dataset generation, no training. All compute at nice -n 15 alongside the v3.1 run; pedal_fit 2098 s, vienna_ceiling 1613 s.",
 "Two NEW meico fork defects remain found-but-unfixed (../bugs.md and ../meico are outside my file allowlist): MovementMap.getPreviousPosition's `j > 0` off-by-one (instruction #1 can never inherit `position`) and its unguarded getAttribute(\"transition.to\").getValue() -> NPE at MovementMap.java:203. Fixing both relaxes M6 and refunds 37-38 % of the movement DL (3350 -> 2094 tokens on the canonical chain) -- which is now load-bearing, because the M6 chain does NOT fit the 448 training target budget while the inheriting chain does. meico-ts mirrors this bug-for-bug by design, so it needs the same coordination as the 2026-08-08 round.",
 "Msm.parsePositionMap still maps any unknown `controller` string to controllerNumber = 0 (CC 0 Bank Select MSB). Handled normatively by M7; a renderer-side guard would be safer.",
 "CANONICAL.md \u00a70's last sentence (\"the queued test ... has not been run\") is now stale. I was told to append only, so \u00a70 is untouched; the v4 header and \u00a714 carry the pointer. Someone with \u00a70 in scope should update it.",
 "Y5's empirical support weakened by the sampling fix: the top-voice lead is positive in 35/40 windows, not 40/40, and \u00a710.9's constant-offset share of the second moment fell 0.73 -> 0.39 with p10 ~= 0.00. Y5 stays as the canonical rule but a real-data asynchrony fitter must choose part 1 from the sign of the fitted offset per piece. Worth a look from whoever builds the v4 asynchrony fitter.",
 "The v4 DSL token assignment (G, Z, Y, J -> vocab 35) is still proposed, not implemented: python/dsl.py stops at the v3 vocab of 31. Needs the B1 vocab-freeze discipline (per-version sizes, resume-mismatch abort) when it lands. \u00a711's grammar now says the terminator is `G <date> C` with a compiler-generated `position` -- the compiler must emit that attribute or the chain hits the getPreviousPosition NPE.",
 "vienna_ceiling.POWER_GRIDS is still (8, 4); a 2-beat power chain costs ~33 s/window and only interpolates between stair-2 and stair-1, so it is off by default. Add 2 to price it.",
 "pedal_fit's own select() (performances, not windows) still uses a stride: it lands on pianists p01/p05/p09/p13/p17 per piece. There is no window-index axis in vienna_infer.jsonl so there is no aliasing trap, but it is 5 of 22 pianists per piece and the run now prints the selected ids so the coverage is visible.",
 "The M3-conforming adaptive (Douglas-Peucker) family is now WORSE than the uniform 1/4-beat grid at comparable segment counts (rdp-400: 244 seg / 21.4 cc vs uniform-0.25: 416 seg / 18.5 cc), because the 180-tick minimum stops it concentrating knots. If v5 relaxes the movement grid, revisit -- the pre-M3 adaptive fits were much stronger, which is exactly why they were not canonical."
]

