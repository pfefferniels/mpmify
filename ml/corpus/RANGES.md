# Era priors — every range, and why it is admissible

Companion to `era_sampler.mjs`, which holds the normative copy (`ERA_RANGES`). This document
says what each number means musically and why it does not break the identifiability argument
the range sits inside. `verify_corpus.mjs` leg 3 prints the **realised** ranges from the
emitted JSONL, so every claim here is checkable against data rather than against intent.

Status: **v1.0 hand-set priors.** SYSTEM.md §2.1 says exactly this — "priors start hand-ranged,
get fitted from real corpora (mpmify-on-nASAP) in v1.1". Nothing below is measured from human
performances; the two places where a measurement *does* exist (Vienna melody lead, Vienna pedal)
are marked.

---

## 0. The governing constraint

**No rule of `ml/CANONICAL.md` is relaxed for any era.** Every G, T, D, A, R, M and Y rule
holds identically for baroque, classical and romantic material. What varies is the
*distribution inside* the rule.

That is not conservatism for its own sake. The normal form is what makes the inverse problem
well posed (CANONICAL §0): it picks one representative per render-equivalence class. A per-era
exception would make two hypotheses indistinguishable — "the model learned the era" and "the
model learned that this era uses a different normal form" — and the second is not a musical
result.

### The one place latitude was offered, and the answer

The brief for this work permitted widening rubato's `lateStart`/`earlyEnd` and the frame
alphabet for romantic material, *provided an identifiability argument came with it*.

**Frames: taken, inside R1.** R1 already admits `{720, 1440, 2880}`. The romantic prior draws
from `{1440, 2880}` and the baroque prior from `{720}`. No widening was needed, so no argument
is owed beyond the musical one (§4 below).

**`lateStart`/`earlyEnd`: declined.** The argument for declining:

1. **It is the load-bearing rule.** R2 pins `lateStart = 0, earlyEnd = 1`, which makes every
   frame boundary a fixed point of the warp `t ↦ t − ℓ + frame·(ℓ/frame)^intensity`. The span
   therefore has **exactly zero net tick displacement at the frame grid** — that is CANONICAL
   H2, and it is what keeps rubato from masquerading as tempo.
2. **Widening aliases three bands at once, in the era where all three are largest.** With
   `lateStart > 0` the whole frame translates. A constant translation of a run of onsets is
   precisely what an asynchrony instruction is (Y1–Y3) and what a tempo instruction absorbs
   (H1). Romantic playing is the era with simultaneously deep rubato, large melody lead and
   large tempo arcs, so it is the era where that alias is most expensive, not least.
3. **The DSL cannot express it.** The v3 production is `U date F frameBeats I intensity X
   endDate` — no `S`/`E` slots (CANONICAL §5). A span outside 0/1 is not representable in the
   training target, so it would be a label the decoder cannot emit and the evaluator cannot
   score. Adding the slots means vocabulary v5 and a re-freeze (LOG.md B1), plus a
   re-derivation of H2. An era prior does not justify that.
4. **Nothing is lost.** What romantic rubato needs — deeper, slower, longer — is fully
   available inside R1/R3/R5 by taking the 2- and 4-beat frames and the far tails of the
   intensity range. §4 gives the numbers.

CANONICAL §5 keeps the extended production documented for the day the decision is reopened;
this corpus does not reopen it.

---

## 1. tempoMap (T1–T4)

| | baroque | classical | romantic |
|---|---|---|---|
| bpm (log-uniform) | 52 – 152 | 48 – 168 | 34 – 152 |
| segment length (beats) | 8 – 24 | 4 – 16 | 4 – 12 |
| tempo continuity at a boundary | 0.75 | 0.60 | 0.45 |
| transition probability | 0.12 | 0.35 | 0.62 |
| transition depth `\|log2(to/bpm)\|` | 0.15 – 0.25 | 0.15 – 0.40 | 0.15 – 0.75 |
| p(the transition slows) | 0.50 | 0.60 | 0.60 |
| `meanTempoAt` | 0.15 – 0.85 | 0.15 – 0.85 | 0.30 – 0.85 |
| closing ritardando probability | 0.15 | 0.50 | 0.85 |

*Musically*: baroque tempo is a section-level constant with occasional shading; classical adds
moderate arcs; romantic is the era of continuous tempo motion.

*Admissibility*: all three bpm ranges sit inside v4's `[25, 240]` domain, so the corpus cannot
push a model outside a range the synthetic set already covers. Every depth is `≥ 0.15` (T2)
and every `meanTempoAt` inside `[0.15, 0.85]` (T3), which keeps the shape parameter observable
(CANONICAL §4's table: at 4 beats and depth 1.11 the shape is worth 3.3 ms, and it grows
quickly with depth — romantic's 0.75 depth is a ratio of 1.68, where the same table reads
tens of milliseconds). Segments are `≥ 4` beats everywhere (T1), and boundaries land on bar
groups, so a segment is always a whole number of bars.

*The closing ritardando* is the one structure the synthetic sampler could not produce. It is
spelled canonically: a transition on the last governing instruction plus a **constant
instruction at the piece end**. meico renders a dangling transition as inert (G7), so without
that terminator a final ritardando would be a label with no footprint — the same trap M1
closes for movement chains and R6 for rubato spans.

## 2. dynamicsMap (D1, H4)

| | baroque | classical | romantic |
|---|---|---|---|
| shape | **terraced** (constants only) | constants + transitions | constants + transitions |
| level alphabet | {46, 62, 78, 94, 106} | uniform 40 – 112 | uniform 30 – 115 |
| segment length (beats) | 8 – 24 | 4 – 16 | 4 – 12 |
| transition probability | 0.00 | 0.45 | 0.75 |
| minimum level change / depth | 10 | 8 | 8 |
| `curvature` / `protraction` | — | 0–0.7 / ±0.5 | 0–0.9 / ±0.7 |

*Musically*: terraced dynamics are the baroque keyboard's defining dynamic gesture — a
registration or manual change, not a hairpin. Classical adds shaped transitions; romantic
makes them the norm.

*Admissibility*: D1 sets the transition depth floor at 8 velocity units, which is far above
the MIDI quantiser. The terraced form has no transitions, so D1's depth rule does not apply
to it — and that is exactly why it needs its own floor: **10 units between adjacent
terraces**, the constants analogue. Without it, G8 merges only *equal* constants and a 2-unit
level change would cost a full instruction while being inside the rounding of the emitted
velocity. The 5-level ladder additionally makes the baroque target a small discrete alphabet,
which is what "terraced" means as a *representation* and not only as a sound.

All ranges stay inside `[30, 115]`, the domain the v2/v3/v4 sets use, so no velocity clipping
behaviour is introduced that the existing evaluation has not seen.

## 3. articulationMap (A1–A6)

| | baroque | classical | romantic |
|---|---|---|---|
| target density (share of that part's onset dates) | 0.35 | 0.20 | 0.12 |
| `relativeDuration` | 0.42 – 0.92 | 0.50 – 1.08 | 0.62 – 1.15 |
| `absoluteVelocityChange` | −10 … 10 | −16 … 16 | −25 … 25 |

*Musically*: articulation is the baroque keyboard's primary expressive channel (dense,
detached, no over-legato — a harpsichord cannot hold a note past its key release). Classical
is articulation-forward but mixed. Romantic playing is legato-leaning, with articulation used
sparingly and for accent.

*Admissibility — and the one place a CANONICAL number is superseded by its own justification.*
A1 sets ~15 % on the synthetic sampler, and justifies it by what it **leaves**: "≥ 5 clean
dates per 4-beat segment", the unarticulated dates from which the dynamics and tempo curves
are read. That justification is a function of note density, and real repertoire is 2–6× denser
than the synthetic score (median 1.6 onset dates per beat there; Bach's WTC reaches 8). So the
*budget* is the rule that carries over, not the 15 %:

```
maxDensity = 1 − 5 / (distinct onset dates per 4-beat window)
density    = min(era prior, maxDensity)
```

`maxArticulationDensity()` implements it, the realised density is reported per piece, and
`verify_corpus.mjs` re-derives the cap from the emitted notes and fails a window that exceeds
it by more than 3σ of the Bernoulli sampling noise. A part too sparse to leave five clean
dates gets **no** articulation at all rather than a reduced amount: below the budget every
date is doing two jobs and the decomposition is not identified.

The A2 deadband `[0.97, 1.03]` and the A3 deadband `[−2, 2]` are enforced unchanged in every
era; A4 (per date, whole chord) and A6 (part-local maps) are structural and untouched.

## 4. rubatoMap (R1–R8)

| | baroque | classical | romantic |
|---|---|---|---|
| probability a window has rubato | 0.55 | 0.20 | 0.85 |
| `frameLength` | {720} (1 beat) | {1440} (2 beats) | {1440, 2880} |
| `intensity` bands | [0.58, 0.86] | [0.72, 0.88] ∪ [1.13, 1.35] | [0.55, 0.88] ∪ [1.13, 1.90] |
| span length (beats) | 8 – 32 | 8 – 16 | 8 – 32 |
| max spans per window | 2 | 1 | 2 |

**What `intensity` does, in numbers.** With R2's `lateStart = 0, earlyEnd = 1`, the frame
midpoint maps to `0.5^intensity`:

| intensity | midpoint lands at | the pair sounds |
|---|---|---|
| 0.58 | 0.669 | 2 : 1 long–short — classic *notes inégales* |
| 0.72 | 0.607 | 1.55 : 1 |
| 0.86 | 0.551 | 1.23 : 1 — a light swing |
| 1.13 | 0.457 | short–long (*lourée*) |
| 1.90 | 0.268 | a heavily delayed arrival |

So `intensity < 1` **is** inégalité, and the baroque band is the interval running from a
triplet-like 2:1 down to a barely-swung 1.23:1. It lies entirely below R3's `[0.89, 1.12]`
deadband, so every sampled span displaces onsets by more than the 5 ms observability floor at
every tempo in the era's range (R3's table: at `frameLength = 720` and 100 bpm, intensity 1.07
is already 7.1 ms; 0.86 is a larger departure from 1 than 1.07 is).

**Frames.** Inégalité lives inside the beat, so baroque takes the 1-beat frame — which has the
useful side effect that R8 is satisfied by construction there: tempo dates are integer beats
(G4) and span starts are bar-group multiples, so `(tempoDate − spanStart) mod 720 == 0`
always. Romantic rubato is a phrase-scale gesture and takes the 2- and 4-beat frames, where
the same intensity buys a proportionally larger millisecond displacement (R3: 13.8 ms and
27.6 ms at intensity 1.07 against 7.1 ms at one beat). R8 is then enforced by **rejection**
against the already-sampled tempo map, as in the v4 sampler — a frame straddling a tempo
boundary can render NaN milliseconds, which is a defect and not a rare event.

R5 (span ≥ 8 beats and a whole number of frames), R6 (neutral terminator), R7 (no overlap)
and R4 (`loop=true`) hold in every era.

## 5. asynchronyMap (Y1–Y6)

| | baroque | classical | romantic |
|---|---|---|---|
| probability | 0.10 | 0.45 | 0.90 |
| `\|milliseconds.offset\|` | 5 – 14 ms | 7 – 24 ms | **10 – 40 ms** |
| max segments | 2 | 3 | 3 |

*Musically*: melody lead is a piano-texture phenomenon — the top voice sounds slightly before
the accompaniment. A harpsichordist's two hands are not a melody-and-accompaniment texture, so
baroque gets almost none; romantic gets the full effect.

*This is the one prior with a real measurement behind it.* LOG.md's Vienna 4x22 ingest measures
a per-window median top-voice lead of **21.5 ms** (p10 8.9, p90 33.3) with a positive mean lead
in 35 of 40 windows. The romantic band `[10, 40]` brackets that distribution; the classical and
baroque bands are scaled down by prior, not by measurement, and are labelled as such.

*Admissibility*: every magnitude is inside Y3's `[5, 60]`. Y1 (part 2 only) is enforced
structurally — `build_msm.mjs` puts the highest-register part first, so part 2 *is* the
accompaniment and a positive offset means it sounds after the melody, which is both the
measured sign and the sign Y5 needs at date 0 to avoid meico's `max(0, date+offset)`
truncation. A window with anything other than exactly two parts gets **no** asynchronyMap:
"which part lags" has no canonical answer for three staves, and Y1 names part 2 specifically.
Later segments start at beat ≥ 4 (Y4) — over a second in at the fastest era tempo — so they
carry either sign without risking the clamp.

## 6. movementMap — pedalling (M1–M10)

| | baroque | classical | romantic |
|---|---|---|---|
| probability | 0.20 | 0.55 | 1.00 |
| position band (CC) | 0 – 48 | 0 – 127 | 0 – 127 |
| segment lengths (¼ beats) | {4, 8, 12, 16} | {2, 3, 4, 6, 8} | {1, 2, 3, 4, 6, 8} |
| transition probability | 0.25 | 0.30 | 0.60 |
| boundary continuity | 0.70 | 0.50 | 0.55 |

*Musically*: baroque keyboard practice has essentially no sustain pedal, and a fortepiano's
damper lift is shallow — hence a rare, low-position chain — 0.2, not 0.1: a prior that fires on fewer than a handful of the pilot's 25 baroque windows leaves the band untested, and "minimal" is carried by the shallow position band as much as by the rate. Classical pedalling steps (mostly
plateaus and jumps, moderate segment lengths). Romantic pedalling **sweeps**: half-pedal
curves, the finest legal segments, and `curvature`/`protraction` sampled so the S-curve's
steep part moves inside its segment (M9 — worth 35 % of the fit RMSE at the canonical
¼-beat density, per CANONICAL §9's Vienna measurement).

*Admissibility*: M3's ¼-beat grid and 180-tick minimum segment hold in every era (below that,
`getTForDate`'s 1-tick x-tolerance costs more than a CC step). Positions are on M4's
128-value alphabet. The transition depth and boundary-jump floors are M5's 19 CC and the
sampler's 13 CC where the band allows — a *shallow* band cannot support a 19 CC depth, so the
baroque floor scales with the band (40 % / 30 % of its width, never below 6 CC, which keeps it
above the CC quantiser and M3(i)'s inversion error). At the baroque band's 48 CC width both
floors land exactly on the v4 values, so the shared invariant suite passes unchanged. M1's
terminator discipline — a neutral constant at the chain end, preceded by a transition — is
reproduced verbatim from `ml/node/sampler.mjs`; a chain that cannot satisfy it is emitted as
**no chain at all** rather than as one that stops short.

## 7. imprecisionMap.timing — the new band (v1.1)

| | baroque | classical | romantic |
|---|---|---|---|
| `deviation.standard` | 6 – 12 ms | 8 – 16 ms | 10 – 22 ms |

Written as `<distribution.gaussian date="0" deviation.standard="σ" limit.lower="−3σ"
limit.upper="3σ" seed="…" milliseconds.timingBasis="200"/>` inside a global
`<imprecisionMap.timing>`.

**The target is the parameter, never the sample.** The per-note offsets are a draw; a model
asked to reproduce them is being asked to reproduce a random number generator. The JSONL
record carries `{"map":"timing","distribution":"gaussian","sigma_ms":…,"limit_ms":…,
"timing_basis_ms":…,"seed":…}` and the seed is *provenance* — what makes the render
repeatable — not something to predict.

*Scale*: CANONICAL §14's D3 measures the irreducible note-level residual on real playing at
**20.4 ms** (p90 50.2) and shows it is essentially within-chord spread. σ = 10–22 ms for
romantic playing sits inside that budget; the smaller baroque and classical values are prior,
not measurement.

*Limits*: ±3σ clips 0.27 % of the mass — enough that a tail draw cannot reorder neighbouring
notes, little enough that the clipped distribution's standard deviation is within 0.2 % of σ,
so the label stays true.

*`milliseconds.timingBasis` = 200 ms*: the provider is indexed by `msDate / timingBasis`, so
notes closer together than the basis share an index and therefore an offset. 200 ms is well
below any note rate this corpus reaches at any sampled tempo, so distinct notes get distinct
draws.

**Determinism is measured, not assumed** — `probe_imprecision.mjs`, and the result is recorded
in `README.md` §5. The facade's own contract says a seeded render reproduces only while no two
imprecision offsets share a millisecond date, which on real polyphonic repertoire is often
false.
