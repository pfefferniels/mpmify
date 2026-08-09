/**
 * Read a meico-augmented MSM into exactly the shape espressivo's `performMsmToData` returns,
 * so the two renderers can be compared — and used — interchangeably.
 *
 * A hand-rolled scanner rather than an XML library: the documents are machine-written,
 * attribute values are `"`-quoted and contain no markup, and the whole point of this file is
 * to be independent of the code under test. `parseFloat` on Java's `Double.toString` output is
 * exact — that method is specified to emit a decimal that reads back as the same double, and
 * JS' parser is correctly rounded — so the doubles survive the round trip bit-for-bit.
 */

const ATTR = /([\w:.]+)="([^"]*)"/g;

function attrs(tag) {
  const o = {};
  ATTR.lastIndex = 0;
  let m;
  while ((m = ATTR.exec(tag)) !== null) o[m[1]] = m[2];
  return o;
}

function elements(chunk, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b[^>]*/?>`, 'g');
  let m;
  while ((m = re.exec(chunk)) !== null) out.push(attrs(m[0]));
  return out;
}

/**
 * The content of `<name>…</name>`, `''` for the self-closing `<name/>`, `null` if absent.
 *
 * The earlier version matched the literal string `<name>` only, so a tag carrying attributes or
 * written self-closing — both of which meico emits — read as "absent" and silently produced a
 * part with zero notes or a dropped CC stream. That failure is invisible on the java render
 * path, where a lost positionMap would surface as an empty `sustain_cc` rather than an error,
 * so it is now a parse error rather than a default.
 */
function section(chunk, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*?)?(/)?>`).exec(chunk);
  if (m === null) return null;
  if (m[1]) return '';
  const open = m.index + m[0].length;
  const close = chunk.indexOf(`</${name}>`, open);
  if (close < 0) throw new Error(`augmented MSM: unterminated <${name}>`);
  return chunk.slice(open, close);
}

const numOf = (s) => (s === undefined ? null : parseFloat(s));

/** A required numeric attribute. Absence means the render did not happen — never a default. */
function req(a, key, where) {
  const v = a[key];
  if (v === undefined) throw new Error(`augmented MSM: ${where} has no ${key} (unperformed?)`);
  const n = parseFloat(v);
  if (!Number.isFinite(n)) throw new Error(`augmented MSM: ${where} ${key}="${v}" is not finite`);
  return n;
}

function ccPoint(a, where) {
  return {
    date: req(a, 'date', where),
    milliseconds: req(a, 'milliseconds.date', where),
    value: req(a, 'value', where),
  };
}

export function readAugmentedMsm(xml) {
  const parts = [];
  const chunks = xml.split(/<part\b/).slice(1);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const head = attrs(chunk.slice(0, chunk.indexOf('>')));
    const score = section(chunk, 'score') ?? '';

    // No fallbacks. espressivo's facade defaults an unperformed note's velocity to 100 and its
    // ms dates to the symbolic ones (`api/pipeline.ts::readNote`); mirroring that here would
    // make a *failed render* on the java path look like a successful one with suspiciously
    // round numbers. Every note in an augmented MSM carries all four attributes, so their
    // absence is a defect and is raised as one.
    const notes = elements(score, 'note').map((a, k) => ({
      id: a['xml:id'] ?? a.id ?? null,
      pitch: req(a, 'midi.pitch', `part ${i} note ${k}`),
      date: req(a, 'date', `part ${i} note ${k}`),
      duration: req(a, 'duration', `part ${i} note ${k}`),
      velocity: req(a, 'velocity', `part ${i} note ${k}`),
      milliseconds: {
        date: req(a, 'milliseconds.date', `part ${i} note ${k}`),
        end: req(a, 'milliseconds.date.end', `part ${i} note ${k}`),
      },
    }));

    const controlChanges = [];
    const vol = section(chunk, 'channelVolumeMap');
    if (vol !== null) {
      const points = elements(vol, 'volume').map((a) => ccPoint(a, `part ${i} channelVolume`));
      if (points.length) controlChanges.push({ kind: 'channelVolume', controller: null, ccNumber: 7, points });
    }
    const pos = section(chunk, 'positionMap');
    if (pos !== null) {
      const byController = new Map(); // first-appearance order, like the facade
      for (const a of elements(pos, 'position')) {
        const c = a.controller ?? null;
        if (!byController.has(c)) byController.set(c, []);
        byController.get(c).push(ccPoint(a, `part ${i} position`));
      }
      for (const [controller, points] of byController)
        controlChanges.push({
          kind: 'position',
          controller,
          ccNumber: controller === 'sustain' ? 64 : controller === 'soft' ? 67 : 0,
          points,
        });
    }

    parts.push({
      index: i,
      name: head.name ?? null,
      midiChannel: numOf(head['midi.channel']),
      midiPort: numOf(head['midi.port']),
      notes,
      controlChanges,
    });
  }
  return { title: null, ppq: 720, parts };
}
