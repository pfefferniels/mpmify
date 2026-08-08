# Bug Report (open)

## 6. `InsertRubato.removeRubatoDistortionFrom`: mixes symbolic and performed positions (InsertRubato.ts:171)

```typescript
const offset = note.date + note.tickDuration
```

`note.date` is the symbolic score position, while `note.tickDuration` is the performed duration in ticks (already rubato-adjusted on line 169). This incorrectly combines two different coordinate systems. Should be either `note.tickDate + note.tickDuration` (both performed) or `note.date + note.duration` (both symbolic).

A TODO comment has been added in the code.

## 7. meico: NaN milliseconds when a rubato frame straddles a tempo transition boundary (found 2026-08-08, ML program Team A/B)

`TempoMap.renderTempoToMap` selects the tempo segment by the **unwarped** GenericMap key
(TempoMap.java:396-404) but evaluates the power curve at the **warped** `date.perf`
(RubatoMap warp applied earlier). If a rubato frame straddles a power-transition boundary,
the warped date can fall outside the selected segment: ratios > 1 are extrapolated as-is,
ratios < 0 produce `Math.pow(negative, exponent)` = **NaN milliseconds** (reproduced: 3/32
notes NaN; also 316 ms model error on 24/2485 notes in the naive re-implementation).
Workaround in the ML sampler: canonical rule R8 forbids tempo instruction dates strictly
inside rubato frames. Fix option: clamp the normalized position into [0,1] or select the
segment by the warped date.
