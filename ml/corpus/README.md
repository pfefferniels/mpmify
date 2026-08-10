# `ml/corpus/` — era-tagged real repertoire, era-conditioned interpretations

The corpus subsystem of **interpres** (`ml/SYSTEM.md` §2.1). It replaces the synthetic
generator's *random* scores with real public-domain classical piano repertoire, tagged by era,
and samples the interpretation over it with era-conditioned priors — while keeping every rule
of `ml/CANONICAL.md` and the v4 JSONL schema, so the output is admissible to exactly the
pipeline `ml/node/generate_v4.mjs` feeds.

Nothing in this directory writes into the repository tree. All artefacts land under
`ml/data/corpus_pilot*`, which is gitignored — deliberately, because the pilot contains
encodings whose licence reserves derivative rights (§1) and the repository is public.

---

## 1. Sources and licensing

Three tiers. The **work** is public domain in every case (all composers died before 1916);
what the licence governs is the **encoding**, which is a separate copyrightable act.

| tier | source | repo (pinned) | encoding licence | pilot use | may we redistribute the score or a derivative of it? |
|---|---|---|---|---|---|
| **A** | Chopin first editions (NIFC) | `pl-wnifc/humdrum-chopin-first-editions` @ `95dfb10` | **CC BY 4.0** | 8 romantic | **yes**, with attribution |
| **B** | Scarlatti keyboard sonatas | `craigsapp/scarlatti-keyboard-sonatas` @ `567731b` | **CC BY-NC-SA 4.0** | 5 baroque | yes, non-commercially, share-alike |
| **B** | Mozart piano sonatas | `craigsapp/mozart-piano-sonatas` @ `0f1f49d` | **CC BY-NC-SA 4.0** | 5 classical | yes, non-commercially, share-alike |
| **B** | Haydn piano sonatas | `craigsapp/haydn-piano-sonatas` @ `299abc8` | **CC BY-NC-SA 4.0** | 5 classical | yes, non-commercially, share-alike |
| **C** | Bach, Well-Tempered Clavier | `humdrum-tools/bach-wtc` @ `0b4f4d8` | **rights reserved** — `!!!YEC: Copyright (c) 1994, 2000 CCARH`, `!!!YEM: Rights to all derivative editions reserved` | 5 baroque | **no** — internal research only |
| **C** | Scriabin, *Mysterium* corpus | `craigsapp/scriabin` @ `7daa113` | **unstated** (no licence file, no `!!!YEM`); treated as all rights reserved | 2 romantic | **no** — internal research only |

Attribution strings, per-file SHA-256 and the exact pinned URL for every score are written to
`ml/data/corpus_pilot/fetched.json` by `fetch_scores.mjs`; the human-readable copies live in
`manifest.json` under `sources`.

**Why tier C is in the pilot at all.** Baroque *keyboard* repertoire under an open licence is,
on the sources surveyed, Scarlatti and essentially nothing else — and a baroque era prior
fitted on Scarlatti alone would be a Scarlatti prior. Bach's WTC is the repertoire the era
prior is *about*. The tier is therefore used, marked `redistributable: false` in the manifest,
kept out of the repository by the gitignore, and flagged here so that any release built from
this corpus can be filtered to tiers A and B mechanically. The same reasoning admits two
Scriabin preludes so that "romantic" is not synonymous with "Chopin".

**Composer coverage is a known pilot limitation.** Romantic is 8 Chopin + 2 Scriabin; classical
is Mozart + Haydn; baroque is Bach + Scarlatti. Six composers over 30 movements is enough to
exercise the pipeline and not enough to fit an era prior — which is why SYSTEM.md puts fitted
priors in v1.1 and this pilot's priors are hand-set (`RANGES.md`).

**Not used, and why.** PDMX (~250 k MusicXML from MuseScore; the Zenodo record is CC BY 4.0,
`no_license_conflict` subset 87.7 %) is the study's recommended source for *releasable*
material and remains the right one for scale. It is not in this pilot because it carries no
reliable era or instrumentation metadata — the pilot needs 30 pieces whose era tag is a fact
about the composer, not a guess about a user upload — and because a MusicXML front end is a
second conversion path to validate. It is the obvious v1.1 expansion, and the licensing row it
would occupy is tier A.

---

## 2. The pipeline

```sh
cd ml/corpus
node   fetch_scores.mjs                       # 1. pinned download + sha256      -> data/corpus_pilot/kern
python3 kern_to_mei.py                        # 2. kern -> MEI + MIDI + timemap  -> mei/ midi/ timemap/
node   build_msm.mjs                          # 3. MEI -> MSM (720 ppq)          -> msm/ + msm/index.json
python3 score_check.py                        # 3b. MSM vs Verovio's MIDI        -> msm/score_check.json
node   probe_imprecision.mjs                  # 4. is a seeded render reproducible?
node   generate_corpus.mjs ../data/corpus_pilot_v4.jsonl --dump-dir ../data/corpus_pilot/dump --imprecision
node   verify_corpus.mjs ../data/corpus_pilot_v4.jsonl --imprecision ../data/corpus_pilot_v4.imprecision.jsonl
node   ../node/verify_v4.mjs cross ../data/corpus_pilot_v4.jsonl ../data/corpus_pilot/dump espressivo
python3 features_check.py ../data/corpus_pilot_v4.jsonl --dsl
```

Everything runs `nice -n 15`. Step 2 is seconds; step 3 is the slow one (espressivo's MEI
importer takes 0.3–55 s per movement, superlinearly in the number of layers — a 21 kB Mozart
sonata-allegro exceeded five minutes and is not in the pilot).

| file | what it is |
|---|---|
| `manifest.json` | the pilot: sources pinned to commit SHAs, 30 pieces with era/composer/work |
| `fetch_scores.mjs` | pinned download, sha256 per file, `fetched.json` |
| `kern_to_mei.py` | Verovio **pip 6.1.0** (never the CLI), `getMEI({scoreBased, pageNo: 0})`, `expandNever`, MIDI + timemap |
| `score_msm.mjs` | MSM parse / normalise / re-date / window / emit — the score-side decisions, one place |
| `build_msm.mjs` | MEI → MSM via espressivo `convertMeiToMsmMpm`, + `msm/index.json` |
| `score_check.py` | MSM vs Verovio's own MIDI: the corpus's exact floor |
| `era_sampler.mjs` | **the era-conditioned samplers** and `ERA_RANGES` (normative) |
| `RANGES.md` | every range, its musical reason and its identifiability argument |
| `generate_corpus.mjs` | window → sample → render (espressivo T13) → v4 JSONL (+ imprecision variant) |
| `probe_imprecision.mjs` | determinism measurement for the seeded imprecision map |
| `verify_corpus.mjs` | invariants (delegating to `ml/node/verify_v4.mjs`) + corpus checks + realised ranges |
| `features_check.py` | `dataset.piece_to_features_v41` / `piece_to_note_labels_v4` / DSL round-trip |

---

## 3. Traps met, and what was done about them

The study's §7 list (`mpm-ml-research.md`) predicted three; the pilot met all three plus three
more, and the two importer defects below are new.

| # | trap | status |
|---|---|---|
| 1 | **Verovio CLI truncates to page 1** | avoided: pip package, `getMEI({scoreBased: True, pageNo: 0})`, `breaks: none`. 30/30 converted, 0 Verovio warnings. |
| 2 | **meico 8va double shift** (`@oct.ges` *and* the `<octave>` span) | *searched for* by `score_check.py`'s exact pitch-multiset comparison against Verovio's own MIDI. Not observed on this pilot — but the pilot's romantic sources include Scriabin, whose encoder writes 8va passages at sounding pitch, so absence here is weak evidence. The check stays. |
| 3 | **Verovio cross-octave accidental carry** | **not detectable by this method** and said so: both the MEI and the MIDI come from one parse, so a parser defect is in both. Catching it needs a third, independent kern reader — v1.1. |
| 4 | **tuplet rounding → tolerance joins** | implemented (`score_check.py --tol-ticks 6`). The constant is **one Verovio MIDI tick** (Verovio writes MIDI at 120 ppq, so 6 ticks here), which is what the pilot actually shows: 56 notes sit exactly 6 ticks early, all of them principals of an ornament or an arpeggiated chord that Verovio's MIDI nudges by one of its own ticks. 6 ticks is 1/120 of a quarter = 2.8 ms at 120 bpm, below CANONICAL's 5 ms observability floor. Realised worst disagreement: **6.0 ticks**, i.e. the tolerance is exactly used and nothing hides under it. |
| 5 | **grace notes get `duration="0"`** from the MEI importer | dropped and counted (250 of 13 250 notes, 1.9 %; 0 in Bach and most Chopin, up to 15 % in a Haydn movement). A zero-duration note makes `log2` duration-ratio non-finite and `relativeDuration` meaningless; inventing a duration would invent score content. |
| 6 | **NEW — the incomplete-measure pad.** meico's MEI importer advances the clock by a *full* measure across an incomplete one, so a pickup contributes `measureTicks` instead of its own content and everything after the first barline is late by the difference | repaired wholesale: **all note dates and durations are taken from Verovio's timemap**, joined on `xml:id` (`redateFromTimemap`). The per-piece count and worst shift are in `msm/index.json` (`redatedNotes`, `redatedMaxShiftTicks`). Consequence, stated: onset timing is now inherited from Verovio, so `score_check.py`'s onset agreement is no longer independent evidence — pitch, part and note set still are. |
| 7 | **NEW — the two implementations disagree about repeats.** Verovio expands inline (fresh `xml:id`s for the copies); meico defers to an MSM `<sequencingMap>` of `<goto>`s — and resolving meico's gives a *different* piece: Chopin op. 33/3 becomes 717 notes under Verovio and 504 under `Msm.resolveSequencingMaps()`; the Scarlatti sonatas expand under meico (660 → 1256) and not under Verovio | the corpus is the score **as written, once through**: `expandNever` on the Verovio side, no `resolveSequencingMaps()` on the meico side. `hasSequencingMap` in `msm/index.json` marks the affected movements. Resolving consistently on both sides is v1.1 work and is a prerequisite for using repeat structure at all. |

Two further score-side decisions, recorded because they are decisions and not facts:

* **Part order is measured, not assumed.** The converter numbers parts by MEI staff order, which
  follows Humdrum spine order, which is bottom-up. `orderPartsByRegister` renumbers by median
  pitch so part 1 is the upper voice — which is what CANONICAL Y1/Y5 need (part 2's offset must
  be positive, and the melody leads). `verify_corpus.mjs` re-checks the ordering on the emitted
  notes.
* **Not every score is two-part.** The CCARH WTC encodings put a whole prelude on one spine
  (1 MSM part) and a fugue on three. A window with anything other than exactly two parts gets
  **no** asynchronyMap: Y1 names part 2 specifically and "which part lags" has no canonical
  answer for three staves.

---

## 4. Windows

Movements are 48–272 beats; the DSL target budget is 448 tokens (`ml/README.md`). Each
movement is therefore tiled into windows of a whole number of **bar groups** — the smallest
multiple of the measure that is also a whole number of quarter beats, so that G4 (integer-beat
map dates) and bar alignment hold at once; in 3/8 that is two bars, in 3/4 one.

The window layout is **deterministic and seed-independent**: re-sampling the corpus at a new
seed changes the interpretation and nothing else, which is the one-variable discipline the
program runs on. A trailing window shorter than the minimum is dropped, because a 3-beat
window cannot carry a 4-beat minimum segment (T1/D1).

---

## 5. The new map: seeded `imprecisionMap.timing`

`--imprecision` writes a second JSONL with the *same* interpretations plus a global
`<imprecisionMap.timing>` carrying one seeded Gaussian (`RANGES.md` §7). The record's target is
the distribution's **parameters**:

```json
"imprecision": {"map":"timing","distribution":"gaussian","sigma_ms":14.3,
                "limit_ms":42.9,"timing_basis_ms":200,"seed":20260817}
```

The per-note offsets are a *sample*; asking a model to predict them is asking it to predict a
random number generator. The seed is provenance — what makes a render repeatable — not a
target.

**Determinism is measured, not assumed, and the measurement is negative.**
`probe_imprecision.mjs` renders three scores twice at one seed and once at another and counts
identical onsets:

```
total 832 notes | same-seed identical 159 (19.1 %) | different-seed identical 0 (0.0 %)
                | polyphonic (shared ms date) 629 (75.6 %)
IMPRECISION_PARTIAL
```

So a seeded render **does not reproduce** on real piano repertoire: about a fifth of the notes
do. The cause is in the facade's own contract and in the source it is faithful to — where two
imprecision offsets land on the same `milliseconds.date`, `ImprecisionMap.shakeTimingOffsets`
picks which one keeps its value with a bare `Math.random()` and re-rolls the rest through an
unseeded triangular provider (`ImprecisionMap.java:845,894`; the TS port at
`ImprecisionMap.ts:554,608`). 75.6 % of the pilot's notes share a millisecond date with
another event, because piano music is chords. A second run of the probe returned 20.3 % rather
than 19.1 %: the figure itself is not reproducible, which is the finding restated.

**What follows for v1.1.** (a) The seeded variant is usable *as it is* only for a target that
is a distribution parameter — which is what this corpus emits, so the variant is not blocked;
what would be blocked is any use of the per-note offsets as a label, or any claim that a
render can be repeated bit-for-bit. (b) The fix is one line and already identified on the Java
side by this program (`MEMORY.md`: `ImprecisionMap.java:754`, pass `false` for
`shakePolyphonicPart`) — but disabling the shake changes the *acoustic* result, since every
note of a chord would then move together, so it is a renderer decision for the espressivo team
and not a flag to flip locally. (c) Until then, a corpus wanting a repeatable imprecision
render must fix the seed **and** keep the rendered output, not the recipe.

---

## 6. Pilot results (seed 20260810, espressivo T13, `nice -n 15`)

| stage | result |
|---|---|
| fetch | 30 scores, **10 baroque / 10 classical / 10 romantic**, all pinned to a commit SHA with a sha256 recorded |
| kern → MEI | **30/30**, Verovio **6.1.0-682d606**, **0** Verovio warnings, 1.1 s total |
| MEI → MSM | **30/30**, 13 000 notes, 720 ppq. 250 zero-duration grace notes dropped (1.9 %); 2 950 notes on 18 pieces re-dated from the timemap (worst shift 40 500 ticks = 56 beats), 452 durations corrected, **0** notes missing from the timemap. Part counts 1 / 2 / 3 on 2 / 27 / 1 pieces. 150 s total, worst single movement 32 s |
| `score_check.py` | **SCORE_CHECK_PASS** — 12 997 of 13 000 notes matched to Verovio's own MIDI at exact pitch, worst onset delta **6 ticks** (= one Verovio MIDI tick); 3 unmatched, all classified as tie continuations; **0 unexplained** |
| generate (58 windows) | baroque 25 windows / 5 836 notes, classical 18 / 3 491, romantic 15 / 3 381; **0** windows skipped; 3.1 s to render all 58 |
| `verify_corpus.mjs` | **CORPUS_VERIFY_PASS** — `ml/node/verify_v4.mjs invariants` **INVARIANTS_PASS** on the corpus file (the synthetic suite, unmodified), all corpus-specific invariants hold, imprecision variant carries the identical maps on 58/58 records |
| dual-renderer gate (Java fork) | **CROSS_RENDERER_ULP_PASS** — 232 468 scalar comparisons, **29 differ**, 0 out of envelope, max abs diff **3.64e-12 ms** (max 2 ULP against a per-piece budget of 8–48). Every JSONL field, every velocity, every CC value bit-exact |
| `features_check.py` | **FEATURES_PASS** — 12 708 × 16 feature rows, **0 non-finite**; 50 832 label values, 0 non-finite; DSL training-subset round-trip exact, tokens 26 / 112 / **378** (max, under the 448 cap) |
| imprecision probe | **IMPRECISION_PARTIAL** (§5) |

Two things this pilot measured that are worth carrying forward:

* **The `full`-subset DSL is lossy on real repertoire, in exactly one place.** 218 articulation
  *dates* out of 15 846 encoded scalars come back up to **0.024 ticks** off, because the DSL
  writes dates as decimal beats and a tuplet onset (30 480 ticks = 42.333… beats) is not a
  terminating decimal in beats. The synthetic sampler never met it — its rhythm grid is dyadic
  throughout. It cannot reach training (articulation is a per-note head, not a token) and it is
  0.017 ms at 120 bpm, below every observability floor in CANONICAL; but it means "the DSL is
  lossless" is a statement about dyadic rhythms, and the `full` subset is what MDL and MPM
  export use. `features_check.py` classifies it rather than waiving it.
* **10 rendered velocities exceed 127** (0.079 % of 12 708; max 132.55). This is not new and not
  corpus-specific: CANONICAL A3 caps `absoluteVelocityChange` at ±25 while the dynamics range
  reaches 115, so 140 is reachable in the synthetic set too. meico keeps velocity as a
  continuous float, so nothing is lost *inside* the pipeline, but a MIDI export would clamp and
  the label would stop being recoverable. Filed here rather than fixed, because tightening
  either bound is a CANONICAL change and belongs to whoever owns that document.
