/**
 * MSM / MPM document builders.
 *
 * These emit exactly the documents `ml/java/SampleAndRender.java` builds in memory through
 * meico's own factories (`Msm.createMsm` / `Msm.makePart` / `TempoMap.addTempo` / …), down to
 * attribute order and `Double.toString` number formatting — see `jd()` below. That matters
 * for two reasons: the Java fork must parse the same text the TS renderer parses (the
 * cross-renderer proof feeds *one* XML string to both), and a v3-compat document should be
 * diffable against a meico-serialized one.
 */

import { MOVEMENT_DEFAULT_CURVATURE, MOVEMENT_DEFAULT_PROTRACTION } from './sampler.mjs';

const XML_NS = 'http://www.w3.org/XML/1998/namespace'; // documented; xml:id needs no declaration
void XML_NS;

/**
 * A decimal that reads back as exactly this double, in Java's `Double.toString` *shape*.
 *
 * Java switches to scientific notation at |v| >= 1e7 or |v| < 1e-3 (and 0 < |v|); nothing here
 * reaches either bound — dates <= 46080 ticks, milliseconds <= ~160000, everything else is a
 * value in [-80, 240] — so the two rules below cover the whole domain, and `assertJdRange`
 * guards the assumption.
 *
 * For the 1- and 2-decimal values this generator samples, the output is byte-identical to
 * `Double.toString`. It is **not** guaranteed to be for M4's `k/127` positions: JDK <= 18's
 * `Double.toString` occasionally emits one digit more than necessary (JDK-4511638, fixed in 19),
 * while `String(v)` is always the shortest round-tripping decimal. That is harmless here,
 * because nothing compares this text against meico's serialization — both renderers *parse* it,
 * and `Double.parseDouble` and V8's parser are both correctly rounded, so the shortest
 * round-tripping decimal reads back as the same double in both languages. The cross-renderer
 * check confirms it end-to-end: an off-by-one-ULP position would move CC values.
 */
export function jd(v) {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v) && Math.abs(v) < 1e7) return `${v}.0`;
  return String(v);
}

export function assertJdRange(v) {
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e7 || a < 1e-3))
    throw new RangeError(`jd(): ${v} would be scientific notation in Java's Double.toString`);
  return v;
}

/** `SampleAndRender.fmt` — "%.2f" with trailing zeros and a trailing dot stripped. */
export function fmt(v) {
  let s = v.toFixed(2);
  while (s.endsWith('0')) s = s.slice(0, -1);
  if (s.endsWith('.')) s = s.slice(0, -1);
  return s;
}

/** `"1440.0"` → `"1440"`, as the v3 JSONL writer does for tick/pitch/velocity fields. */
export function stripZero(s) {
  if (s === null || s === undefined) return 'null';
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

const EMPTY_GLOBAL =
  '<global><header /><dated><timeSignatureMap /><keySignatureMap /><markerMap /><sectionMap />' +
  '<phraseMap /><sequencingMap /><pedalMap /><miscMap /></dated></global>';

/**
 * Build an MSM. `parts` is `[{name, number, midiChannel, midiPort, notes:[{date,dur,pitch}]}]`;
 * note `xml:id`s are `p<part>n<index>` so that ids stay unique across parts.
 */
export function buildMsm(title, xmlId, ppq, parts) {
  const out = [`<?xml version="1.0"?>\n<msm title="${title}" xml:id="${xmlId}" pulsesPerQuarter="${ppq}">`];
  out.push(EMPTY_GLOBAL);
  for (const part of parts) {
    out.push(
      `<part name="${part.name}" number="${part.number}" midi.channel="${part.midiChannel}" midi.port="${part.midiPort}">` +
        '<header /><dated><timeSignatureMap><timeSignature date="0.0" numerator="4.0" denominator="4" /></timeSignatureMap>' +
        '<keySignatureMap /><markerMap /><sequencingMap /><pedalMap /><phraseMap /><miscMap><tupletSpanMap /></miscMap><score>',
    );
    for (let i = 0; i < part.notes.length; i++) {
      const n = part.notes[i];
      out.push(
        `<note xml:id="p${part.number}n${i}" date="${jd(n.date)}" midi.pitch="${jd(n.pitch)}"` +
          ` pitchname="x" accidentals="0.0" octave="3.0" duration="${jd(n.dur)}" />`,
      );
    }
    out.push('</score></dated></part>');
  }
  out.push('</msm>');
  return out.join('');
}

/**
 * Build an MPM.
 *
 * `maps` holds the global maps (tempo, dynamics, rubato, movement, accentuation) and `parts`
 * the MPM part stubs, each optionally carrying a local `asynchrony` and a local
 * `articulation` list. Global-vs-local placement is a canonical decision, not an accident:
 * tempo, dynamics, rubato and movement are global so both score parts share one instruction
 * stream, while asynchrony is *by definition* a per-part quantity (CANONICAL Y1) and
 * articulation is per-part from v4 on (CANONICAL A6): a global articulationMap addresses
 * dates, and meico resolves a date that carries no note in *this* part onto the part's next
 * note, so with two independent rhythms 80 % of the instructions articulate the wrong note.
 *
 * `maps.articulation` is still honoured, and is what `--v3-compat` uses: a one-part piece
 * whose articulation dates come from that part's own onsets has no A6 exposure, and keeping
 * the global element is what makes the v3 documents byte-comparable with
 * `ml/java/SampleAndRender.java`.
 */
export function buildMpm(perfName, ppq, maps, parts) {
  const out = ['<?xml version="1.0"?>\n<mpm xmlns="http://www.cemfi.de/mpm/ns/1.0">'];
  out.push(`<performance name="${perfName}" pulsesPerQuarter="${ppq}">`);

  out.push('<global>');
  const acc = maps.accentuation;
  if (acc) {
    out.push('<header><metricalAccentuationStyles><styleDef name="v4">');
    out.push(`<accentuationPatternDef name="ap0" length="${jd(acc.length)}">`);
    for (const a of acc.anchors)
      out.push(
        `<accentuation beat="${jd(a.beat)}" value="${jd(a.value)}" transition.from="${jd(a.from)}" transition.to="${jd(a.to)}" />`,
      );
    out.push('</accentuationPatternDef></styleDef></metricalAccentuationStyles></header>');
  } else {
    out.push('<header />');
  }
  out.push('<dated>');

  if (maps.tempo && maps.tempo.length) {
    out.push('<tempoMap>');
    for (const t of maps.tempo) {
      if (t.transitionTo === null)
        out.push(`<tempo date="${jd(t.date)}" bpm="${fmt(t.bpm)}" beatLength="0.25" />`);
      else
        out.push(
          `<tempo date="${jd(t.date)}" bpm="${fmt(t.bpm)}" transition.to="${fmt(t.transitionTo)}"` +
            ` beatLength="0.25" meanTempoAt="${jd(t.meanTempoAt)}" />`,
        );
    }
    out.push('</tempoMap>');
  }

  if (maps.dynamics && maps.dynamics.length) {
    out.push('<dynamicsMap>');
    for (const d of maps.dynamics) {
      if (d.transitionTo === null) out.push(`<dynamics date="${jd(d.date)}" volume="${fmt(d.volume)}" />`);
      else
        out.push(
          `<dynamics date="${jd(d.date)}" volume="${fmt(d.volume)}" transition.to="${fmt(d.transitionTo)}"` +
            ` curvature="${jd(d.curvature)}" protraction="${jd(d.protraction)}" />`,
        );
    }
    out.push('</dynamicsMap>');
  }

  if (maps.articulation && maps.articulation.length) {
    out.push('<articulationMap>');
    for (const a of maps.articulation)
      out.push(
        `<articulation date="${jd(a.date)}" relativeDuration="${jd(a.relDur)}"` +
          ` absoluteVelocityChange="${jd(a.velChange)}" />`,
      );
    out.push('</articulationMap>');
  }

  if (maps.rubato && maps.rubato.length) {
    out.push('<rubatoMap>');
    for (const r of maps.rubato)
      out.push(
        `<rubato date="${jd(r.date)}" frameLength="${jd(r.frameLength)}" intensity="${jd(r.intensity)}"` +
          ` lateStart="${jd(r.lateStart)}" earlyEnd="${jd(r.earlyEnd)}" loop="${r.loop}" />`,
      );
    out.push('</rubatoMap>');
  }

  if (maps.movement && maps.movement.length) {
    out.push('<movementMap>');
    for (const m of maps.movement) {
      // M6: `position` explicit on every instruction. M9: `curvature`/`protraction` are written
      // only when they differ from `MovementData`'s field defaults (0.4 / 0.0) — an attribute
      // equal to the default renders identically to no attribute at all, so writing it is a
      // pure alias. The JSONL still reports the sampled number: it is the same number the
      // renderer used, and the omission is a *token*-level canonicalisation, not a value change.
      let e = `<movement date="${jd(m.date)}" position="${jd(m.position)}"`;
      if (m.transitionTo !== null) e += ` transition.to="${jd(m.transitionTo)}"`;
      if (m.curvature !== null && m.curvature !== MOVEMENT_DEFAULT_CURVATURE)
        e += ` curvature="${jd(m.curvature)}"`;
      if (m.protraction !== null && m.protraction !== MOVEMENT_DEFAULT_PROTRACTION)
        e += ` protraction="${jd(m.protraction)}"`;
      out.push(`${e} controller="${m.controller ?? 'sustain'}" />`); // M7
    }
    out.push('</movementMap>');
  }

  if (acc) {
    out.push('<metricalAccentuationMap>');
    out.push('<style date="0.0" name.ref="v4" />');
    out.push(
      `<accentuationPattern date="0.0" name.ref="ap0" scale="${jd(acc.scale)}" loop="true" stickToMeasures="true" />`,
    );
    out.push('</metricalAccentuationMap>');
  }

  out.push('</dated></global>');

  for (const p of parts) {
    out.push(
      `<part name="${p.name}" number="${p.number}" midi.channel="${p.midiChannel}" midi.port="${p.midiPort}">` +
        '<header /><dated>',
    );
    if (p.asynchrony && p.asynchrony.length) {
      out.push('<asynchronyMap>');
      for (const a of p.asynchrony)
        out.push(`<asynchrony date="${jd(a.date)}" milliseconds.offset="${jd(a.msOffset)}" />`);
      out.push('</asynchronyMap>');
    }
    if (p.articulation && p.articulation.length) {
      out.push('<articulationMap>');
      for (const a of p.articulation)
        out.push(
          `<articulation date="${jd(a.date)}" relativeDuration="${jd(a.relDur)}"` +
            ` absoluteVelocityChange="${jd(a.velChange)}" />`,
        );
      out.push('</articulationMap>');
    }
    out.push('</dated></part>');
  }

  out.push('</performance></mpm>');
  return out.join('');
}
