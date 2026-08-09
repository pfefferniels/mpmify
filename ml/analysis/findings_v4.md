# v4 findings: the pedal band, and the representation ceiling on real performances

Team F. Reproduce **everything below** — including the paired checks of §B4, the
burst-collapse audit of §A1 and the signal quantiles — with

```sh
cd ml/analysis && nice -n 15 python3 pedal_fit.py --n 20 --java-proof     # ~12 min, 20 performances
cd ml/analysis && nice -n 15 python3 vienna_ceiling.py --n 40             # ~15 min, 40 windows
cd ml/analysis && nice -n 15 python3 pedal_fit.py validate --java-proof   # proofs only
cd ml/analysis && nice -n 15 python3 vienna_ceiling.py asynchrony         # §D only, seconds
```

No number in this document is computed anywhere but in those two scripts. (An earlier
release quoted two blocks — the paired ratios and the burst audit — that had been
derived by hand from the JSON; both are now printed by `report_paired_checks` and
`pedal_fit.main` §D respectively.)

Raw numbers land in `analysis/out/pedal_fit.json` and `analysis/out/vienna_ceiling.json`
(gitignored). The spec these measurements justify is the **v4 addendum** of
`../CANONICAL.md` (§§8–14).

**Two sampling facts that qualify every number here.**

1. *The 40 ceiling windows are stratified over pieces, pianists **and window index**.*
   The corpus's 220 windows are 88 `_w0` + 88 `_w1` + 44 `_w2`, laid out so that each
   performance's 2–3 windows are consecutive in id order. A stride selection therefore
   aliases onto a single window index; the first release of this document selected 40
   windows that were **all `_w0`**, i.e. it measured piece openings and reported them as
   a corpus sample. `vienna_ceiling.select()` now permutes pianists deterministically
   and rotates the window index, and the run prints the realised mix. Openings are
   *easier* than the corpus average, so several figures below are worse than the first
   release's — that is the correction, not a regression.
2. *The 20 pedal performances are a spread over pianists within each piece
   (`p01, p05, p09, p13, p17`), one window-free full performance each.* There is no
   window-index axis in `vienna_infer.jsonl`, so no analogous trap.

**What is new here, relative to `findings.md`.** Every number in `findings.md` was
measured on pieces the canonical sampler itself generated — a self-consistency result,
as §0 of `CANONICAL.md` says. Every number here is measured on **real human
performances** (Vienna 4x22: Bösendorfer SE recordings, score-aligned, with the
continuous pedal sensor). Two open questions are answered:

- **the movementMap is by far the most expensive map in MPM.** A real sustain trace costs
  15–63× the description length of the entire tempo+dynamics map, and its fidelity is
  governed by segment duration in *milliseconds*, not in beats (§A).
- **the tempo representation ceiling is NOT what broke v1 sim2real** (§B).

Aggregation convention as in `findings.md`: every ratio is a median of per-window ratios,
never a ratio of medians.

---

## 0. Exactness proofs (project standard of proof)

`pedal_fit.py` — the forward model is meico's own, proven against three independent
references, and the fitter itself is proven to solve the problem it claims to solve:

```
V1 vectorised Bezier vs python/dynamics_math (audited scalar port) : 4000/4000 bit-identical, max |diff| = 0
V2 vectorised Bezier vs meico MovementData.getPositionAt           : 4000/4000 bit-identical, max |diff| = 0
V3 movement_segment vs MovementData.getMovementSegment(0.1)        : 200/200 cases bit-identical (10/10 plateaus, 1496 points), max |diff| = 0
V4 renderer resolution floor (curvature=0, exact answer is linear):
     segment    45 ticks -> max |curve - line| =  2.821 cc   (= 127/L =  2.822)
     segment    90 ticks -> max |curve - line| =  1.411 cc   (= 127/L =  1.411)
     segment   180 ticks -> max |curve - line| =  0.705 cc   (= 127/L =  0.706)
     segment   254 ticks -> max |curve - line| =  0.500 cc   (= 127/L =  0.500)
     segment   720 ticks -> max |curve - line| =  0.176 cc   (= 127/L =  0.176)
V5 bounded LS (lsq_linear) vs clip-after-lsqr, active bounds       : bounded better in 112/200, NEVER worse (0/200); gain p50 0.000 / p90 0.012 / max 0.073 cc
V6 movement_segment vs python/movement_math (scalar port)          : 250/250 transitions, 250/250 plateaus bit-identical, max |diff| = 0
```

V2 compiles a probe against the fork at `1d662105` and compares 4000 random
`(startDate, endDate, position, transitionTo, curvature, protraction, date)` cases:
**exactly 0**, not 1 ULP — the movement Bézier path contains no `pow`/`log`, so the
fdlibm divergence that limits `CANONICAL.md` §7.7 does not arise here.

V3 **sweeps 200 parameter tuples, 10 of them plateaus** (`transition.to` absent). That
matters: `getMovementSegment` appends the trailing `[endDate, transitionTo]` point only
`if (this.transitionTo != null)`, so a plateau emits **three coincident points at
`startDate`**, not four points spanning the segment. An earlier release of this file
exercised a single transition tuple and appended the trailing point unconditionally — a
divergence invisible in every reported number (the fitter always passed an explicit
endpoint) but fatal on reuse, because M5/M6 make plateaus the dominant canonical
instruction. V6 confirms the fix against the concurrently-landed scalar port
`python/movement_math.py`, plateaus included; the two ports are now genuinely
interchangeable, which they previously were not.

V4 is not a port check but a **property of the renderer**: `MovementData.getTForDate`
stops as soon as the Bézier's x-error falls below `1.0` **tick**, so on a segment of `L`
ticks the returned position carries up to `127/L` CC units of systematic error. With
`curvature = protraction = 0` the true curve is the straight line, which makes the error
directly measurable. This is what fixes the canonical minimum segment length (M3): below
~180 ticks the renderer's own inversion error exceeds the CC quantiser and the shape
parameters stop meaning anything.

V5 is about the *fitter*, not the renderer. The position vector is confined to `[0, 1]`
and the constraint is genuinely active on real traces (a median **84 of 418** fitted
positions sit exactly on a bound at 1/4-beat density, because a real pedal spends real
time fully up or fully down). An unconstrained `lsqr` followed by `np.clip` is therefore
not the optimum of the constrained problem, and on the corpus it is **0.40 cc worse** at
the 1/4-beat grid (0.00 cc at 1 beat, where the bound is barely active). Every number in
§A now comes from `scipy.optimize.lsq_linear`, so "oracle" means oracle.

`vienna_ceiling.py`:

```
V1 staircase design matrix vs meico constant-tempo rendering : max |diff| = 0.000000000007 ms (200 staircases x 40 notes)
V2 degenerate power chain vs closed-form constant tempo       : max |diff| = 0.000000000004 ms (200 chains x 30 notes)
V3 isotonic <= chord-mean <= 1-beat staircase on 20 windows   : 0 violations
V4 fast (libm) power renderer vs exact (fdlibm) tempo_math    : max |diff| = 0.000000000007 ms (120 chains x 60 notes)
```

V4 licenses the one performance shortcut in this work. `tempo_math` routes every
`pow`/`log` through the fdlibm port (≈15 µs per call, **75×** libm), and a power-chain
fit needs ~10⁶ of them per window. The optimiser therefore runs on a vectorised libm copy
of the *same formulas*, while every reported RMSE is recomputed with the exact renderer.
The two agree to 7e-12 ms — eight orders of magnitude below the errors measured here.

---

## A. The pedal band: what a movement chain can and cannot say

20 performances (5 pianists × 4 pieces), `sustain_cc` streams from
`data/vienna_infer.jsonl`, fitted with a canonical movement chain (`CANONICAL.md` §9).
Error unit: **CC units** (the observable is `round(127 · position)`).

### A1. What the signal is

Two aggregations are reported side by side and they are **not** interchangeable: the
left column is the median over the 20 performances, the right pools the dwell
histograms, which weights each performance by its recording length. An earlier release
printed the pooled figures under a "median over the 20 performances" header.

| quantity | median over perfs | pooled (dwell-weighted) |
|---|---|---|
| CC events per performance | 3498 (≈96 Hz continuous sensor) | – |
| signal sd | **32.2 cc** | 35.7 cc (time-weighted) |
| time share with `0 < cc < 127` | **91.6 %** | 88.9 % |
| time share fully up (`cc = 0`) | 3.5 % | 5.3 % |
| time share fully down (`cc = 127`) | 1.1 % | 5.9 % |
| time-weighted quantiles p05/p25/p50/p75/p95 | 2 / 38 / **74** / 94 / 116 | 0 / 28 / **74** / 102 / 127 |

Pedal-cycle levels, from an **explicit** extremum definition — a local extremum of the
collapsed trace with topographic prominence ≥ **16 cc** (`scipy.signal.find_peaks`,
`PEAK_PROMINENCE_CC`; 16 cc is the depth deadband §C1 recommends, so a shallower
excursion is by construction not a cycle):

| quantity | p10 | median | p90 | count |
|---|---|---|---|---|
| plateau level (local maximum), median of per-perf | 66 | **88** | 108 | 145 / perf |
| plateau level, pooled over all cycles | 53 | **88** | 124 | 2798 |
| release level (local minimum), median of per-perf | 0 | **2** | 19 | 106 / perf |
| release level, pooled over all cycles | 0 | **3** | 23 | 2059 |
| pedal cycles per second | 1.21 | **1.52** | 1.81 | – |
| opening burst (events at the first timestamp) | – | 49 | – | range 1 … 286 |
| pedal state after collapsing the burst | – | **CC 85** | – | > 0 in 20/20, range 5 … 126 |

(The previous release quoted plateau med 89 / p90 124 and release med 8 / p90 66 from an
extremum rule that existed in no committed script. The definition above is in
`pedal_fit.signal_stats`, its per-cycle levels are stored in `out/pedal_fit.json`, and
the sampler ranges of §C1 are taken from the **pooled** rows.)

This is *legato pedalling*: long plateaus at a partly-depressed level, interrupted 1–2
times a second by a fast lift-and-catch. It is neither tremor nor on/off — ~89–92 % of
the elapsed time is spent strictly between the extremes, and the median plateau is
CC 88, not 127. The release is nearly complete (median CC 2–3) but not instantaneous.

**The opening burst is exactly the duplicate-timestamp problem.** On all 20 performances
`n_dropped_duplicates == n_burst − 1` **exactly**: every duplicate timestamp in the
corpus's sustain streams lies inside the burst at the first timestamp. Last-wins
collapsing (M8) therefore removes the burst and nothing else — one rewrite, not two.
Printed by `pedal_fit.py` §D, with the full per-performance lists.

### A2. Fidelity is a function of segment duration in **milliseconds**

Median RMSE of the fitted chain, bucketed by mean segment duration (all **M3-conforming**
families pooled, default shape):

| mean segment duration | < 180 ms | 180–360 | 360–720 | 720–1440 | 1.4–2.9 s | 2.9–5.8 s | ≥ 5.8 s |
|---|---|---|---|---|---|---|---|
| n fits | 6 | 25 | 43 | 47 | 40 | 31 | 8 |
| RMSE (cc) | **11.1** | 18.5 | 24.7 | 29.3 | 30.2 | 30.6 | 30.6 |
| time-weighted RMSE (cc) | 12.0 | 19.0 | 26.6 | 34.1 | 34.5 | 35.3 | 34.3 |

Against a signal sd of 32.2 cc, **everything at or above ~1 s of segment duration is no
explanation at all**. RMSE roughly halves for each halving of the segment duration below
~1 s. This is a *bandwidth* statement: the foot's signal has a fixed cutoff in real time,
so a beat-aligned canonical grid has **tempo-dependent** pedal fidelity.

The per-piece table makes that explicit — the same canonical 1/4-beat grid is worth
11.5 cc on Schubert (beat = 410 ms) and 25.9 cc on Chopin op10/3 (beat = 1804 ms):

| piece | beat (ms) | signal sd | RMSE @1 beat | RMSE @1/4 beat | RMSE adaptive-200 |
|---|---|---|---|---|---|
| Chopin op10/3 | 1804 | 33.6 | 30.2 | 25.9 | 28.3 |
| Chopin op38 | 941 | 32.1 | 29.3 | 19.7 | 27.3 |
| Mozart K331/i | 968 | 29.7 | 27.0 | 18.9 | 24.9 |
| Schubert D783/15 | 410 | 39.5 | 30.9 | **11.5** | 13.7 |

**M3 is the binding constraint on the slow pieces.** The `< 180 ms` bucket is reachable
only where 1/4 beat is itself under 180 ms — i.e. on Schubert (1/4 beat = 102 ms). On
Chopin op10/3, 1/4 beat is 451 ms, so the *best legal canonical chain* sits in the
360–720 ms bucket and 25.9 cc is its floor. No rule in `CANONICAL.md` can move that: the
renderer's own `getTForDate` inversion error (proof V4) is what forbids shorter segments.

(The first release of this table reported 9.5 cc at ~128 ms segments. Those fits used a
**1/8-beat** adaptive candidate grid with a 90-tick minimum segment — half of M3's
minimum, where the renderer contributes 1.4 cc of systematic error of its own. They were
not canonical chains and the row has been removed rather than relabelled.)

### A3. Grids, shapes, and what the extra parameters buy

Medians over the 20 performances. **Every family here conforms to M3** (1/4-beat grid,
segments ≥ 180 ticks) — the run asserts it and prints `M3 = yes` per row. `RMSE` is the
continuous chain; `rendered` is what meico actually emits (`getMovementSegment(0.1)` +
`round` + zero-order hold, exact port); `DL` is canonical-DSL tokens under **M6**
(1/4-beat delta dates, integer CC positions, `position` on every rendering instruction);
`binAgr` is the time share on which the rendered CC-64 threshold state matches the
performance's.

| family | shape | n_seg | seg ms | RMSE | rendered | DL | tok/seg | tok/s | binAgr |
|---|---|---|---|---|---|---|---|---|---|
| constant (mean position, no ramp) | – | 1 | – | 32.2 | – | – | – | – | – |
| uniform 4 beats | default | 26 | 3743 | 31.0 | 31.4 | 214 | 8.1 | 2.2 | 0.55 |
| uniform 4 beats | free | 26 | 3743 | 30.7 | 31.2 | 413 | 15.8 | 4.1 | 0.55 |
| uniform 2 beats | default | 52 | 1889 | 30.6 | 30.9 | 424 | 8.1 | 4.2 | 0.54 |
| uniform 1 beat | default | 104 | 953 | 29.8 | 30.0 | 864 | 8.1 | 8.4 | 0.58 |
| uniform 1 beat | free | 104 | 953 | 27.4 | 28.0 | 1602 | 15.3 | 15.7 | 0.62 |
| uniform 1/2 beat | default | 208 | 478 | 25.7 | 25.3 | 1724 | 8.1 | 16.8 | 0.70 |
| uniform 1/2 beat | free | 208 | 478 | 20.9 | 21.2 | 2984 | 14.9 | 30.7 | 0.80 |
| **uniform 1/4 beat** | default | 416 | 239 | **18.5** | 18.5 | 3350 | 8.3 | 34.2 | 0.86 |
| **uniform 1/4 beat** | **free** | 416 | 239 | **12.0** | 12.7 | 5398 | 13.9 | 57.2 | **0.94** |
| adaptive 50 | default | 44 | 2335 | 30.4 | 30.8 | 371 | 8.4 | 3.5 | 0.60 |
| adaptive 200 | default | 159 | 679 | 24.7 | 24.6 | 1282 | 8.1 | 11.9 | 0.70 |
| adaptive 200 | free | 159 | 679 | 22.0 | 21.8 | 2302 | 15.4 | 22.3 | 0.78 |
| adaptive 400 | default | 244 | 423 | 21.4 | 20.8 | 1892 | 8.1 | 19.3 | 0.79 |

("adaptive" = Douglas–Peucker knots snapped to the **1/4-beat** M3 candidate grid with a
180-tick minimum segment, then a global **bounded** least-squares refit of all positions;
"free" = per-segment `curvature` / `protraction` chosen by grid search, alternating with
the position solve. The full log also carries a "linear" row per grid —
`curvature = protraction = 0`, i.e. straight ramps: it is worth 0.0–1.4 cc over the meico
default and costs +4 tokens on *every* segment, because 0.0/0.0 is not the default and so
must be written out. That is the measurement behind M9's choice to keep meico's 0.4/0.0
as the omission value rather than redefining the canonical default to a linear ramp.)

Five readings:

1. **Adaptive boundaries help at coarse budgets and lose at fine ones, once M3 binds.**
   Adaptive-200 reaches 24.7 cc with 159 segments where the uniform 1/2-beat grid needs
   208 for 25.7; but adaptive-400 (244 segments, 21.4 cc) cannot catch the uniform
   1/4-beat grid (416 segments, 18.5 cc), because the 180-tick minimum stops
   Douglas–Peucker from concentrating knots where the pedal actually moves. The signal is
   not sparse in breakpoints. (Before M3 was enforced, the adaptive family looked much
   stronger — that was the 90-tick fits of §A2's note.)
2. **Free `curvature`/`protraction` buy a lot at fine grids and nothing at coarse ones**
   (1/4 beat: 18.5 → 12.0 cc, **−35 %**; 4 beats: 31.0 → 30.7 cc, −1 %). 294 of 416
   segments take a non-default shape, and the mechanism is visible: `protraction` moves
   the steep part of the S-curve *inside* its segment. It is a **sub-grid
   boundary-placement parameter**, which is why M3 fixes the grid instead of letting a
   fitter choose boundaries freely (`CANONICAL.md` §13.2). Note this reading points the
   *same* way as M3: the finer the canonical grid, the more the shape parameters earn.
3. **meico's own sampling costs almost nothing.** Going from the fork default
   `movementSampleMaxStep = 0.1` to 0.02 is worth **+0.02 … +0.80 cc** (1/4-beat default
   18.45 → 18.43; 1/4-beat free 12.72 → 11.92) for **4.5×** the CC events (2216 → 10114)
   and 4.5× the quadratic sampling time. Keep the fork default (M10). The rendered column
   is occasionally *better* than the continuous chain because rendering also rounds to
   integer CC, which is the observable.
4. **A rendered movementMap is genuinely sparser than the human trace** — 2216 CC events
   for a 416-segment 1/4-beat chain, 678 for the 159-segment adaptive one, vs 3498
   observed. It does compress; just not enough (§C1).
5. **Threshold agreement degrades much more gracefully than RMSE.** A 4-beat chain is at
   chance-ish 0.55 but the canonical 1/4-beat chain reaches 0.86 (0.94 with free shapes)
   while its RMSE still looks poor. That gap is the argument for evaluating v4 pedal
   predictions on CC-64 threshold agreement alongside RMSE (§C1).

### A4. Two fork defects that make position inheritance unusable

MPM lets `position` be omitted and inherited from the previous `transition.to`. That
would be worth **37–38 %** of the movement DL (3350 → 2094 tokens on the canonical
416-segment 1/4-beat chain; 1282 → 808 on the 159-segment adaptive one). Both
of the following are **reproduced** against the fork at `1d662105`:

- `MovementMap.getPreviousPosition` loops `for (int j = index - 1; j > 0; --j)`, so
  **instruction #1 can never inherit**. The chain `[date 0: .1 → .9] [date 720: omit →
  .2] [date 1440: terminator]` renders `… 114.3, 114.3, 0.0, 0.0 …` at the boundary — a
  full pedal drop where the map says "continue from 0.9". Omission at index ≥ 2 inherits
  correctly (verified in the same probe).
- The same method dereferences `getAttribute("transition.to").getValue()` unguarded, so
  an omitted `position` following a **plateau** (an instruction with no `transition.to`)
  throws `NullPointerException` at `MovementMap.java:203`.

Both are one-line fixes (`j >= 0`; a null check). Until they land, `CANONICAL.md` M6
requires `position` on every instruction. This is the **third** movement-parsing defect
class in that file after the 2026-08-08 round; it is worth a dedicated pass rather than
another point fix. (Also worth fixing while in there: `Msm.parsePositionMap` silently
maps any unknown `controller` string to `controllerNumber = 0`, i.e. **CC 0, Bank Select
MSB** — hence rule M7.)

### A5. What each encoding choice costs

Medians over the 20 performances, for the two canonical chains of §A3. Tokens counted by
`pedal_fit.dl_movement_chain`, which implements the §11 grammar of `CANONICAL.md`; ratios
are medians of per-performance ratios.

| chain | encoding | tokens | per segment | vs canonical |
|---|---|---|---|---|
| fixed 1/4-beat grid, 416 seg | fractional-beat dates, 0..1 positions (2 dec) | 5510 | 13.2 | 1.59× † |
| | fractional-beat dates, integer CC positions | 4578 | 11.0 | 1.36× † |
| | **1/4-beat delta dates, integer CC (canonical, M6)** | **3350** | **8.0** | 1.00× |
| | … + per-segment `curvature`/`protraction` (M9) | 5398 | 13.0 | 1.61× ‡ |
| | … with `position` inheritance (post-fork-fix) | 2094 | 5.0 | 0.62× † |
| adaptive, 159 seg | fractional-beat dates, 0..1 positions (2 dec) | 2180 | 13.7 | 1.75× † |
| | fractional-beat dates, integer CC positions | 1726 | 10.9 | 1.34× † |
| | **1/4-beat delta dates, integer CC (canonical, M6)** | **1282** | **8.1** | 1.00× |
| | … + per-segment `curvature`/`protraction` (M9) | 2302 | 14.5 | 1.80× ‡ |
| | … with `position` inheritance (post-fork-fix) | 808 | 5.1 | 0.63× † |

† median of per-performance ratios (the document's convention), printed by the run.
‡ quotient of the two medians — the free-shape and default fits are different chains, so
the script does not pair them per performance.

Three decisions come straight off this table: M4 (integer CC positions, worth 1.34–1.36×),
the delta-date encoding of §11 (the two together are worth 1.59–1.75×), and M6's cost —
writing `position` on every instruction is **37–38 %** of the chain, which is what the
two one-line fork fixes of §A4 would refund.

Note the terminator carries no `Z`: its `position` never renders and the compiler emits it
deterministically, so it is free. The counter and the §11 grammar agree on this; an
earlier release had the grammar say one thing (`G <date> C`) and M6 another (`position` on
*every* instruction), a ~4-token discrepancy per chain.

---

## B. The representation ceiling on real performances — the v1 sim2real post-mortem

40 windows from `data/vienna_infer_windows.jsonl` — the same corpus v1 was evaluated on
in `LOG.md`, **stratified over pieces, pianists and window index** (realised mix: 19
pianists, w0=18 / w1=16 / w2=6). "Oracle" = the best member of a hypothesis class, fitted
with full knowledge of the target; no model can beat its own class's oracle. `power-G` is
the **canonical family** (a continuous chain of meico power-function transitions on a
G-beat grid, one tempo per boundary + one `meanTempoAt` per segment, `meanTempoAt`
confined to the canonical [0.15, 0.85], fitted over the exact renderer).

**Every DL in this section, the v1 model's included, is `mdl.dl_tempo_map` of the map.**
`infer.py` also records a `dl_tokens` = decoded-sequence length, which is a different
unit (median 66 vs 64 on these maps, up to ~20 tokens apart on individual windows).
Mixing the two — the first release used the decoded length as the oracle's budget while
pricing the oracle with `mdl` — flatters the oracle slightly; it is now one counter
throughout.

### B1. The ceiling table

`T1` marks membership of the canonical hypothesis class (segments ≥ 4 beats).

| explanation | T1 | RMSE med (ms) | RMSE p90 | DL med | instr | vs const |
|---|---|---|---|---|---|---|
| const (1 instruction) | yes | 383.9 | 1854.7 | 8 | 1 | 1.00 |
| stair-8 | yes | 165.3 | 438.2 | 52 | 6 | 0.43 |
| power-8 | yes | 98.2 | 335.2 | 115 | 7 | 0.26 |
| stair-4 | yes | 82.5 | 305.7 | 103 | 12 | 0.21 |
| **power-4 (canonical ceiling)** | yes | **57.8** | 185.3 | 216 | 13 | 0.15 |
| stair-2 | – | 51.6 | 161.7 | 206 | 24 | 0.13 |
| stair-1 | – | 41.3 | 126.3 | 410 | 46 | 0.11 |
| stair-0.5 | – | 24.7 | 73.9 | 556 | 62 | 0.06 |
| greedy (sub-beat, 48 instr) | – | 25.3 | 72.8 | 472 | 48 | 0.07 |
| **DL-matched oracle** (≤ the v1 model's own token budget) | – | **100.6** | 348.5 | 59 | – | 0.26 |
| **v1 model** | – | **5287.0** | 13523.5 | 64 | 4 | **13.77** |
| isotonic (best monotone tick→ms map of ANY kind) | – | 20.4 | 50.2 | – | – | 0.05 |
| chord-floor (note vs its tick's mean onset) | – | 20.4 | 50.2 | – | – | 0.05 |

### B2. The v1 sim2real error is ~99 % model failure

| piece | v1 | canonical ceiling (power-4) | DL-matched oracle | sub-beat greedy | any-tempo floor | ceiling share |
|---|---|---|---|---|---|---|
| Chopin op10/3 | 8572 | 120.1 | 304.4 | 29.1 | 23.3 | **1.4 %** |
| Chopin op38 | 5445 | 60.2 | 83.1 | 26.4 | 22.4 | **1.1 %** |
| Mozart K331/i | 4454 | 54.9 | 114.4 | 25.0 | 17.1 | **1.2 %** |
| Schubert D783/15 | 3401 | 42.5 | 59.0 | 22.1 | 22.0 | **1.2 %** |

Medians of per-window ratios (the document's convention), over all 40 windows:

```
power-4            / v1 = 0.012     canonical ceiling is 1.2 % of the v1 error
dl-matched-oracle  / v1 = 0.024     ... even at the model's OWN 64-token budget: 2.4 %
greedy-best        / v1 = 0.004
isotonic           / v1 = 0.004
const              / v1 = 0.089     the 1-instruction baseline is 11x better than v1
```

and **v1 is worse than the constant-tempo baseline in 39/40 windows**.

**This closes the LOG's open question.** The canonical normal form is not what broke
sim2real. With the *same number of tokens the model actually emitted*, a canonical map
exists that renders to 100.6 ms; the model produced 5287 ms. The 2.9–9.0 s figures are
**domain gap plus model failure**, in that order — the worst piece (op10/3, ~31 qBPM) is
the one furthest outside the sampler's `[40, 200]` bpm range, and it is also the one where
the model is furthest from its own ceiling. The v3 domain-randomisation plan
(bpm `[25, 240]`, finer rhythm grid, denser polyphony, chord jitter) is the right fix, and
no change to `CANONICAL.md` §§1–7 is needed to enable it.

*(Every number in B1/B2 moved 10–40 % against the first release, and all in the same
direction: the first release's 40 windows were all `_w0`, i.e. piece openings, which are
steadier than the corpus average. The conclusion is unchanged and slightly stronger — the
ceiling share fell from 0.9–1.9 % to 1.1–1.4 %.)*

### B3. What granularity real playing demands

| family | segment length | median RMSE | DL | RMSE / floor |
|---|---|---|---|---|
| stair-8 | 8 beats ≈ 7.7 s | 165.3 ms | 52 | – |
| stair-4 | 4 beats ≈ 3.8 s | 82.5 ms | 103 | – |
| power-4 | 4 beats ≈ 3.8 s | 57.8 ms | 216 | **2.73×** |
| stair-2 | 2 beats ≈ 1.9 s | 51.6 ms | 206 | – |
| stair-1 | 1 beat ≈ 0.96 s | 41.3 ms | 410 | 1.91× |
| stair-0.5 | 1/2 beat ≈ 0.48 s | 24.7 ms | 556 | **1.03×** |

(The `RMSE / floor` column is a median of per-window ratios, so it does not equal the
quotient of the two medians.)

Two clean results:

- **At ~480 ms segments a tempo map reaches the floor.** `stair-0.5` is 1.03× the isotonic
  floor and matches the sub-beat greedy optimum (48 instructions, boundaries free at
  sixteenth resolution) to within a few percent. Beyond half-beat granularity there is
  nothing left for a tempoMap to explain.
- **The entire irreducible residual is chord asynchrony.** `isotonic == chord-floor` in
  **40/40** windows — the per-tick mean onsets are already monotone, so the best monotone
  map is simply the per-tick mean, and everything below it is within-chord spread. §D
  measures the same 20.4 ms from the other direction.

### B4. Correction to `findings.md` §A: on real data, power transitions do not dominate

`findings.md` §A concluded that canonical MPM "strictly dominates every staircase" — on
pieces the canonical sampler generated, which §0 of `CANONICAL.md` flags as
self-consistency. On real performances the ordering at equal description length is
**reversed, mildly but consistently** (medians of per-window ratios):

| comparison | canonical? | RMSE ratio | DL ratio |
|---|---|---|---|
| `stair-4` vs `power-8` | both canonical | **0.88** | 0.90 |
| `power-8` vs `stair-8` (*same grid*) | both canonical | 0.71 | 2.21 |
| `power-4` vs `stair-4` (*same grid*) | both canonical | 0.66 | 2.11 |
| `stair-2` vs `power-4` | **rival violates T1** | **0.91** | 0.96 |

Dominance counts (≤ the target's DL **and** < its RMSE), reported both ways because the
distinction is the whole point:

| | dominates `power-8` | dominates `power-4` |
|---|---|---|
| canonical staircases only (≥ 4 beats) | **31/40** | **0/40** |
| any staircase, incl. non-canonical 2 / 1 / 0.5 | 31/40 | 26/40 (all `stair-2`) |

and in the other direction, a power chain dominates `stair-4` in **0/40** and `stair-2`
in **1/40**.

Three readings, in order of how easy they are to misquote:

1. **The 26/40 that beats `power-4` is `stair-2`, which is not in the canonical class.**
   Restricted to canonical rivals the count is **0/40**. The first release of this
   document quoted "some staircase dominates `power-4` in 28/40" bare, next to a
   normative decision; that number is real but it is a statement about a T1 violation,
   not about canonical MPM. `CANONICAL.md` §14 D2 now carries both.
2. **Inside the canonical class the ordering is still against the transition, but for a
   different reason.** `stair-4` dominates `power-8` in 31/40 at 0.90× the DL: at equal
   budget, *halving the segment length* beats *bending the curve*. This is a legitimate
   intra-canonical comparison and it is the one D2 rests on.
3. **Transitions are not useless.** Against a staircase on the *same* grid a power
   transition cuts RMSE by 29–34 % (`power-8`/`stair-8` = 0.71, `power-4`/`stair-4` =
   0.66), so it earns its ~2.1× tokens locally. The mechanism behind all three rows is
   granularity: **real tempo fluctuation is not smooth on a 4-beat scale** — human rubato
   lives at the 0.5–2 beat scale (B3).

H1 ("tempo owns all smooth inter-boundary timing") remains the right *attribution* rule;
the MDL dominance claim behind it is sampler-internal and should not be quoted about
human performances. `findings.md` §A already says so; this is the measurement that
confirms it.

---

## C. What this means for the v4 sampler

### C1. movementMap — sample the *notational* band, not the sensor

A faithful **canonical** chain for a real trace costs **1282–5398 tokens per performance**
(12–57 tokens per second of music): 1282 for the 159-segment adaptive fit at 24.7 cc,
3350 for the canonical fixed 1/4-beat grid at 18.5 cc, 5398 with free shapes at 12.0 cc.
`CANONICAL.md` §5's whole-piece tempo+dynamics budget is **85.5 tokens**, and the v3
training target budget is 448. Sampling realistic half-pedalling would make the
movementMap **15–63×** the rest of the target sequence and would *still* leave 12–19 cc
of residual.

(The first release quoted 959–2223. Those chains were fitted on a 1/8-beat candidate grid
with a 90-tick minimum segment — an M3 violation — and priced with `position` inheritance,
which M6 forbids while the fork defects of §A4 stand. Both corrections push the same way,
and the qualitative conclusion is strengthened, not weakened.)

Recommended v4 sampler (a `sampleMovementMap` mirroring `sampleDynamicsMap`):

| parameter | value | source |
|---|---|---|
| grid | 1/4 beat (180 ticks); minimum segment 180 ticks | M3, proof V4 |
| structure | pedal **cycles**: plateau → down-ramp → up-ramp → plateau | A1 |
| cycle rate | 1 cycle per **2–4 beats** (uniform) | observed **1.52 cycles/s** (p10 1.21, p90 1.81) ⇒ 0.3–1.6 beats/cycle over the corpus tempo range. Sample **deliberately sparser** than reality: this is the notational band, and the budget check below is why |
| ramp length | 1–2 grid units (180–360 ticks ≈ 100–450 ms) | A1, A2 |
| plateau level | integer CC, uniform **[53, 124]** (median 88) — **never 127** | A1, pooled cycle levels |
| release level | integer CC, uniform **[0, 23]** (median 3) | A1, pooled cycle levels |
| depth deadband | reject a cycle with `plateau − release < 16 cc` | this is the same 16 cc that defines a cycle in A1; below it a cycle is invisible against the 12–19 cc fit floor of A2 |
| curvature | uniform [0, 0.9], 2 dec, omitted at 0.40 | M9 |
| protraction | uniform [−0.7, 0.7], 2 dec, omitted at 0.00 | M9, A3 reading 2 |
| controller | `"sustain"` (CC 64); optionally a sparse second `"soft"` chain at ~1/10 the rate | M7; corpus has 25,011 soft vs 312,380 sustain events |
| terminator | mandatory, and carries no `Z` | M1, M6 |

Budget check: a 32-beat piece at 1 cycle / 3 beats ⇒ ~11 cycles ⇒ ~33 segments ⇒
**~270 tokens** at 8.1 tokens/segment under M6 (~170 at 5.1 tokens/segment once the two
fork defects of §A4 land and inheritance becomes legal). Target length rises from ~85 (v2)
/ ~200 (v3) to ~470 — i.e. **the M6 version does not fit the 448 budget**. Raise the
budget to 512 with the v4 regeneration, decode movement as a separate stream, or fix the
fork first; the third option is a two-line patch and buys 37 %.

**Do not train the model to reproduce a sensor-faithful pedal.** The band the canonical
form owns is the *notational* one (which harmony gets a pedal change, how deep, how fast);
the 12–19 cc that a 1/4-beat chain leaves on real data is a movement-imprecision band and
belongs to v5. Evaluating v4 pedal predictions should therefore use the **CC-64 threshold
agreement** (A3, `binAgr`) alongside CC RMSE — a 1/4-beat chain reaches 0.86–0.94 there
while its RMSE still looks poor.

### C2. asynchronyMap — cheap, well-posed, and worth doing first

| parameter | value | source |
|---|---|---|
| parts | exactly 2; asynchrony on part 2 only, part 1 is the reference | Y1 |
| offset | integer ms, abs value in [5, 60], deadband (−5, 5) | Y2, Y3, §D |
| sign at date 0 | non-negative (give part 1 to the leading voice) | Y5 |
| segments | ≥ 4 beats, beat-aligned, 1–3 instructions per piece | Y4 |
| typical value | 10–30 ms (real median lead 21.5 ms, mean 19.3) | §D |

Cost: 3 instructions × ~9 tokens = **~27 tokens**. For 27 tokens it adds a genuinely new,
identifiable timing band (H7), it is the only v4 map with a clean inverse, and it needs no
renderer changes. **It should ship before movement.**

One caveat the corrected sample surfaces: the top-voice lead is positive in **35/40**
windows, not 40/40 as the openings-only sample suggested. Y5 remains the right canonical
rule (it dodges meico's `Math.max(0.0, …)` clamp), but a fitter working on real data must
choose which part is "part 1" from the *sign of the fitted offset*, per piece, rather than
assuming the top voice always leads.

### C3. Does the canonical form need finer tempo granularity, or imprecision maps?

**Tempo granularity: no change for v4, and the reason is not what we expected.** The
canonical ≥4-beat tempo family leaves 2.7× the achievable floor on real playing (§B3),
and a 0.5-beat family would close that. But the v1 model is **91× above its own ceiling**
(§B2), so finer granularity would buy nothing until the model is within, say, 2× of the
ceiling. Keep T1 (segments ≥ 4 beats) through v4; revisit if a model ever reaches ~110 ms
render RMSE on Vienna. What *is* urgent is the domain randomisation already queued in
`LOG.md` — the ranking of the four pieces by v1 error is exactly their ranking by
distance from the sampler's tempo range.

**Imprecision maps: needed, but they live inside a ~20 ms budget, not a seconds one.**
The whole irreducible timing residual on Vienna is 20.4 ms (p90 50.2) and it is *entirely*
within-chord spread (§B3); a constant per-part asynchrony takes a real but minority bite
out of it (§D: a median 39 % of the *lead's second moment*), and the rest is
`ImprecisionMap`'s. Resist the temptation to turn that into a single number — the 39 % is
a between-voice statistic and the 20.4 ms is a note-level RMSE, so `sqrt(1−0.39) × 20.4`
is not an identity (the first release quoted "≈8–9 ms" from exactly that step). What holds
is the **bracket and the ordering**: `ImprecisionMap` cannot move a render metric by more
than ~20 ms, which is one to two orders of magnitude below everything else on the critical
path. Priority: after movement and asynchrony, i.e. v5 as planned, and driven by *realism*
rather than by residual reduction.

**The one band that genuinely needs more expressive power is the pedal.** A 1/4-beat
movement chain leaves 12–19 cc on a 32 cc signal (§A), and no beat-aligned grid can fix
that because the pedal's bandwidth is fixed in real time — worse, M3's 180-tick floor
makes the sub-180 ms regime *unreachable* on the slow pieces at any legal grid. Either the
canonical form accepts a band-limited pedal target (the recommendation in §C1) or v5 needs
a movement-imprecision band. This — not tempo — is where the representation ceiling bites.

---

## D. Chord asynchrony in real performances

40 windows, "highest pitch at a score tick" vs "the rest" standing in for the two parts an
asynchronyMap models. `lead = mean(onset of the lower notes) − mean(onset of the top
note)`, over score ticks carrying ≥ 2 notes (median 64 per window).

| quantity | median | p10 | p90 |
|---|---|---|---|
| per-window median lead (ms) | **21.5** | 8.9 | 33.3 |
| per-window mean lead (ms) | 19.3 | −1.7 | 30.5 |
| per-window sd of the lead (ms) | 18.1 | 11.0 | 52.0 |
| share of the **second moment** explained by one constant offset | **0.39** | 0.00 | 0.85 |
| windows with a positive mean lead | **35 / 40** | | |

Three consequences:

1. The melody-lead figure the LOG quotes (~31 ms) is the upper end; the median is 21.5 ms
   and the sign is positive in **35 of 40** windows. That still makes Y5 (non-negative
   offset at date 0, i.e. part 1 = the leading voice) the *natural* canonical assignment,
   but not an automatic one — see §C2.
2. A single constant offset explains a median **39 %** of the lead's second moment
   `E[lead²] = μ² + σ²`. **This is not a variance share**: a constant explains 0 % of the
   variance by construction, and calling it one (as the first release did) invites the
   invalid arithmetic §C3 now refuses. 39 % of the second moment is enough to justify a
   band of its own for ~27 tokens; it is not enough to claim asynchrony explains most of
   chord spread.
3. The statistic is **not robust**: p10 ≈ 0.00, p90 0.85. In windows where the mean lead
   is small relative to its scatter, a constant offset explains nothing at all and the
   whole signal is imprecision (v5) — which is simultaneously the floor of every timing
   metric in this program (§B's `chord-floor` row, from the other direction).

The deadband follows: with sd 18.1 ms over 64 chords the standard error of a per-segment
offset is ≈2.3 ms, so the 5 ms deadband used everywhere else in `CANONICAL.md` is ≈2 SE
here. No map-specific widening is needed (contrast R3, where the frame length forced one).

*(All five rows moved against the first release, which sampled only `_w0`: piece openings
have larger and steadier melody lead than the corpus average. The sd's p90 of 52 ms is one
genuinely pathological window, not a corpus property.)*
