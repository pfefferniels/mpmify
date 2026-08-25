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

The residual is no longer *carried*. It used to be written back onto the aligned notes, each step
subtracting its own share for the next; `src/residual/` computes it instead, from the score, the
recording and the MPM, on demand. A transformer asks for it with its own dimension held out
(`deriveResidual(msm, mpm, { without: ['articulation'] })`) — "what does everything *else*
explain?" — which is the same quantity the subtraction produced, by construction rather than by
bookkeeping.

**If a change loses this, it has failed, however clean the result looks.**

### What a work file is

A reconstruction is saved as two arrays and nothing else (`src/Work.ts`):

```jsonc
{
  "name": "…", "mei": "…", "mpm": "…",
  "provenance": [ { "id": "…", "name": "InsertRubato", "options": { … } } ],
  "segments":   [ { "id": "…", "note": "Hinspielen auf 1",
                    "calls": ["…"], "elements": ["rubato_1440", "tempo_1440"] } ]
}
```

`provenance` is the reconstructible half — `importWork` builds the chain back out of it, and
running that chain over the same MEI produces the same MPM. `segments` is the record of a run:
which calls belong together, why, and the `xml:id`s of the MPM elements they produced.

It used to be a JSON-LD graph in CIDOC-CRM and CRMinf, in which every group of calls was an
`I1_Argumentation` that `J2_concluded_that` an `I2_Belief` with a motivation and a `J5_holds_to_be`
certainty. Nothing read the certainty and nothing read the actor; the ontology bought a vocabulary
for claims mpmify does not make. What it does make is a fit, and a record of which call produced
which element.

---

## 1. Where the line is

espressivo owns **MPM**. mpmify owns **the fitting**, and **the alignment**.

### The alignment is not an MSM, and that is why it is mpmify's

`src/alignment/` holds a score and a recording of it, note by note. espressivo has no name for
that: its `Msm` is a document handle (`createMsm`, `addPart(Element)`, `getParts(): Elements`,
`exportMidi`) with no note type and no note writer, and MSM itself has no way to say "the score
says this and the performance did that" in one place. So `Alignment` is mpmify's, the way the
fitting is — and it is called `Alignment` rather than `MSM` because it is not one, and because
`MSM` and `Msm` would collide the moment the two libraries met.

Every attribute it carries **is** MSM's, though:

| | in ticks | in milliseconds |
|---|---|---|
| the score | `date`, `duration`, `midi.pitch`, `pitchname`, `octave`, `accidentals` | — |
| the recording | — | `milliseconds.date`, `milliseconds.date.end`, `velocity` |

Those three are what `Performance.perform` writes and `readPerformanceData` reads. mpmify used to
carry the recording in `midi.onset` / `midi.duration` / `midi.velocity`, in **seconds** — three
names that appear nowhere in meico's Java source, and a unit every fitter converted away from at
the point of use. There were exactly ten `* 1000` in `src/` and all ten were that conversion.

`Alignment.serialize()` therefore states the alignment as a document espressivo can read straight
back, and `serializeScore()` states only the score half — which is what a residual is measured
against, since a document carrying both is ambiguous about which timing it means.

Concretely, espressivo answers four questions about every instruction, and mpmify asks all four
rather than modelling any of them:

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

### A transformer is handed espressivo's `Mpm`

```ts
protected transform(msm: Alignment, mpm: Mpm) {
    const map = requireMap(mpm, 'tempo', scope)   // espressivo's TempoMap
    map.addTempo({ id, date, bpm, beatLength })
    map.updateTempoAt(index, { bpm: 90 })
}
```

There is no mpmify document class. There was one — `MPM`, wrapping espressivo's `Mpm` — and
underneath it a generic `insertInstruction` with a table dispatching to the eight `add<X>`
methods. That table was the whole of the facade: it existed because `AbstractTransformer` built
its `created` list by intercepting every write, so every write had to funnel. `created` is
**derived** now — `run` fingerprints every instruction before and after `transform` and diffs —
and with nothing to funnel, neither the table nor the class had anything left to do.

Deriving is also more accurate: a transformer that *modifies* an instruction is attributed to it,
where interception saw insertions only. `created` means "answerable for".

### What mpmify adds, and why each is a function rather than a wrapper

Everything below is a free function over `Mpm`, in `src/mpm/`. None of them wraps a write.

| what | why espressivo cannot answer it |
|---|---|
| `requireMap` / `mapOf` / `scopesOf` (`document.ts`) | a `Scope` is mpmify's and the alignment's way of naming a part. Turning one into a `<global>` or numbered `<part>`, then its `<dated>`, then the map, creating each on the way, is four steps no transformer should repeat. What comes back is espressivo's own `TempoMap`, `DynamicsMap`, … with its whole surface. |
| `getInstructions` (`instructions.ts`) | espressivo reads by index and by type; "every `<tempo>` in scope S" is the question mpmify asks. The `READ` table there is the only thing in the whole module that knows one instruction type from another, and it has no write half. |
| `auditInstructions` / `fingerprintInstructions` | what a transformer changed, what it left unnamed, what it wrote as `NaN` — all by looking at the document afterwards. |
| `insertStyle` / `ensureDefaultStyle` (`styles.ts`) | mpmify's one-`<styleDef>`-per-collection convention, and the `<style date="0">` switch without which every `@name.ref` in a map is unresolvable. |
| the definition functions | espressivo has no `Scope`; these resolve one to a `<header>` and its `<styleDef>`. |
| `withoutMaps` | rendering a probe with one dimension held out, which is what the residual is. |
| `unwrap` | espressivo's `mpm/` layer answers `Result`; the def factories are total over what mpmify hands them, so a failure is a caller bug and not a case to branch on. |

### `fillInAt`, the one contract the generic insert was hiding

`src/mpm/fillInAt.ts` fills in the instruction already at a date instead of writing a second one.
Exactly two places need it, and both are **two transformers describing one element**:

- `InsertDynamicsGradient` + `InsertTemporalSpread` — a velocity ramp and a roll, one
  `<ornament>`. Two elements at one date and the renderer applies both.
- `InsertDynamicsInstructions` — each segment's fit lands on the date the previous segment's
  `closeTransition` wrote its closing `<dynamics>` at. Two elements and the closer shadows the
  curve.

The caller names the three espressivo calls it wants, because it knows which map it is holding.
There is no table behind it, and it is a call at the two sites that mean it rather than a
property of every insert — which is what a general merge-on-date made it look like. Both places
broke silently the moment writes went direct, and the structural digest caught them, not a test.

## 2. The one thing mpmify writes that MPM does not define

It has a module of its own that says so, rather than hiding among the real attributes in a schema
table. **Do not move it upstream.** espressivo writes standard MPM and nothing else, and that is
what makes it safe to hand it the whole document.

| what | where | why it is not MPM |
|---|---|---|
| the ornament draft | `src/mpm/ornamentDraft.ts` | seven `ornamentDef` fields parked on an `<ornament>` between the transformers that fit them and the one that moves them into a real def. `<ornament>` is a `memberOf` `att.id`, `att.note.order`, `att.reference.name`, `att.scale`, `att.time.symbolic.date` — and none of the seven. |

The draft stays *on the element* deliberately: `InsertDynamicsGradient` and `InsertTemporalSpread`
each write half of one `<ornament>` at the same date, and the element is the only thing they share.
`StylizeOrnamentation` clears it, so it never reaches a saved document. It survives every insert,
patch and read on the way, because espressivo only ever touches an attribute one of its options
types names.

There used to be two more, and both are gone:

- **`@corresp`**, the link from an element to the call that wrote it. It said the same thing as
  the work file's `segments[].elements`, in a place the ODD has no attribute for. The work file
  says it now.
- **`<appInfo>`** and its `<transformation>` children. `<metadata>` is `author* comment*
  relatedResources?` (`axelberndt/MPM`, `src/specs/metadata.xml`) and nothing else; mpmify wrote
  the element anyway, to record which transformation produced the document. That record is the
  work file's `provenance`, which is where it belongs — a work file, not the MPM. Metadata now
  goes through espressivo's own `Mpm.addMetadata`.

---

## 3. What must not change

- **The order in `Order.ts`**, and the `requires` relations. See §0.
- **The residual chain**: which step consumes seconds, which consumes ticks-off-grid, which
  consumes residual velocity, which consumes duration.
- **The fitting algorithms.** They are the domain, and they are tested against fixtures.
- **`shiftToFirstOnset` semantics** — the roll has ~28 s of lead-in before the first note and
  several steps assume it has been removed.
- **`AbstractTransformer.run`'s refusal of an id-less instruction.** An instruction with no
  `@xml:id` cannot be named in a work file's `segments[].elements`, and has its span silently
  dropped by `deriveSegments`. That happened, and cost nine `<tempo>` elements; nothing failed
  except a span count in one bake fixture.

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
   100.0. `src/mpm/document.ts`'s `unwrap` is mpmify's one place for turning a `Result` into
   a value or a throw.
5. **Comments, processing instructions and CDATA are dropped at parse.** Nothing mpmify writes
   depends on them surviving, but a hand-edited document loses them.
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
  of every round-trip case, attributes sorted, minted uuids canonicalised. Run with
  `MIGRATION_DIGEST=1`. It is a recorder, not an assertion — the point is to diff it across a
  change that is meant to be behaviour-preserving.
- The chain is **deterministic**. `test/determinism.test.ts` folds it twice and compares the
  serialized result. An unstable digest is a regression, not annealing.
