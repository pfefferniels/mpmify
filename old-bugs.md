# Bugs found while porting mpmify from mpm-ts to espressivo

Found on 2026-08-24, while replacing the MPM object model. Everything here was in the code
before the port; nothing was introduced by it. Each entry says what was wrong, how it showed,
and what was done.

The corpus referred to throughout is the one §7 of `PORT-TO-ESPRESSIVO.md` names —
`mpm-desk/public/transcription.mei` + `info.json`, 494 transformer calls over 136
argumentations producing 574 attributed instruction elements. The pipeline anneals, so it
was run with `Math.random` and `crypto.getRandomValues` seeded; every claim below about "before" and
"after" is a diff of two such runs.

`bugs.md` is the older, still-open log and is untouched. Its #6 (`InsertRubato` mixing
symbolic and performed positions) is a real mpmify bug and is still open — it changes what the
fitting *means*, which is out of scope for a port.

---

## Fixed

### 1. The fitting window was written into the document

`approximateDynamics` returns a `DynamicsWithEndDate`, and `fitSegments` a
`TempoWithEndDate`. `endDate` is the span the curve was fitted over — where the transformer
stopped looking — and both were handed straight to `insertInstruction`. So every `<dynamics>`
and every `<tempo>` mpmify wrote carried an `endDate` attribute that MPM does not define:

```xml
<dynamics date="10800" endDate="12240" volume="37" transition.to="42" … />
```

121 of the corpus's elements had one. A reader that validates rejects the document; meico
ignores the attribute, so the effect was silent.

Fixed in `InsertDynamicsInstructions.transform` and `ApproximateLogarithmicTempo.transform`,
which now drop the field before inserting. `mpm/schema.ts` is the backstop: an attribute no
schema row names is not written.

**Left open**, because it is a modelling question rather than a slip: the fit and the render
disagree about the span. `approximateDynamics` fits over the points it was given, while
`InsertDynamicsInstructions.setRelativeVolume` evaluates the curve over `[date, next date or
msm.end)` — which is what a renderer does. Where the two differ, the residual
`absoluteVelocityChange` that `InsertMetricalAccentuation` then consumes is measured against a
curve that was never fitted. Storing `endDate` was how the mismatch was being papered over.
Fixing it properly means changing the fitting, which §5 of the port brief puts off limits.

**Closed on 2026-08-25** by issue #24, from the other side. The fit now writes the instruction
that *ends* its span — which it had to, because an open `transition.to` renders as a constant —
and that closing instruction is what `setRelativeVolume` reads the span off. Fit and render
agree because the document says where the curve stops, not because the fitting changed.

### 2. A merged instruction lost its attribution

`MPMRecording` wrapped `insertInstruction` and recorded `args[0]["xml:id"]` — the id of the
record handed *in*. But `insertInstruction` merges: an instruction at the same date and
`@noteid` as an existing one is written into that one, and the incoming record's `xml:id` is
discarded. The id that got recorded therefore named nothing.

This is not a corner case; it is the mechanism by which `InsertDynamicsGradient` and
`InsertTemporalSpread` describe one `<ornament>` between them. Whichever ran second had its
`created` entry point at an element that does not exist, so its argumentation never reached the
`@corresp` of the element it had helped write, and `deriveSegments` dropped the span.

Measured on the corpus: **86 stale ids, 85 elements missing a second argumentation.** After
the fix, `droppedElements` is 0 and those 85 elements carry both. It also restores what the
argumentation layer says: the one `InsertDynamicsGradient` call that runs over the whole piece
now names the 88 `<ornament>` elements it shaped, where before it named the single one it
happened to create outright.

`MPMRecording` now records the id of the instruction that was actually written, which the new
`insertInstruction` returns.

### 3. A `<style>` switch was appended to the map instead of placed at its date

mpm-ts's `insertStyle` did `map.push(style)`. Instruction inserts are date-ordered, style
switches were not, so a style switch ended up wherever the map happened to end.

The style in force at an instruction is found by scanning *backwards* from it
(`GenericMap.findStyleSwitchAt`, and Java meico's `getStyleAt` before it). A switch at the end
of the map therefore governs nothing. In the corpus the `ornamentationMap`'s switch sat at
index 100 of 101 — so all 100 `<ornament name.ref="def_…">` resolved to no def, and every
`ornamentDef` in the header, 77 of them, was unreachable. The `metricalAccentuationMap`'s sat
at index 1, which cost it the first `<accentuationPattern>`.

`MPM.insertStyle` now goes through espressivo's `addStyleSwitch`, which inserts *before*
everything else at its date. Both maps now carry their switch at index 0.

### 4. `InsertArticulation` never put its definitions in scope

It writes an `articulationDef` into the header and `<articulation name.ref="…">` into the map,
but never the `<style>` switch that connects them. Only `StylizeArticulation` and
`MakeDefaultArticulation` emitted one, and a chain that runs neither — which the corpus's does
not — produced 26 definitions no renderer could reach and 47 articulations that resolved to
nothing.

`InsertArticulation.transform` now emits the switch when the map has none, the way
`InsertMetricalAccentuation` already did. The four places that write a switch now share the
`DEFAULT_STYLE_NAME` constant with the code that creates the `<styleDef>` it names; the two had
to agree and previously agreed only by repetition of a string literal.

### 5. `CombineAdjacentRubatos` could loop forever

```ts
let ref = rubatos[0]
while (ref) {
    for (let date = ref.date + ref.frameLength; date < msm.lastDate(); date += ref.frameLength) {
        …
        ref = rubatos.find(r => r.date > date)   // the only place `ref` advances
        break
    }
}
```

`ref` advanced only from inside the `for`. When the `for`'s condition was false at entry —
`ref` is a rubato whose next frame starts at or after the last note, which is the ordinary
shape of the last frame in a piece — the body never ran, `ref` never changed, and the `while`
spun. Reproduced with three rubatos over five notes; it hangs.

There was a second, quieter failure on the same lines: if the `for` ran to completion because
*every* frame merged, the re-entry then took the else branch on its first step and inserted a
"neutral" rubato one frame after `ref` — closing the loop it had just built.

The walk now records where the run of frames stopped and advances `ref` outside the `for`,
breaking when the run reached the end of the piece. Both cases are covered by
`test/rubato/CombineAdjacentRubatos.test.ts`.

### 6. `MakeDefaultArticulation` shadowed the list it was pruning

```ts
const notes: MsmNote[] = [...msm.allNotes]
for (const articulation of …) {
    if (articulation.noteid) { … }
    else {
        const notes = msm.notesAtDate(articulation.date, this.options.scope)  // shadows
        for (const note of notes) notes.splice(notes.indexOf(note), 1)        // and self-splices
    }
}
```

An `<articulation>` with no `@noteid` applies to every note at its date. The inner `notes`
shadowed the outer one, so the loop spliced from the array it had just built and left the
outer list untouched — those notes went on counting towards the default articulation, which is
supposed to describe only the notes nothing else explains. (Splicing while iterating skipped
every other element too, so it did not even empty the array it did touch.)

Now removes them from the outer list.

### 7. `InsertDynamicsGradient` threw on its own defaults

Choosing between the `crescendo` and `decrescendo` gradients happened *inside* the
`if (this.options.sortVelocities)` branch, so with `sortVelocities: false` — which is what the
constructor's own default options say — `gradient` stayed undefined and
`gradient.to - gradient.from` threw a `TypeError`. The direction a chord leans is a property of
the chord, not of whether its velocities are also being rewritten.

The direction is now read first, from the shared `directionOf` helper, and the sorting is
applied only when asked for. The corpus never hit this (its one call passes
`sortVelocities: true`), but the transformer's no-argument constructor — which
`mpm-desk/src/pipeline.worker.ts` uses — did.

### 8. `StylizeArticulation` could not see a chord's notes

```ts
targetNotes = targetNotes.filter(n => n["xml:id"] === articulation.noteid.slice(1))
```

`@noteid` is a *space-separated list* of references — `InsertArticulation` folds the notes of a
chord into one instruction with `noteid="#n0 #n1"`. Comparing the whole attribute, minus its
first character, against a single id matched nothing as soon as there were two notes. So
`findConflicts` found no target notes for exactly the instructions most likely to conflict, and
those articulations were stylised away into a shared definition that overruns a repeated pitch.

Now splits on whitespace and strips the `#` per reference.

### 9. `instructionsEffectiveAtDate` read the wrong loop variable

```ts
for (const instructionType of instructionTypesToGet) {
    for (const part of parts) {
        const instructions = this.getInstructions<T>(type, part)   // `type`, not `instructionType`
```

With no `type` argument the method loops over all eight instruction types, fetches *all*
instructions each time round, and then applies the current type's rules to them — so a rubato
would be tested for whether an accentuation pattern is still running. `InsertRubato`, the only
caller, always names a type, so it never showed. Corrected in the port.

### 10. An empty score ended before it began

`MSM.lastDate()` and `MSM.end` are `Math.max(...)` over the notes, which is `-Infinity` for an
empty score. Every date comparison downstream then reads the end of the piece as before its
start. Both now answer 0.

---

## Fixed by the port itself

These were defects of mpm-ts, and they are gone because the document model is espressivo's now.
They are listed because they are what the output looked like until today.

### 11. The reader silently dropped most of the document

`parseMPM` handled `dynamics`, `movement`, `ornament`, `tempo`, `articulation`, `asynchrony`,
`rubato` and `ornamentDef`. It had no case for `<accentuationPattern>` — the defect §1 of the
port brief measured: **0 of 51 read, with no error** — and none for `<style>` switches,
`articulationDef`, `accentuationPatternDef` or `<metadata>` either. A document read and written
back lost all of them.

espressivo reads the whole format. `test/mpm/MPM.test.ts` pins the round trip.

### 12. An instruction could be merged into a `<style>` element

mpm-ts kept style switches in the same array as the instructions, and the merge lookup was
`map.find(i => i.date === instruction.date && i.noteid === instruction.noteid)` — no test of
what kind of element it had found. A `<style>` has a `date` and no `noteid`, so an instruction
arriving at a date where a style switch sat, and no instruction did, was written *onto the
style*: the switch grew a `bpm` and a `beatLength`, and the instruction was never added.

The new `insertInstruction` matches on the element's local name as well.

### 13. A related resource was written under its media type

`exportMPM`'s generic serializer used `node.type` as the element name. A `RelatedResource` is
`{ uri, type }`, where `type` names the resource *kind* — so `{ uri: 'roll.mei', type: 'mei' }`
serialized as `<mei uri="roll.mei"/>`, outside any `<relatedResources>`. Now written as MPM
spells it. (Nothing in the corpus uses related resources, so this was never seen.)

### 14. The document had no namespace

mpm-ts wrote `<mpm>` with no attributes at all. MPM lives in
`http://www.cemfi.de/mpm/ns/1.0`, and a namespace-aware reader — meico's own included — does
not recognise an element outside it. espressivo declares it.

---

## Not bugs, but worth knowing

- **`src/transformers/modification/Constrain.ts` is entirely inside a comment.** The file
  contains a constraint solver that was never finished; `knip.json` has ignored it since before
  the port. Nothing imports it.
- **`InterpolateTimingImprecision` is a stub.** Its `transform` builds a local object and
  returns; the line that would insert it is commented out. It is not registered in `Order.ts`.
- **Four transformers are no longer reachable from mpm-desk**: `InsertAsynchrony`,
  `InterpolateTimingImprecision`, `CompressOrnamentation` and `Constrain`. The first three were
  ported like everything else — the change is mechanical and skipping them would have left
  `mpm-ts` imports behind — but they have no test and no caller, and the bugs above were not
  hunted for in them.
- **`MakeDefaultArticulation` is used by mpm-desk but is not registered in `Order.ts`,** so
  `validate()` cannot place it and `compareTransformers` sorts it to the front of any chain
  (`indexOf` answers -1). Registering it is a decision about the reduction order, not a port.
