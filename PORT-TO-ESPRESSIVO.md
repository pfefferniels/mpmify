# Porting mpmify to espressivo

A brief for whoever does this work. Everything below was verified against the code on
2026-08-24; where something is inference rather than a reading, it says so.

---

## 0. Read this first: what mpmify is

mpmify is **not** a bag of MPM generators. It is a **reduction pipeline**, and its value
is in the order and the residual chain, not in any single algorithm.

The idea: an MPM is the transformation from a score MSM into a performed MSM. Rendering
goes score → performance. mpmify goes the other way — it *has* the performance (a
score-to-audio alignment) and solves for the MPM. Each transformer explains one slice of
the deviation between score and recording, writes the MPM instruction that accounts for
it, and **writes the remainder back into the MSM** for the next step. What survives to the
end is imprecision.

The mechanism is in the type itself (`src/msm/index.ts:13`):

```ts
/** Temporary attributes used and manipulated in the process of approximation. */
type TemporaryAttributes = Partial<{
    tickDate: number
    tickDuration: number
    absoluteVelocityChange: number
    source: string
}>
```

Two places show the reduction outright:

- `dynamics/InsertDynamicsInstructions.ts:89` —
  `note.absoluteVelocityChange = note["midi.velocity"] - should`, where `should` is what
  the dynamics curve predicts. Recorded minus explained.
- `accentuation/InsertMetricalAccentuation.ts:244` — fits its pattern to the *average of
  that residual* per beat, then `note.absoluteVelocityChange -= velocityChange`. It
  subtracts its own share and passes the rest on.

**The order in `Order.ts` is that reduction, and it is not permutable.** Three places
where the reason is visible in the code:

- `InsertTemporalSpread` runs *before* tempo and ends by giving every note of a rolled
  chord the same collapsed onset (`ornamentation/InsertTemporalSpread.ts:203-206`). A
  rolled chord has no single onset to measure tempo from; explain the roll, collapse it,
  and only then is the onset clean enough to read a tempo off.
- `TranslatePhyiscalTimeToTicks` is the hinge. It reads the tempo *already written into
  the MPM* to convert each physical onset into `tickDate`. Before it, "how late is this
  note" is in seconds; after it, in ticks off the score grid — the only domain `<rubato>`
  can speak. Rubato cannot precede tempo, because a tick has no length yet.
- Accentuation after dynamics, for the same reason one dimension over: a metrical pattern
  is invisible underneath a trend that has not yet taken its share.

**If the port loses this, it has failed, however clean the result looks.**

---

## 1. Why port

`mpm-ts` is being retired. It is the MPM object model mpmify writes through, and it has a
defect that matters: measured differentially against espressivo over
`mpm-desk/public/performance.mpm`, **mpm-ts silently returned 0 of the 51
`<accentuationPattern>` elements** — no error, ever. Across 215 note dates × 8 instruction
types the two readers agreed 1609 times and differed 111, every difference that bug.

espressivo (`~/Projects/meico-ts`, npm name `espressivo`) is a TypeScript port of Java
meico, held to byte-equivalence against it by 145 test files. It is already the single
music dependency of `mpm-desk`'s viewer, and mpmify's own `ml/` sub-project already uses
it (`ml/node/package.json`: *"espressivo-backed"*). Only `src/` is still on mpm-ts.

---

## 2. Scope

**Verified:** 26 files import from `mpm-ts`; 61 call sites go through the `MPM` handle.

| call | count |
|---|---|
| `mpm.getInstructions` | 19 |
| `mpm.insertInstruction` | 14 |
| `mpm.insertDefinition` | 8 |
| `mpm.insertStyle` | 5 |
| `mpm.removeInstruction` | 4 |
| `mpm.getDefinition` | 4 |
| `mpm.insertInstructions` | 3 |
| `mpm.setMetadata`, `mpm.removeDefinition`, `mpm.insertDefinitions`, `mpm.getStyles` | 1 each |

Imported types, by frequency: `MPM` (22), `Scope` (6), `Ornament` (4), `Tempo` (3),
`ArticulationDef` (3), `Articulation` (3), then singles.

For scale: `src/transformers/` is 4,644 lines, of which **~350 is the replay machinery**
(`Transformer.ts` 196, `TransformerRegistry.ts` 80, `Order.ts` 72) and **~4,300 is
domain** — `ApproximateLogarithmicTempo` alone is 1,012, `TranslatePhysicalTimeToTicks`
307, `InsertMetricalAccentuation` 290, `StylizeOrnamentation` 237, `Approximation` 205.
The port touches the thin layer under all of it, not the algorithms.

---

## 3. The writing layer: mpm-ts → espressivo

espressivo's MPM model is a mutable XOM tree reached through classes, all exported from
the package root. The shape is `Mpm → Performance → Global | Part → Header | Dated → maps`.

### Construction

```ts
import { Mpm, Performance, Global, Dated, TempoMap } from 'espressivo'

const mpm = new Mpm()                                   // empty <mpm>, MPM namespace
const performance = Performance.fromName('...', 720)    // Result<Performance, MpmParseError>
mpm.addPerformance(performance)
const dated = performance.getGlobal().getDated()
const tempoMap = dated.addMapByType('tempoMap')         // or addMap(TempoMap.createTempoMap())
```

### Instruction adders

Each map has a typed adder returning the insertion index. Verified signatures:

```ts
TempoMap.addTempo({ date, bpm, transitionTo?, meanTempoAt?, beatLength, id? }): number
DynamicsMap.addDynamics({ date, volume, transitionTo?, curvature?, protraction?,
                          subNoteDynamics?, id? }): number
RubatoMap.addRubato({ date, nameRef?, id?, ...RubatoDeclaration }): number
ArticulationMap.addArticulation({ date, nameRef, noteid?, absoluteDuration?,
                                  absoluteDurationChange?, relativeDuration?, id? }): number
MovementMap.addMovement({ date, position?, transitionTo?, curvature?, protraction?,
                          controller?, id? }): number
OrnamentationMap.addOrnamentV3({ date, nameRef, scale?, noteOrder?, noteid?,
                                 repetitions? }): number
MetricalAccentuationMap.addAccentuationPattern(...): number
AsynchronyMap.addAsynchrony(date, millisecondsOffset): number
ImprecisionMap.addDistribution{Uniform,Gaussian,Triangular,...}(...): number
```

Plus the generic escape hatch on `GenericMap`: `addElement(xml: Element)`,
`removeElementAt(index)`, `removeElement(xml)`, `addStyleSwitch(date, styleName, id?)`,
`updateAttributeValues(name, mappings)`, `sort()`.

### Mapping the 61 call sites

| mpm-ts | espressivo |
|---|---|
| `insertInstruction(instr, scope)` | `dated.getMapOfKind(KIND).add<Type>({...})` |
| `insertInstructions(list, scope)` | loop the above |
| `removeInstruction(instr)` | `map.removeElement(xml)` / `removeElementAt(index)` |
| `getInstructions<T>(type, scope)` | iterate the map's elements, or use `get*DataOf(i)` for resolved values |
| `insertDefinition(def, scope)` | `header.addStyleDef(...)`, then `Style.addDef(...)` |
| `getDefinition(type, name)` | `style.getDef(name)` |
| `insertStyle(style, type, scope)` | `map.addStyleSwitch(date, styleName, id?)` |
| `setMetadata(...)` | `mpm.addMetadata(author, comment, relatedResources)` |

**There is no typed *edit*.** To change an attribute you mutate the live element:
`map.getElementByID('t1').getAttribute('bpm').setValue('75')`. If you change `@date` you
must call `map.sort()` yourself.

### `Scope`

mpm-ts's `Scope = number | 'global'` becomes a choice of environment object:
`performance.getGlobal()` or `performance.getPart(n)`. Keep a small adapter rather than
threading the change through all 26 files.

---

## 4. The decision worth making while you are in there

**Recommended, not required.** The port could be a like-for-like swap. It is worth
considering a smaller interface change at the same time, because the reason mpmify
accumulates residuals by mutation no longer holds.

`AbstractTransformer.run(msm, mpm)` mutates both: it writes an instruction and writes the
remainder back onto the notes. It does that because each transformer can only see its own
step — there was never a way to ask *"what does the whole MPM so far predict?"*

espressivo can answer that. `performMsmToData({ msm, mpm })` returns `PerformanceData`
with, per note, a `PerformedNote { id, pitch, date, duration, velocity, milliseconds:
{ date, end } }` — the symbolic position and the performed one, for the entire current
MPM. So the residual becomes a **pure function of (score, recording, MPM)**, recomputed,
rather than accumulated in mutable note attributes:

```
residual.timing(note)   = recorded.onset·1000 − rendered.milliseconds.date
residual.duration(note) = recorded.duration·1000 − (rendered.milliseconds.end − .date)
residual.velocity(note) = recorded.velocity − rendered.velocity
```

Why it matters beyond tidiness: an accumulated residual and an undo stack cannot be
reconciled — undoing step 4 leaves steps 5–8's mutations in the MSM. A derived one is free.
It also makes *refitting* possible, which the reduction needs: revise the tempo and every
downstream fit was made against a residual that no longer exists.

If this change is made, a transformer's shape becomes roughly:

```ts
fit(residual: Residual, options: O): MpmElement[]      // pure, no MSM mutation
```

and the order in `Order.ts` stops being a data-flow constraint and becomes what it always
meant: the order a human should work in.

**Note the one thing to check before committing to this**: `TranslatePhyiscalTimeToTicks`
exists to express the timing residual in *ticks* rather than milliseconds. Deriving it
means building the tick↔ms table from the **rendered** performance (each `PerformedNote`
gives `date` and `milliseconds.date`), not from the recording. That is a different table
from the one `mpm-desk/src/hooks/useTimeMapping.ts` builds today, and getting it wrong
silently moves every rubato.

---

## 5. What must not change

- **The order in `Order.ts`**, and the `requires` relations. See §0.
- **The residual chain**: which step consumes seconds, which consumes ticks-off-grid,
  which consumes residual velocity, which consumes duration. If §4's change is made the
  *storage* moves, but every consumer must still see the same quantity it sees today.
- **The fitting algorithms.** They are the domain, and they are tested against fixtures.
- **`shiftToFirstOnset` semantics** — the roll has ~28 s of lead-in before the first note
  and several steps assume it has been removed.

---

## 6. Traps, all verified

1. **espressivo's parse repairs.** `new Mpm(text)` is not a reader; it normalises. It adds
   `pulsesPerQuarter` and an empty `<global>`, gives `rubatoDef` an
   `intensity="1" lateStart="0" earlyEnd="1"`, gives `accentuationPatternDef` a
   `length="4"`, **re-sorts every map by date**, and **deletes duplicate maps**. If you
   round-trip through it you get a different document. For a non-repairing read there is
   `parseMpmRoot` / `canonicalMpm`.
2. **`GenericMap` keeps its data twice** — a sorted `(date, element)` array for lookups and
   the XML children for serialization. Its own comment: *"Every mutator here updates both,
   in that order. Writing to one alone corrupts the map."* Never touch the XML directly.
3. **Empty elements serialize as `<x />`, with the space.** `Element.toXML` is byte-frozen
   against Java meico — all 1,435 empty elements in its 72 reference files use that
   spelling. mpm-ts wrote `<x></x>`, so mpmify's existing golden files will differ by that
   alone. Diff structurally, not textually.
4. **The error model is Java's.** The `mpm/` layer logs to console and returns `null`
   rather than throwing; some methods return `Result<T, E>`, some return `-1`. An
   unresolvable `bpm="Allegro"` prints an error and silently resolves to 100.0. Wrap it.
5. **Comments, processing instructions and CDATA are dropped at parse** — `Element.wrap`
   keeps only element and text nodes.
6. **`resolveTempo` and `resolveRubato` take a style class**; `resolveDynamics` and
   `resolveMovement` are pure over plain records. If you need the first two over plain
   data, that is a ~40-line additive overload upstream in espressivo (accept a
   `(name: string) => number | undefined` lookup) and worth doing there rather than
   working around here.
7. **`Performance.perform` does not mutate the MPM** — verified by snapshotting
   `writeMpm()` either side of a render. It reads MPM and writes into an `msm.clone()`.
   So rendering to derive a residual is safe to do as often as you like (~31 ms for a
   2000-note piece).

---

## 7. Verification

- `test/` has 7 suites — `TransformerRegistry`, tempo ×2, dynamics, articulation,
  ornamentation ×2 — plus a fixture corpus of MEI/MIDI/MSM/MPM pairs. They must stay green.
- **The real check is differential**: run the full pipeline over
  `mpm-desk/public/transcription.mei` + `data/info.json` before and after the port, and
  compare the produced MPM *structurally* (element counts per type, attribute values per
  `xml:id`), not byte-wise — see trap 3. The corpus is 135 argumentations / 460 calls
  producing 574 instruction elements, so a regression in any element type is visible.
- Be aware the pipeline is **not deterministic**: `Approximation` and
  `ApproximateLogarithmicTempo` anneal with `Math.random()`, and only
  `accentuationPattern` grouping is expected to move between runs
  (`MergeMetricalAccentuations` folds two patterns together on annealed velocity fits).
  A difference in any *other* element type is a regression, not annealing.

---

## 8. Out of scope

- The argumentation / CRMinf layer and `Work.ts`'s JSON-LD export. `mpm-desk` has moved to
  a plainer segment model (`{ id, elements, note }`); whether mpmify keeps its export is a
  separate decision.
- `ml/`. It already talks to espressivo through an absolute dist path and is unaffected.
- `mpm-ts` itself. Once `src/` no longer imports it, it can be retired separately.
