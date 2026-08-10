# interpres — production system design (v1.0)

*From doability study to system. The study (v0–v4, `LOG.md`) proved: a hybrid
transformer learns canonical MPM from purely synthetic renders — articulation F1 1.00
via per-note heads, asynchrony 6× under baseline via conditioning features, render
error −83% vs. baseline with truthful metrics. This document is the architecture of
the real system built on that verdict.*

**Domain (per Niels, 2026-08-10): expressive piano performance of classical repertoire
(baroque / classical / romantic).** Everything below is specialized to it.

## 1. What the system is

Input: a score-aligned piano performance (score + performed MIDI + note alignment).
Output: a complete, canonical, **real MPM document** — the performance *interpreted*:
tempo curves, dynamics, rubato, articulation, asynchrony, pedalling, ornament
realization — plus a rendered round-trip proof of fidelity and an MDL account of the
explanation's economy.

## 2. Architecture (four subsystems)

### 2.1 corpus — real repertoire, synthetic interpretations
- **Scores**: era-tagged real classical piano repertoire (KernScores, PDMX
  no_license_conflict subset, OpenScore) → MEI (Verovio pip ≥6.1, never the CLI) →
  MSM. Pilot findings from the study apply (8va double-shift fix, accidental-carry,
  tolerance joins).
- **Interpretations**: era-conditioned samplers over the canonical form
  (CANONICAL.md; era priors: baroque = terraced dynamics, inégalité-style rubato,
  dense ornamentation, little pedal; classical = articulation-forward, moderate
  rubato; romantic = deep rubato/tempo arcs, half-pedalling, asynchrony/melody-lead).
  Priors start hand-ranged, get fitted from real corpora (mpmify-on-nASAP) in v1.1.
- **Rendering**: espressivo T13 facade (E1/E2 fixed; single renderer per corpus);
  Java fork retained as cross-check gate on samples.
- **Robustness**: MLign robustness layer (performer errors, restarts) behind flags;
  ornament expansion (their v3 module) with provenance labels.
- **Real data**: Vienna 4x22 (eval), nASAP via the adapter pattern (fine-tune later).

### 2.2 model — the hybrid, scaled
- Encoder over per-note features (the validated conditioning-feature set — the
  study's central law: every map learns when its signal is a feature) + per-note
  heads (articulation, pedal state, ornament membership in v1.1) + DSL decoder for
  segment maps (tempo, dynamics, rubato, asynchrony; movement reconstruction pass
  from pedal states).
- Custom SDPA blocks (not nn.Transformer) — GPU-efficient, MPS-safe.
- Scale per the study's sizing: start d512 / 6+6 / ~40M; epochs and params are NOT
  economized (H100: 96 epochs ≈ 20 min at 4M; budget accordingly).
- Config-driven (single YAML/JSON per run, stored in the checkpoint and the log).

### 2.3 training — cluster-native
- All training on bwUniCluster via the standing cluster agent (sbatch, gpu_h100).
- Port gates: 2–3 epoch curve comparisons. Multi-seed for any claimed comparison.
- Every run: fresh name, config-guarded resume, truthful evaluator only.

### 2.4 evaluation + demonstration
- The three-level suite (render-space primary; curve-space; instruction-space
  diagnostic) + MDL ratios + head metrics + Vienna sim2real probe as standing
  benchmark.
- **Demonstration artifacts** (recurring deliverable to Niels): input→output
  showcases — score excerpt, performed notes, emitted MPM (XML), per-map
  decomposition, render-back overlay, per-era examples; published as claude.ai
  artifacts and committed under `ml/demos/`.

## 3. Delivery cadence
- GitHub push at every milestone (Niels' directive; repo is public — no data/ or
  secrets in tree).
- Journal (`LOG.md`) remains the program memory; SYSTEM.md the architecture truth.

## 4. Roadmap
- **v1.0**: subsystems 2.1–2.4 on tempo/dynamics/rubato/asynchrony/articulation/
  pedal-state, real-repertoire corpus, scaled model, Vienna benchmark, demo pipeline.
- **v1.1**: ornaments (espressivo v3 module + provenance labels), imprecision maps
  (seeded, distribution-parameter targets), movementMap reconstruction, era-fitted
  priors, nASAP fine-tune.
- **v1.2**: styleDefs as MDL compression; expression-transform augmentation
  (exaggerate/spotlight); listening-test protocol.
