/**
 * Score-side MSM handling for the real-repertoire corpus: read what the MEI converter
 * produced, and re-emit a clean, windowable MSM that the render path already understands.
 *
 * Why re-emit rather than edit in place. The converted MSM carries a `<sequencingMap>` with
 * `<goto>` elements (repeat structure), a `<sectionMap>`, MEI-derived `<phrase>`s and, on
 * ornamented repertoire, notes of `duration="0"`. Every one of those is a decision waiting to
 * be made by whichever consumer touches the file next — and "whichever consumer" is exactly
 * how a corpus acquires two different note sets under one name. Re-emitting through a builder
 * of our own makes the decisions once, here, and produces documents in the same shape
 * `ml/node/xml.mjs` writes for the synthetic path, so both corpora meet the renderer on
 * identical ground.
 *
 * The three decisions, each reversible and each recorded per piece in `msm/index.json`:
 *
 *  - **repeats are NOT resolved.** `Msm.resolveSequencingMaps()` is called by `build_msm.mjs`
 *    only to *measure* what it would produce (`resolvedNotes` in `msm/index.json`); its result
 *    is discarded and the corpus is the score **as written, once through**. An earlier version
 *    of this file resolved them and this paragraph said so; both are wrong, and the reason is
 *    the other side of the pipeline: Verovio runs with `expandNever`, so its MEI, its MIDI and
 *    its timemap all describe the unexpanded score. Resolving on the meico side alone would
 *    (a) put the two realisations out of correspondence and turn `score_check.py` from a check
 *    into noise, and (b) break `redateFromTimemap`, which joins on `xml:id` — the expansion
 *    rewrites ids to `meico_repetition_k_…` and the timemap has never heard of them. Expanding
 *    on *both* sides is coherent and is v1.1 work; expanding on one is not a corpus decision
 *    but a defect. `hasGoto` marks the affected movements (16 of the pilot's 30).
 *  - **zero-duration notes are dropped.** meico's MEI importer gives a grace note
 *    `duration="0"`: it consumes no score time. Rendered, its note-off lands on its note-on,
 *    and every duration-derived quantity in the feature set (`log2` duration ratio, the
 *    articulation head's `relativeDuration`) is then either degenerate or non-finite. There is
 *    no honest repair — inventing a duration invents score content — so the notes are removed
 *    and counted. They are 0 % of the Bach and Chopin pilot files and up to ~5 % of a
 *    Scarlatti sonata; the count is in `index.json` per piece.
 *  - **part order is checked, not assumed.** Asynchrony (CANONICAL Y1/Y5) needs part 1 to be
 *    the *leading* voice, and the converter's part numbering follows the MEI staff order,
 *    which follows the Humdrum spine order — which is bottom-up. `partStats` reports each
 *    part's median pitch so the caller can verify (and, in this corpus, reorder) rather than
 *    trust the number.
 */

export const PPQ = 720;

/** All `name="value"` pairs of one XML start tag body. Values are attribute-escaped text. */
function attrs(body) {
  const out = {};
  const re = /([\w:.]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(body)) !== null) out[m[1]] = m[2];
  return out;
}

const num = (v) => (v === undefined ? null : Number(v));

/**
 * Parse a converted MSM into `{title, ppq, parts:[{number, name, timeSignature, notes}]}`.
 *
 * `notes` are `{date, dur, pitch, id}` in ticks, ascending by (date, pitch). Notes are read
 * per `<part>` so a note can never be attributed to the wrong one, which a flat scan over
 * `<note>` elements would allow the moment a part boundary moved.
 */
export function parseMsm(text) {
  const ppq = Number(/pulsesPerQuarter="(\d+)"/.exec(text)?.[1] ?? 0);
  if (ppq !== PPQ) throw new Error(`MSM pulsesPerQuarter is ${ppq}, expected ${PPQ}`);
  const title = /<msm[^>]*title="([^"]*)"/.exec(text)?.[1] ?? '';

  const parts = [];
  const partRe = /<part\s([^>]*)>([\s\S]*?)<\/part>/g;
  let pm;
  while ((pm = partRe.exec(text)) !== null) {
    const a = attrs(pm[1]);
    const body = pm[2];
    const ts = /<timeSignature\s([^>]*)\/>/.exec(body);
    const tsa = ts ? attrs(ts[1]) : null;
    const notes = [];
    const noteRe = /<note\s([^>]*)\/>/g;
    let nm;
    while ((nm = noteRe.exec(body)) !== null) {
      const na = attrs(nm[1]);
      notes.push({
        date: num(na.date),
        dur: num(na.duration),
        pitch: Math.round(num(na['midi.pitch'])),
        id: na['xml:id'] ?? null,
      });
    }
    notes.sort((x, y) => x.date - y.date || x.pitch - y.pitch);
    parts.push({
      number: Number(a.number),
      name: a.name || '',
      midiChannel: Number(a['midi.channel'] ?? 0),
      timeSignature: tsa ? { numerator: Number(tsa.numerator), denominator: Number(tsa.denominator) } : null,
      notes,
    });
  }
  parts.sort((x, y) => x.number - y.number);
  return { title, ppq, parts };
}

/**
 * Re-date every note from Verovio's timemap, keyed by `xml:id`, and report what moved.
 *
 * ### The defect this exists for
 *
 * meico's MEI importer advances the clock by a **full measure** across an *incomplete* one.
 * A pickup measure therefore contributes `measureTicks` of score time instead of its own
 * content, and everything after the first barline is late by the difference. On Chopin
 * op. 28/7 (3/4, one-beat pickup) that is 1440 ticks on 127 of 168 notes; it recurs at every
 * incomplete measure, so a piece with a written-out repeat structure or a mid-piece pickup
 * accumulates several. It is invisible in isolation — the score still renders, the bar grid
 * still looks regular, only a silence appears that the score does not contain — and it was
 * found only because Verovio's realisation of the *same parse* disagreed.
 *
 * ### The repair
 *
 * Verovio's `renderToTimemap` returns, for the same document, every event's `qstamp` in
 * quarter notes together with the `xml:id`s that start (`on`) and end (`off`) there. Since
 * the MSM's note ids *are* the MEI's, every note can be re-dated from it directly:
 * `date = qstamp · 720`, `duration = offQstamp · 720 − date`. This is a wholesale replacement
 * of the importer's timing by the parser's, not a heuristic patch, and it subsumes the
 * pickup-measure case along with anything else the importer's tick accounting gets wrong.
 *
 * It requires `expandNever` on the Verovio side (`kern_to_mei.py`): with repeats expanded the
 * timemap holds copies under fresh ids and describes performance time rather than written
 * time, and the join would silently re-date the score into its own repeat.
 *
 * What is *inherited* rather than *checked* by this: note timing is now Verovio's by
 * construction, so `score_check.py`'s onset agreement is no longer independent evidence.
 * Pitch, part assignment and the note set still come from meico and are still checked against
 * Verovio's MIDI, which is the direction the 8va defect shows up in.
 *
 * Returns `{parts, moved, maxShiftTicks, durationChanged, missing}`. `missing` lists ids the
 * timemap does not mention; they are **dropped**, because a note the parser does not place is
 * a note nobody can date.
 */
export function redateFromTimemap(parts, timemap) {
  const on = new Map();
  const off = new Map();
  for (const e of timemap) {
    const q = e.qstamp;
    for (const id of e.on ?? []) if (!on.has(id)) on.set(id, q);
    for (const id of e.off ?? []) if (!off.has(id)) off.set(id, q);
  }
  let moved = 0;
  let maxShift = 0;
  let durationChanged = 0;
  const missing = [];
  const out = parts.map((p) => {
    const notes = [];
    for (const n of p.notes) {
      if (n.id === null || !on.has(n.id)) {
        missing.push(n.id);
        continue;
      }
      const date = Math.round(on.get(n.id) * PPQ);
      const end = off.has(n.id) ? Math.round(off.get(n.id) * PPQ) : date + n.dur;
      const dur = Math.max(0, end - date);
      if (date !== n.date) {
        moved++;
        maxShift = Math.max(maxShift, Math.abs(date - n.date));
      }
      if (dur !== n.dur) durationChanged++;
      notes.push({ ...n, date, dur });
    }
    notes.sort((x, y) => x.date - y.date || x.pitch - y.pitch);
    return { ...p, notes };
  });
  return { parts: out, moved, maxShiftTicks: maxShift, durationChanged, missing };
}

/** Median of a numeric array (lower median), or null when empty. */
function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
}

/**
 * Drop `duration <= 0` notes and report what was dropped, per part.
 *
 * Returns `{parts, dropped, droppedByPart}`. The notes are gone from `parts`; nothing is
 * repaired in place, because a repaired duration is a number the score does not contain.
 */
export function dropZeroDuration(parts) {
  let dropped = 0;
  const droppedByPart = {};
  const droppedNotes = [];
  const out = parts.map((p) => {
    const keep = p.notes.filter((n) => n.dur > 0);
    const d = p.notes.length - keep.length;
    dropped += d;
    if (d) droppedByPart[p.number] = d;
    // The identity of each dropped note, not just the count. Verovio plays these; the corpus
    // does not, so they are the largest class of MIDI-only note-ons — and a *budget* ("at most
    // this many surplus notes are grace notes") cannot tell a grace note from a defect that
    // happens to fit under the budget. With the id, `score_check.py` looks the note up in the
    // timemap and matches the surplus note-on exactly.
    for (const n of p.notes) if (!(n.dur > 0)) droppedNotes.push({ id: n.id, pitch: n.pitch, part: p.number });
    return { ...p, notes: keep };
  });
  return { parts: out, dropped, droppedByPart, droppedNotes };
}

/** Median pitch and note count per part — the evidence behind any "part 1 is the melody" claim. */
export function partStats(parts) {
  return parts.map((p) => ({
    number: p.number,
    n: p.notes.length,
    medianPitch: median(p.notes.map((n) => n.pitch)),
    minPitch: p.notes.length ? Math.min(...p.notes.map((n) => n.pitch)) : null,
    maxPitch: p.notes.length ? Math.max(...p.notes.map((n) => n.pitch)) : null,
  }));
}

/**
 * Reorder parts so that part 1 is the one with the **highest** median pitch.
 *
 * CANONICAL Y1 gives part 1 the timeline and Y5 wants part 2's date-0 offset positive, i.e.
 * the *leading* voice must be part 1. In piano playing the melody leads (LOG.md: Vienna
 * measures a positive top-voice lead in 35/40 windows), and the melody is the upper staff.
 * The converter's numbering comes from the MEI staff order, which comes from the Humdrum
 * spine order, which is bottom-up. The renumbering is by measured median pitch and is
 * reported, so the claim "part 1 is the upper voice" is checkable per piece rather than
 * assumed from a file format.
 *
 * **On this pilot it never fires** — `registerReordered` is false on 30/30 pieces, because
 * Verovio's kern importer already emits the upper staff first, so the bottom-up spine order
 * never reaches the MSM. That makes this a safeguard the corpus does not exercise, which is
 * exactly the kind of code that is wrong when it finally runs, so it is covered by
 * `selftest.mjs` on a constructed inverted score instead. What the pilot *does* exercise is
 * the resulting invariant: `verify_corpus.mjs` re-checks the register order on the emitted
 * notes of every window.
 */
export function orderPartsByRegister(parts) {
  const ranked = parts
    .filter((p) => p.notes.length)
    .slice()
    .sort((a, b) => (median(b.notes.map((n) => n.pitch)) ?? 0) - (median(a.notes.map((n) => n.pitch)) ?? 0));
  return ranked.map((p, i) => ({ ...p, number: i + 1 }));
}

/**
 * Cut a window `[startTick, startTick + lengthTicks)` out of a score.
 *
 * A note is in the window iff its **onset** is; its duration is kept whole, even where it
 * outlives the window. Clipping durations at the boundary would manufacture articulation the
 * score does not have — precisely the band the articulation head is supposed to learn — and
 * the maps do not need the note to end inside the window: every map's last instruction is
 * constant and extends forward (G7/M1/Y4).
 */
export function windowScore(parts, startTick, lengthTicks) {
  return parts.map((p) => ({
    ...p,
    notes: p.notes
      .filter((n) => n.date >= startTick && n.date < startTick + lengthTicks)
      .map((n) => ({ ...n, date: n.date - startTick })),
  }));
}

const jd = (v) => (Number.isInteger(v) && Math.abs(v) < 1e7 ? `${v}.0` : String(v));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * Emit an MSM for a score window, in the shape `ml/node/xml.mjs::buildMsm` writes.
 *
 * Deliberately keeps the **source note id** (`xml:id`) where the MEI had one: the facade
 * returns it on every `PerformedNote`, so a rendered note can be traced back to the MEI
 * element and from there to the kern token. Ids are made unique per part with a `p<n>:`
 * prefix only when a duplicate is seen, so an unmodified corpus keeps the MEI's own strings.
 */
export function buildScoreMsm(title, xmlId, parts, timeSignature) {
  const ts = timeSignature ?? { numerator: 4, denominator: 4 };
  const seen = new Set();
  const out = [`<?xml version="1.0"?>\n<msm title="${esc(title)}" xml:id="${esc(xmlId)}" pulsesPerQuarter="${PPQ}">`];
  out.push(
    '<global><header /><dated><timeSignatureMap>' +
      `<timeSignature date="0.0" numerator="${jd(ts.numerator)}" denominator="${ts.denominator}" />` +
      '</timeSignatureMap><keySignatureMap /><markerMap /><sectionMap /><phraseMap /><sequencingMap /><pedalMap /><miscMap /></dated></global>',
  );
  for (const part of parts) {
    out.push(
      `<part name="${esc(part.name || `part${part.number}`)}" number="${part.number}" ` +
        `midi.channel="${part.number - 1}" midi.port="0">` +
        '<header /><dated><timeSignatureMap>' +
        `<timeSignature date="0.0" numerator="${jd(ts.numerator)}" denominator="${ts.denominator}" />` +
        '</timeSignatureMap><keySignatureMap /><markerMap /><sequencingMap /><pedalMap /><phraseMap />' +
        '<miscMap><tupletSpanMap /></miscMap><score>',
    );
    part.notes.forEach((n, i) => {
      let id = n.id ?? `p${part.number}n${i}`;
      if (seen.has(id)) id = `p${part.number}n${i}`;
      seen.add(id);
      out.push(
        `<note xml:id="${esc(id)}" date="${jd(n.date)}" midi.pitch="${jd(n.pitch)}" pitchname="x" ` +
          `accidentals="0.0" octave="3.0" duration="${jd(n.dur)}" />`,
      );
    });
    out.push('</score></dated></part>');
  }
  out.push('</msm>');
  return out.join('');
}
