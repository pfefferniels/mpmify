# The round trip

Every other test in this repo checks a transformer against what its author expected it to write.
That is why the 2026-08 audit found four criticals behind 78 green tests: all four produced an
MPM that was well-formed, internally plausible and passed every one of them, and were only
visible once the document was **rendered** and the render compared against the performance it
had been fitted to.

That comparison is what lives here.

```
score MSM + truth MPM  ──espressivo──▶  performance P
score MSM + P          ──chain──────▶   fitted MPM
score MSM + fitted MPM ──espressivo──▶  performance P′
                                        assert P′ ≈ P
```

## Why the comparison is in performance space

MPM → performance is many-to-one. A note's velocity can come from `<dynamics>`, from an
articulation's `relativeVelocity`, or from a metrical accentuation; its timing from tempo,
rubato, asynchrony or imprecision. So `fitted MPM ≈ truth MPM` is **not** the property to
assert — the chain is entitled to explain the same performance differently than the truth did.
What it is not entitled to do is render differently.

Parameter-level comparison still earns its place, but only where a case is built to be
*identifiable*: one aspect, exactly representable, segmentation handed in. That is tier 1, and
it is diagnostic — it says *which* fitter is wrong instead of "the chain is off".

## Why the chain is derived, not chosen

`chainFor` in `harness.ts` builds the transformer list mechanically from the same spec that
produced the truth, and orders it with `compareTransformers` — the registry's own order.

Hand-picking a chain per case is how a synthetic suite quietly starts measuring the person who
wrote it: given freedom over which transformers run and over what windows, almost any fit can be
made to look good. Deriving both sides from one spec removes that freedom. It also means a case
is a statement about the *pipeline*, not about a particular invocation of it.

## The tiers

| File | What it holds the chain to | What it catches |
|---|---|---|
| `tier0-invariants.test.ts` | the structural checks themselves | a check that has silently stopped working |
| `tier1-parameters.test.ts` | fitted MPM parameters vs. the truth's | *which* fitter is wrong |
| `tier2-render.test.ts` | one aspect, boundaries given, rendered back | renderer-semantics bugs |
| `tier3-endtoend.test.ts` | several aspects, boundaries sometimes withheld | interaction bugs |

Tier 0 is not only its own file: `expectCase` runs `assertWellFormed` on **every** fitted MPM in
tiers 2 and 3. Those checks cost one parse, need no ground truth, and between them cover a
surprising share of the audit — duplicate `xml:id` (#30), `NaN` in an attribute (#44, #45), a
`@name.ref` that resolves to nothing (#28), a `transition.to` with no successor (#24).

## Two ways a synthetic suite lies, and what stops them here

**An inert truth.** A truth MPM the renderer ignores — a dangling `@name.ref`, an unclosed
transition — renders as the bare score. The chain then fits the bare score, the round trip is
perfect, and the case tests nothing. `expectCase` renders each score under an empty MPM first
and requires the truth to differ from it.

**A hand-tuned chain.** Addressed by deriving the chain from the spec, above.

## Bounds

Every case's truth *is* an MPM document, so it is exactly representable and a correct chain
would round-trip it to zero. **Whatever a bound admits above zero is a measured gap in mpmify**,
and the case's `note` says what causes it. Tightening a bound is what "fixed" means for the
issue it names; loosening one without a reason is the regression this directory exists to catch.

The bounds carry roughly 25–50% headroom over the measured value. Both fitters anneal, and
`src/utils/random.ts` seeds them, so the numbers are stable run to run — the headroom is for
platforms whose floating point sends a chaotic search down a different path, not for drift.

To re-record after a change:

```sh
npm run test:roundtrip:report
```

## Files

| File | Role |
|---|---|
| `score.ts` | Score MSMs carrying no performance data — everything expressive must come from the MPM |
| `truth.ts` | The ground-truth MPM, as literal XML |
| `harness.ts` | The round trip, the derived chain, and the comparison |
| `invariants.ts` | The structural checks |
| `expectations.ts` | What every render-tier case asserts |
| `cases.ts` | The coverage matrix and its recorded bounds |
| `report.test.ts` | Opt-in: print what every case currently measures |

`truth.ts` deliberately does **not** use mpmify's own `MPM` class. If the truth went through the
same serializer as the fit, a bug in that serializer would corrupt both sides equally and the
round trip would pass on wrong output. The only code the truth path shares with the code under
test is espressivo's renderer — which is the point: the renderer is the arbiter of what an MPM
document means, and the fit is being measured against that meaning.

## What is not covered yet

- **Ornamentation** (`InsertTemporalSpread`, `InsertDynamicsGradient`, `StylizeOrnamentation`)
  and **pedalling** (`InsertPedal`, `movementMap`). Both are renderable, so both fit this
  harness; neither has a case.
- **Asynchrony.** `InsertAsynchrony` assumes a two-part score and is not registered (#31, #45).
- **Multi-part scores.** `MSM.serialize` writes exactly two `<part>` elements (#34), so
  `buildScore` refuses more than two separate parts rather than silently dropping them.
- **Real performance data.** Every case here is synthetic, which is what makes the ground truth
  exact. #51 asks for an in-repo aligned MEI as well; that measures something different — how
  the chain does on a performance no MPM produced — and does not replace this.
