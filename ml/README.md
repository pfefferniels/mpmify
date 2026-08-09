# ml/ — end-to-end MPM-generation experiments

Prototype for the plan in `../mpm-ml-research.md`: train a transformer to reconstruct MPM
from a score-aligned MIDI performance, using purely synthetic training data (sample a
canonical-form MPM → render it → keep the (performance, MPM) pair). `LOG.md` is the
iteration journal and the thing to read first; `CANONICAL.md` is the normative spec for
what "canonical form" means and why each rule is there.

## Layout

| path | what it is |
|---|---|
| `node/generate_v4.mjs` | the **current** generator (v4). Samples score + MPM, renders through either renderer, writes JSONL. |
| `node/sampler.mjs`, `xml.mjs`, `augmented_msm.mjs`, `java_random.mjs` | its parts: map sampling, MSM/MPM serialization, reading the Java fork's augmented MSM back, and a bit-exact port of `java.util.Random` so both generators can share a seed. |
| `node/verify_v4.mjs` | verification suite: `invariants`, `cross`, `v3proof`, `v3compat`. |
| `java/SampleAndRender.java` | the v3 generator. **Do not delete** — `verify_v4.mjs v3proof` diffs the Node port against it. |
| `java/RenderMpm.java` | batch renderer for the meico fork; the `--renderer java` path and the cross-renderer legs go through it. |
| `python/dsl.py` | the DSL tokenizer/parser, v1 → v4. Vocabulary is **append-only and frozen per version**. |
| `python/perf_chain.py`, `perf_chain_v4.py` | Python ports of meico's rendering chain (v3 single-part, v4 two-part with movement + asynchrony). |
| `python/tempo_math.py`, `dynamics_math.py`, `rubato_math.py`, `movement_math.py`, `asynchrony_math.py` | the per-map math, ported exactly. |
| `python/validate_v4.py` | proves the Python chain reproduces the Java fork bit-for-bit, including a negative-control battery. |
| `python/roundtrip_v4.py` | proves the DSL is lossless: encode → decode → re-render == the labels. |
| `python/dataset.py`, `preprocess.py`, `model.py`, `train.py`, `evaluate.py` | features, packing, model, training, metrics. |
| `python/vienna_adapter.py` | the real-data (Vienna 4x22) path — the sim2real test set. |
| `data/`, `runs/` | gitignored artifacts. `data/defective/` holds knowingly-mislabelled sets kept only as evidence. |

## Generating data (v4)

```sh
cd ml/node
node generate_v4.mjs ../data/train_v4.jsonl 20000 4242 --renderer java
node generate_v4.mjs ../data/val_v4.jsonl    1000 900001 --renderer java
```

`--renderer java` is the default and the only correct choice today. The TypeScript renderer
(espressivo) is reachable with `--renderer espressivo` but has two live parsing defects —
it ignores articulation modifiers (E1) and dynamics `curvature`/`protraction` (E2) — so its
velocities and note ends are wrong wherever those maps are present. `generate_v4.mjs`
documents both under `ESPRESSIVO_DEFECTS` with the state they were measured at.

Other flags worth knowing: `--maps` selects which maps are sampled, `--print-domain` prints
the sampling ranges, `--dump-dir` keeps the `.msm`/`.mpm` inputs the cross-renderer legs
need, `--v3-compat` reproduces `SampleAndRender.java` exactly, and `--with-accentuation`
exists but is **default off** (there is no identifiability argument for accentuation yet —
`CANONICAL.md` §1/H4).

Each record carries its `renderer` and `seed`, so a file says what produced it.

## Verifying it

Five legs, in the order they should be run — the second and third are the same gate on two
configurations:

```sh
cd ml/node
node verify_v4.mjs invariants ../data/pilot_v4.jsonl     # canonical rules hold on the data
node verify_v4.mjs cross ../data/pilot_v4.jsonl ../data/debug_v4 java       # both renderers agree
node verify_v4.mjs cross ../data/pilot_v4_exact.jsonl ../data/debug_v4_exact java   # narrow control
cd ../python
python3 validate_v4.py --cross-java                      # Python chain == Java fork
python3 roundtrip_v4.py ../data/pilot_v4.jsonl           # the DSL loses nothing
```

The `cross` leg compares the two renderers against each other. Its pass verdict is
`CROSS_RENDERER_ULP_PASS`: differences are allowed only inside a *derived* per-piece libm
envelope, never as a logic difference. Since meico-ts fixed E1/E2 (main `da24612`,
2026-08-09) it passes on the **full** map set — 100 pieces, 11708 notes, 19635 CC, every
JSONL field bit-exact — so run it on `pilot_v4.jsonl` and treat a failure as a real
divergence. `pilot_v4_exact.jsonl` (`--maps tempo,rubato,asynchrony,movement`) remains
useful as the narrower control: it is the configuration that stayed green throughout the
E1/E2 period, so a regression there is a different and more serious signal than one that
shows up only with articulation or dynamics present.

`validate_v4.py` is the leg that matters for the Python pipeline: it renders every record
through `perf_chain_v4.py` and requires bit-identical milliseconds, velocities and CC
against the file. `--cross-java` re-renders a sample through the fork so that part 2's
positionMap — which the JSONL does not record — is covered too.

## Training

```sh
cd ml/python
python3 preprocess.py ../data/train_v4.jsonl ../data/train_v4.pt --v4
python3 preprocess.py ../data/val_v4.jsonl   ../data/val_v4.pt   --v4 --eval
python3 train.py 24 v4 v4          # epochs, run name, mode
```

The v4 target is **not** the whole DSL. The decoder is trained on tempo + dynamics + rubato
+ asynchrony (median 183 tokens/piece); articulation and pedal are per-note label arrays
instead, because a movementMap alone costs a median 408 tokens — more than every other map
combined — and a date-keyed articulation label is the wrong representation to begin with
(`CANONICAL.md` §15). `dsl.encode_piece_v4(maps, subset="full")` still encodes all six maps,
and that is what the MDL metric and any MPM export use.

`preprocess.py --v4` **fails loudly** on a piece that exceeds the length caps rather than
dropping it: the pieces that overflow are the long, densely-marked ones, so silently
skipping them shrinks and biases the set at the same time. The cap is `MAX_TGT["v4"] = 448`,
set from 200 pieces across two seeds (median 181, p90 265, p99 339, max 435); it is not a
proof, since the sampler's own worst case is ~770 tokens, so expect to meet the failure
occasionally and raise the cap deliberately rather than filter. `train.py` reads the ceiling
back out of the packed set, so the two cannot drift apart.

## Reproducing v0 (historical)

```sh
cd ml/java
javac -cp "$MEICO/out/production/meico:$MEICO/externals/*" -d out SampleAndRender.java
java  -cp "out:$MEICO/out/production/meico:$MEICO/externals/*" SampleAndRender ../data/train.jsonl 30000 1
java  -cp "out:$MEICO/out/production/meico:$MEICO/externals/*" SampleAndRender ../data/val.jsonl 1000 900001
cd ../python && python3 validate_data.py ../data/train.jsonl && python3 train.py 15 v0
```
