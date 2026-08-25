# mpmify and espressivo

What the relationship is, what mpmify still owns, and what must not change.

This replaces `PORT-TO-ESPRESSIVO.md`, which was a brief for work that is now done. Everything
below was verified against the code on 2026-08-25.

---

## 0. Read this first: what mpmify is

mpmify is **not** a bag of MPM generators. It is a **reduction pipeline**, and its value is in
the order and the residual chain, not in any single algorithm.

The idea: an MPM is the transformation from a score MSM into a performed MSM. Rendering goes
score → performance. mpmify goes the other way — it *has* the performance (a score-to-audio
alignment) and solves for the MPM. Each transformer explains one slice of the deviation between
score and recording and writes the MPM instruction that accounts for it.

**The order in `Order.ts` is that reduction, and it is not permutable.** Three places where the
reason is visible in the code:

- `InsertTemporalSpread` runs *before* tempo and ends by giving every note of a rolled chord the
  same collapsed onset. A rolled chord has no single onset to measure tempo from; explain the
  roll, collapse it, and only then is the onset clean enough to read a tempo off.
- `TranslatePhyiscalTimeToTicks` is the hinge. It reads the tempo *already written into the MPM*
  to convert each physical onset into a tick date. Before it, "how late is this note" is in
  seconds; after it, in ticks off the score grid — the only domain `<rubato>` can speak.
- Accentuation after dynamics, for the same reason one dimension over: a metrical pattern is
  invisible underneath a trend that has not yet taken its share.

The residual is no longer *carried*. It used to be written back onto the MSM notes, each step
subtracting its own share for the next; `src/residual/` computes it instead, from the score, the
recording and the MPM, on demand. A transformer asks for it with its own dimension held out
(`deriveResidual(msm, mpm, { without: ['articulation'] })`) — "what does everything *else*
explain?" — which is the same quantity the subtraction produced, by construction rather than by
bookkeeping.

**If a change loses this, it has failed, however clean the result looks.**

---

## 1. Where the line is

espressivo owns **MPM**. mpmify owns **the fitting**.

Concretely, espressivo answers three questions about every instruction, and mpmify asks all
three rather than modelling any of them:

```
add<X>(Add<X>Options)        write a document
get<X>DataOf(index)          read it as the RENDERER sees it   — names resolved, defaults filled
get<X>OptionsOf(index)       read it as the DOCUMENT says it   — nothing resolved, nothing filled
update<X>At(index, patch)    change one thing about it
```

`Add<X>Options` **is** mpmify's instruction record; `src/mpm/types.ts` only maps mpmify's type
names onto it. The two name tables there are `satisfies`-checked against espressivo's own
`MapKind` and `StyleKind`, so a name it renames stops compiling here rather than failing at
runtime. Definitions are espressivo's classes, not records.

`get<X>OptionsOf` is the one a fitter needs and the one that did not exist: `get<X>DataOf`
cannot tell `meanTempoAt="0.5"` from an absent `@meanTempoAt`, resolves an unresolvable `@bpm`
to a hardcoded 100.0, and has no inverse.

### Reads are snapshots

`getInstructions` hands back what the document says when asked. It is not a live view — an
earlier version proxied every property access onto the element, which made `tempo.bpm = 72` edit
the document and a value that looks like data silently not be. Changing an instruction is
`mpm.updateInstruction(instruction, patch)`, which says so at the call site and returns a fresh
snapshot; the one passed in is stale.

---

## 2. The three things mpmify writes that MPM does not define

Each has a module of its own that says so, rather than hiding among the real attributes in a
schema table. **Do not move any of them upstream.** espressivo writes standard MPM and nothing
else, and that is what makes it safe to hand it the whole document.

| what | where | why it is not MPM |
|---|---|---|
| `@corresp` | `src/mpm/corresp.ts` | the argumentation link. Appears nowhere in the ODD. |
| the ornament draft | `src/mpm/ornamentDraft.ts` | seven `ornamentDef` fields parked on an `<ornament>` between the transformers that fit them and the one that moves them into a real def. `<ornament>` is a `memberOf` `att.id`, `att.note.order`, `att.reference.name`, `att.scale`, `att.time.symbolic.date` — and none of the seven. |
| `<appInfo>` | `src/mpm/MPM.ts` | `<metadata>` is `author* comment* relatedResources?` (`axelberndt/MPM`, `src/specs/metadata.xml`). mpmify writes it anyway, because the transformation record is what a work file is for. |

The draft stays *on the element* deliberately: `InsertDynamicsGradient` and
`InsertTemporalSpread` each write half of one `<ornament>` at the same date, and
`insertInstruction`'s merge onto one element is the only thing they share.

All three survive every insert, patch and read, because espressivo only ever touches an
attribute one of its options types names.

---

## 3. What must not change

- **The order in `Order.ts`**, and the `requires` relations. See §0.
- **The residual chain**: which step consumes seconds, which consumes ticks-off-grid, which
  consumes residual velocity, which consumes duration.
- **The fitting algorithms.** They are the domain, and they are tested against fixtures.
- **`shiftToFirstOnset` semantics** — the roll has ~28 s of lead-in before the first note and
  several steps assume it has been removed.
- **`MPMRecording`'s refusal of an id-less instruction.** An instruction with no `@xml:id` gets
  no `@corresp`, cannot be named in a work file, and has its span silently dropped by
  `deriveSegments`. That happened, and cost nine `<tempo>` elements; nothing failed except a
  span count in one bake fixture.

---

## 4. Traps, all verified

1. **espressivo's parse repairs.** `new Mpm(text)` is not a reader; it normalises. It adds
   `pulsesPerQuarter` and an empty `<global>`, gives `rubatoDef` an
   `intensity="1" lateStart="0" earlyEnd="1"`, gives `accentuationPatternDef` a `length="4"`,
   **re-sorts every map by date**, and **deletes duplicate maps**. A round trip through it is
   normalising, not faithful. For a non-repairing read there is `parseMpmRoot` / `canonicalMpm`.
2. **`GenericMap` keeps its data twice** — a sorted `(date, element)` array for lookups and the
   XML children for serialization. Never touch the XML directly. In particular, writing `@date`
   through an element does not re-key the map; `update<X>At` calls `sort()` for you, which is
   the only thing that re-reads the keys.
3. **Empty elements serialize as `<x />`, with the space.** `Element.toXML` is byte-frozen
   against Java meico. Diff structurally, not textually.
4. **The error model is Java's.** The `mpm/` layer logs to console and returns `null` rather
   than throwing; an unresolvable `bpm="Allegro"` prints an error and silently resolves to
   100.0. `src/mpm/index.ts`'s `definitionOf` is mpmify's one place for turning a `Result` into
   a value or a throw.
5. **Comments, processing instructions and CDATA are dropped at parse.** `appInfo`'s `cdata`
   therefore becomes ordinary text content on the way out.
6. **`resolveTempo` and `resolveRubato` take a style class**; `resolveDynamics` and
   `resolveMovement` are pure over plain records. If you need the first two over plain data,
   that is a ~40-line additive overload upstream in espressivo (accept a
   `(name: string) => number | undefined` lookup) and worth doing there rather than working
   around here.
7. **`Performance.perform` does not mutate the MPM.** It reads MPM and writes into an
   `msm.clone()`, so rendering to derive a residual is safe to do as often as you like
   (~31 ms for a 2000-note piece).
8. **espressivo omits an attribute at its default.** `<temporalSpread>` writes `time.unit` only
   when milliseconds and `noteoff.shift` only when true or monophonic; `<ornament>` always
   writes `@scale`, at the spec's own default of `0.0`. Same documents, different bytes.

---

## 5. Verification

- `npx vitest`. The accuracy suite is `test/roundtrip/`: its bounds are *recorded measurements*
  with a note naming the gap — tightening one is what "fixed" means, loosening one needs a
  stated reason. It compares in **performance space**, not MPM space, because MPM to performance
  is many-to-one: the chain is entitled to explain the same performance differently than the
  truth did, but not to render differently.
- `scripts/mpm-digest.test.ts` records what the chain writes, structurally: one line per element
  of every round-trip case, attributes sorted, `corresp` uuids canonicalised. Run with
  `MIGRATION_DIGEST=1`. It is a recorder, not an assertion — the point is to diff it across a
  change that is meant to be behaviour-preserving.
- The chain is **deterministic**. `test/determinism.test.ts` folds it twice and compares the
  serialized result. An unstable digest is a regression, not annealing.
