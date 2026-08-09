#!/usr/bin/env node
/**
 * v4 synthetic-data generator — the successor of `ml/java/SampleAndRender.java`.
 *
 * Samples a canonical-form MPM plus a random score, renders it with **espressivo** (the
 * TypeScript port of meico, imported from its built `dist/api/index.js` — no npm dependency
 * of our own), and writes one JSON line per piece.
 *
 *   node generate_v4.mjs <out.jsonl> <numPieces> <seed> [options]
 *
 * Options
 *   --maps a,b,c        tempo,dynamics,articulation,rubato,asynchrony,movement
 *                       (default: all six)
 *   --renderer r        espressivo (default) | java. Both consume the *same* XML strings; the
 *                       java path batches them through ml/java/RenderMpm in one JVM and reads
 *                       the augmented MSM back into the facade's own data shape.
 *                       **At the meico-ts state recorded in ESPRESSIVO_DEFECTS below the two are
 *                       NOT interchangeable** (E1, E2), so `--renderer java` is currently the
 *                       only correct choice for datasets containing articulation or a dynamics
 *                       transition with curvature/protraction.
 *   --with-accentuation adds metricalAccentuationMap. DEFAULT OFF. The program gate was that
 *                       accentuation *supervision data* waits for meico-ts' TD3; TD3 has now
 *                       landed and is verified cross-renderer bit-exact (ESPRESSIVO_DEFECTS E3),
 *                       so the technical condition is met — but whether to generate the data is
 *                       the program's call, so the default does not move on its own.
 *   --v3-compat         reproduce ml/java/SampleAndRender.java exactly: v3 score/tempo domain,
 *                       one part, v3 JSONL schema (6-element notes, no v4 maps). Used to prove
 *                       the port faithful; see verify_v4.mjs --v3-compat.
 *   --two-part-prob p   probability a piece gets the bass part (default 1.0)
 *   --movement-prob p   probability a piece gets a movementMap (default 1.0)
 *   --asynchrony-prob p probability a two-part piece gets an asynchronyMap (default 1.0)
 *   --movement-max-step s   RenderOptions.movementSampleMaxStep (default 0.1 = meico's own
 *                       static default, which is CANONICAL M10). **espressivo only**: the Java
 *                       path goes through ml/java/RenderMpm, which never assigns meico's
 *                       `MovementMap.movementSampleMaxStep` static, so a non-default value
 *                       there would be silently ignored — passing one with `--renderer java` is
 *                       a hard error rather than a lie.
 *   --dump-dir d        also write piece<i>.msm / piece<i>.mpm, the inputs the Java fork's
 *                       RenderMpm consumes in the cross-renderer proof
 *   --print-domain      print the sampling domain (v3 vs v4 ranges) and exit
 *   --probe-no-pow      DELIBERATELY NON-CANONICAL, validation only. Strips every tempo
 *                       transition and the whole rubatoMap after sampling, which removes the
 *                       only `Math.pow` / `Math.log` calls from the render path (the tempo
 *                       power function and rubato's warp). Everything that survives is
 *                       +-*\/ on doubles, i.e. IEEE-754 exact and identical in both languages,
 *                       so a *bit-exact* cross-renderer result on this configuration proves
 *                       any residual difference elsewhere is a libm ULP artefact and not a
 *                       logic divergence. Never use the output as training data.
 *
 * JSONL schema v4:
 *   {"id","ppq","total_ticks","renderer","seed",     <- total_ticks/renderer/seed are new
 *    "notes":[[date,dur,pitch,msOn,msOff,vel,part],...]          <- 7th element is new
 *    "tempo":[[date,bpm,to|null,meanTempoAt|null],...]
 *    "dynamics":[[date,vol,to|null,curvature|null,protraction|null],...]
 *    "articulation":[[date,relativeDuration,velocityChange,part],...]  <- 4th element is new
 *    "rubato":[[date,frameLength,intensity,lateStart,earlyEnd,loop],...]
 *    "asynchrony":[[date,msOffset],...]                           <- new (part 2 only)
 *    "movement":[[date,position,to|null,curvature|null,protraction|null,controller],...] <- new
 *    "sustain_cc":[[ms,ccValue],...]}                             <- new (part 1's stream)
 *
 * `total_ticks` is the sampled piece length. A validator that derives it from the last note end
 * instead cannot tell a map that stops short of the piece from one that ends with it — which is
 * exactly how a lost movement terminator used to slip through.
 *
 * `renderer` and `seed` make a file self-describing: `--renderer espressivo` output is
 * knowingly mislabelled (E1/E2 below) and used to be indistinguishable from the good path once
 * the filename was lost, and a set whose seed lived only in a shell history was not
 * regenerable. Both are omitted in `--v3-compat`, whose schema is frozen by the v3proof diff.
 *
 * The articulation part column is **schema v4.1** (2026-08-09). articulationMaps are part-local
 * from this revision on (CANONICAL A6): a global map addresses *dates*, and meico resolves a
 * date carrying no note in a given part onto that part's next note, so on two independent
 * rhythms the label named a note the renderer did not articulate. Records written before this
 * revision have 3-element articulation rows and a global map; both shapes are readable, and
 * `ml/python/validate_v4.py::_record_parts` branches on the row length.
 *
 * The movement row is a **6-tuple ending in the controller**, the same shape
 * `ml/python/validate_v4.py` specifies, so a row moves between the two without a rewrite (v4
 * only ever emits "sustain", but "soft" is legal per CANONICAL M7 and a v5 soft chain would
 * otherwise have nowhere to go). `position` and `transition.to` are on M4's 128-value
 * alphabet, round(127*p)/127.
 *
 * Three notes on `sustain_cc`.
 *  1. The movementMap is **global**, so meico renders one positionMap per MSM part; part 2's
 *     copy is part 1's shifted by that part's asynchrony offset, so only part 1's — the
 *     un-offset one — is written, and the other is redundant.
 *  2. `value` is `Math.round`ed to the **integer CC value**, which is what
 *     `Msm.parsePositionMap` emits into MIDI (`Msm.java:1113`) and what the real Vienna corpus
 *     carries under this very key (0/3385 non-integer values there). The raw positionMap double
 *     is not an observable: keeping it would give a synthetic pedal model a value distribution
 *     that cannot occur in real data — the sim2real gap LOG.md blames for v1's Vienna failure.
 *     CANONICAL M4 makes the same point from the representation side.
 *  3. Times and duplicates are otherwise verbatim: `getMovementSegment` emits
 *     `[startDate, position]` twice for every element and `[endDate, transitionTo]` twice for a
 *     transition, and a *constant* element emits three identical points at its own date and
 *     nothing after, so the held value between elements is only recoverable under last-wins
 *     state semantics — the same convention the Vienna pedal ingest had to adopt (LOG.md).
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { readAugmentedMsm } from './augmented_msm.mjs';
import { JavaRandom } from './java_random.mjs';
import { ESPRESSIVO, JAVA_CP } from './paths.mjs';
import {
  PPQ,
  sampleArticulationMap,
  sampleAsynchronyMap,
  sampleAccentuation,
  sampleDynamicsMap,
  sampleMovementMap,
  sampleRubatoMap,
  sampleScoreV3,
  sampleScoreV4Part1,
  sampleScoreV4Part2,
  sampleTempoMap,
} from './sampler.mjs';
import { assertJdRange, buildMpm, buildMsm, fmt } from './xml.mjs';

/**
 * Defects of the *TypeScript* renderer, relative to the Java fork.
 *
 * **Provenance, stated as a state rather than a commit, because the dist is a moving target.**
 * meico-ts is being edited by another team while this runs: its package version is 0.8.8 (the
 * "0.11.2" quoted earlier is the meico release its README tracks, not its own version), and
 * across this session HEAD moved 68d773c → f788c93 → 8283853 → 415bbd2 with the working tree
 * dirty throughout and `dist/` rebuilt three times. Pinning a commit would therefore be a
 * fiction. The state measured below is:
 *
 *     meico-ts HEAD 415bbd2 + uncommitted changes, dist/ built 2026-08-09 11:29
 *     meico (Java fork) 1d662105
 *
 * Each item was checked in `src/` **and** in the built `dist/` at that state, and E1/E2 also on
 * *meico-serialized* fixtures (`ml/data/debug_v3/piece{0,1,2}.mpm`), so neither can be an
 * artefact of the XML this generator writes. Re-check at whatever commit meico-ts freezes:
 * `verify_v4.mjs cross` on a set containing articulation and dynamics transitions is the test.
 *
 *  E1  **live.** `ArticulationMap.getArticulationDataOf`
 *      (src/mpm/elements/maps/ArticulationMap.ts:103) stops after `name.ref` and never reads the
 *      twelve numeric modifier attributes that `ArticulationMap.java` reads, so every literal
 *      (no `name.ref`) articulation renders as the identity: `relativeDuration` stays 1,
 *      `absoluteVelocityChange` stays 0. `ArticulationData`'s own XML constructor does parse
 *      them — it is simply not the path the map uses. (The `relativeDuration` occurrences in the
 *      built `dist/.../ArticulationMap.js` are in `addArticulation`, the *serializer*.)
 *  E2  **live.** `DynamicsMap.getDynamicsDataOf` (src/mpm/elements/maps/DynamicsMap.ts:100)
 *      never reads `curvature` / `protraction`; `DynamicsMap.java:getDynamicsDataOf` reads both
 *      (through `ensure*Boundaries`). Every dynamics transition renders on the wrong Bézier.
 *  E3  **FIXED at this state** — TD3 landed (meico-ts 8283853/415bbd2):
 *      `AccentuationPatternDef.ts:272` now has the Java fork's `i < size - 1` where it had the
 *      dead `i > length - 1`. Verified rather than assumed: with `--with-accentuation`, 20
 *      pieces / 2,679 notes render **bit-identically** in both renderers, and the map is not
 *      vacuous — accentuation moves 2679/2679 velocities by up to 13.04 units against the same
 *      seed with the flag off. The flag nevertheless stays **default OFF**: whether accentuation
 *      supervision data is generated is the program's call, not this generator's.
 *
 * E1 and E2 are omissions relative to Java, not deliberate bug-for-bug parity, and both are
 * silent. Blast radius on the v4 pilot (60 pieces, all maps): velocity wrong on 4053/7251 notes,
 * `milliseconds.date.end` on 1590/7251; `milliseconds.date` unaffected (tempo + rubato exact).
 */
export const ESPRESSIVO_DEFECTS = [
  'E1 articulation modifiers not parsed (live)',
  'E2 dynamics curvature/protraction not parsed (live)',
  'E3 metricalAccentuation pre-TD3 (FIXED at the state above; re-check if meico-ts moves)',
];

// -------------------------------------------------------------------------------------------
// Sampling domain. Every v4 widening is listed here and printed by --print-domain, because the
// Vienna sim2real probe (LOG.md) attributes v1's transfer failure to exactly these ranges.
// -------------------------------------------------------------------------------------------
export const DOMAIN = {
  pieceBeats: { v3: '16..48', v4: '16..64', draw: '16 + U{0..48}' },
  bpm: { v3: 'log-uniform [40,200]', v4: 'log-uniform [25,240]', why: 'Chopin op10/3 sits at ~31 qBPM, below the v3 floor' },
  rhythmGrid: {
    v3: '{180,360,720,1440} p={.20,.40,.30,.10}',
    v4: '{90,180,360,540,720,1440} p={.08,.20,.32,.10,.22,.08}',
    why: '32nd (90) and dotted-8th (540) values',
  },
  denseEpisodes: { v3: 'none', v4: '4% per event: a 1..2-beat run drawn from {90,180} p={.6,.4} → up to 8 notes/beat' },
  chords: { v3: 'p=0.15, size 2..4', v4: 'p=0.18, size 2..4' },
  tempoSegments: { v3: '4 + U{0..12} beats (mean 10)', v4: 'per piece segMax ∈ {6,8,12,16}; 4 + U{0..segMax-4} (mean 5/6/8/10) → up to 2× the v3 instruction density' },
  dynamicsSegments: { v3: '4 + U{0..12} beats', v4: 'same scheme as tempo, drawn independently' },
  parts: { v3: '1 (melody)', v4: '2: melody + bass ({360,720,1440,2880} grid, pitch 24..60, 12% rests, 10% 2-note chords)' },
  articulation: {
    v3: 'one GLOBAL map, dates from the single part\'s onsets',
    v4: 'one PART-LOCAL map per part, dates from that part\'s own onsets (CANONICAL A6); ~15% of dates (A1)',
    why: 'a global map addresses dates, and meico articulates the next note at-or-after a date that carries none — with two independent rhythms only 5.8% of onset dates are shared, so 80% of a global map\'s instructions hit a note the label does not name',
  },
  asynchrony: { v3: 'n/a', v4: 'part 2 only, 1..3 beat-aligned segments >= 4 beats apart, integer ms in [-60,-5]∪[5,60] (CANONICAL Y3); date-0 segment positive (Y5)' },
  movement: { v3: 'n/a', v4: 'sustain only (M7); 1/4-beat grid, segments >= 180 ticks (M3); position/transition.to on the 128-value CC alphabet round(127p)/127 (M4); curvature [0,0.9] / protraction [-0.7,0.7], omitted at the 0.4/0.0 defaults (M9); neutral terminator at the piece end, always closing a ramp (M1)' },
  accentuation: { v3: 'n/a', v4: 'implemented, DEFAULT OFF (--with-accentuation)' },
};

const TEMPO_SEG_MAX = [6, 8, 12, 16];

/** The complete `--maps` vocabulary. A name outside it is a typo, never a silent no-op. */
export const KNOWN_MAPS = ['tempo', 'dynamics', 'articulation', 'rubato', 'asynchrony', 'movement'];

/** meico's own `MovementMap.movementSampleMaxStep` default, i.e. CANONICAL M10. */
const MOVEMENT_MAX_STEP_DEFAULT = 0.1;

// -------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    out: null,
    n: 0,
    seed: 1n,
    maps: 'tempo,dynamics,articulation,rubato,asynchrony,movement',
    accentuation: false,
    v3compat: false,
    twoPartProb: 1.0,
    movementProb: 1.0,
    asynchronyProb: 1.0,
    movementMaxStep: MOVEMENT_MAX_STEP_DEFAULT,
    dumpDir: null,
    printDomain: false,
    renderer: 'java',
    probeNoPow: false,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--with-accentuation') o.accentuation = true;
    else if (a === '--v3-compat') o.v3compat = true;
    else if (a === '--print-domain') o.printDomain = true;
    else if (a === '--probe-no-pow') o.probeNoPow = true;
    else if (a === '--maps') o.maps = argv[++i];
    else if (a === '--two-part-prob') o.twoPartProb = parseFloat(argv[++i]);
    else if (a === '--movement-prob') o.movementProb = parseFloat(argv[++i]);
    else if (a === '--asynchrony-prob') o.asynchronyProb = parseFloat(argv[++i]);
    else if (a === '--movement-max-step') o.movementMaxStep = parseFloat(argv[++i]);
    else if (a === '--dump-dir') o.dumpDir = argv[++i];
    else if (a === '--renderer') o.renderer = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else pos.push(a);
  }
  if (o.printDomain) return o;
  if (pos.length < 3) {
    throw new Error('usage: generate_v4.mjs <out.jsonl> <numPieces> <seed> [options]');
  }
  o.out = pos[0];
  o.n = parseInt(pos[1], 10);
  o.seed = BigInt(pos[2]);
  return o;
}

/** Number → JSON literal. `String()` is the shortest round-tripping decimal, so re-reading a
 *  line recovers the exact double the renderer produced. */
function num(v) {
  if (!Number.isFinite(v)) throw new RangeError(`non-finite value in JSONL: ${v}`);
  return Object.is(v, -0) ? '0' : String(v);
}

const orNull = (v) => (v === null || v === undefined ? 'null' : num(v));

/**
 * Run `fn` with `console.log`/`console.error` **captured**, not discarded, and hand back what
 * they said. espressivo's interior logs progress per render, so leaving it on floods the
 * terminal — but simply dropping it would also drop a parse warning or a defaulted-attribute
 * notice for every piece, with nothing left behind to notice it by.
 */
export function captureConsole(fn) {
  const log = console.log;
  const err = console.error;
  const messages = [];
  console.log = (...a) => messages.push(a.join(' '));
  console.error = (...a) => messages.push(a.join(' '));
  try {
    return { value: fn(), messages };
  } finally {
    console.log = log;
    console.error = err;
  }
}

/**
 * espressivo's recognised per-render progress chatter. Anything captured that does **not** match
 * one of these is reported in full: that is the class a parse failure or a defaulted attribute
 * would land in, and the whole point of capturing rather than discarding.
 */
const ESPRESSIVO_PROGRESS = [
  /^Rendering performance /,
  /^Processing global data\.$/,
  /^Performing part /,
  /^Performance rendering finished\.$/,
];

/** `{progress, unexpected: [[text, count], …]}` — unexpected sorted most frequent first. */
function summarizeMessages(messages) {
  let progress = 0;
  const byText = new Map();
  for (const m of messages) {
    const t = m.trim();
    if (!t) continue;
    if (ESPRESSIVO_PROGRESS.some((re) => re.test(t))) progress++;
    else byText.set(t, (byText.get(t) ?? 0) + 1);
  }
  return { progress, unexpected: [...byText.entries()].sort((a, b) => b[1] - a[1]) };
}

// -------------------------------------------------------------------------------------------
// Piece sampling
// -------------------------------------------------------------------------------------------

/** Ascending, de-duplicated onset dates over all parts — the articulation domain (A1/A4). */
function distinctDates(parts) {
  const set = new Set();
  for (const p of parts) for (const n of p) set.add(n.date);
  return [...set].sort((a, b) => a - b);
}

export function samplePieceV3(rng, index, want) {
  const totalBeats = 16 + rng.nextInt(33);
  const totalTicks = totalBeats * PPQ;
  const score = sampleScoreV3(rng, totalTicks);
  const tempi = sampleTempoMap(rng, totalTicks, { bpmLo: 40, bpmHi: 200, segMin: 4, segSpan: 13 });
  const dyns = want.dynamics ? sampleDynamicsMap(rng, totalTicks, { volLo: 30, volSpan: 85, segMin: 4, segSpan: 13 }) : [];
  const artics = want.articulation ? sampleArticulationMap(rng, distinctDates([score])) : [];
  const rubs = want.rubato ? sampleRubatoMap(rng, totalTicks, tempi) : [];
  return {
    index,
    totalTicks,
    parts: [{ name: 'Piano', number: 1, midiChannel: 0, midiPort: 0, notes: score, asynchrony: [] }],
    maps: { tempo: tempi, dynamics: dyns, articulation: artics, rubato: rubs, movement: [], accentuation: null },
  };
}

export function samplePieceV4(rng, index, want, opt) {
  const totalBeats = 16 + rng.nextInt(49); // 16..64
  const totalTicks = totalBeats * PPQ;

  const twoPart = rng.nextDouble() < opt.twoPartProb;
  const score1 = sampleScoreV4Part1(rng, totalTicks, { denseStart: 0.04 });
  const score2 = twoPart ? sampleScoreV4Part2(rng, totalTicks) : [];

  const tSegMax = TEMPO_SEG_MAX[rng.nextInt(4)];
  const tempi = sampleTempoMap(rng, totalTicks, { bpmLo: 25, bpmHi: 240, segMin: 4, segSpan: tSegMax - 3 });
  const dSegMax = TEMPO_SEG_MAX[rng.nextInt(4)];
  const dyns = want.dynamics ? sampleDynamicsMap(rng, totalTicks, { volLo: 30, volSpan: 85, segMin: 4, segSpan: dSegMax - 3 }) : [];
  // CANONICAL A6: one articulationMap PER PART, drawn from that part's own onset dates.
  // Drawing from the union and installing the map globally (what v4 did until 2026-08-09)
  // is not a labelling detail: only 5.8 % of onset dates are shared between the two parts,
  // and meico resolves a date that carries no note in this part onto its NEXT note, so
  // 80 % of the instructions articulated a note the label does not name.
  const artics1 = want.articulation ? sampleArticulationMap(rng, distinctDates([score1])) : [];
  const artics2 = want.articulation && twoPart ? sampleArticulationMap(rng, distinctDates([score2])) : [];
  const rubs = want.rubato ? sampleRubatoMap(rng, totalTicks, tempi) : [];
  const asyn = want.asynchrony && twoPart && rng.nextDouble() < opt.asynchronyProb ? sampleAsynchronyMap(rng, totalTicks) : [];
  const movs = want.movement && rng.nextDouble() < opt.movementProb ? sampleMovementMap(rng, totalTicks) : [];
  const acc = want.accentuation ? sampleAccentuation(rng, 4) : null;

  const parts = [{ name: 'Piano', number: 1, midiChannel: 0, midiPort: 0, notes: score1, asynchrony: [], articulation: artics1 }];
  if (twoPart)
    parts.push({ name: 'Bass', number: 2, midiChannel: 1, midiPort: 0, notes: score2, asynchrony: asyn, articulation: artics2 });

  return {
    index,
    totalTicks,
    parts,
    // `articulation: []` here is not an omission — the map is part-local now (A6), and
    // `buildMpm` writes a *global* `<articulationMap>` only for the v3-compat path.
    maps: { tempo: tempi, dynamics: dyns, articulation: [], rubato: rubs, movement: movs, accentuation: acc },
  };
}

/** The two XML documents for a sampled piece — the single source both renderers consume. */
export function documentsFor(piece) {
  for (const p of piece.parts) for (const n of p.notes) { assertJdRange(n.date); assertJdRange(n.dur); }
  const msm = buildMsm(`piece${piece.index}`, `piece-${piece.index}`, PPQ, piece.parts);
  const mpm = buildMpm('perf', PPQ, piece.maps, piece.parts);
  return { msm, mpm };
}

// -------------------------------------------------------------------------------------------
// JSONL emission
// -------------------------------------------------------------------------------------------

function notesJson(data, v3) {
  const rows = [];
  for (const part of data.parts) {
    for (const n of part.notes) {
      const tail = v3 ? '' : `,${part.index + 1}`;
      rows.push(
        `[${num(n.date)},${num(n.duration)},${num(n.pitch)},${num(n.milliseconds.date)},` +
          `${num(n.milliseconds.end)},${num(n.velocity)}${tail}]`,
      );
    }
  }
  return rows.join(',');
}

/** part 1's sustain stream — part 1 carries no asynchronyMap, so this is the un-offset one. */
export function sustainStream(data) {
  const part = data.parts[0];
  if (!part) return null;
  return part.controlChanges.find((s) => s.kind === 'position' && s.controller === 'sustain') ?? null;
}

/**
 * Articulation rows. v3 keeps the 3-tuple of a single global map; v4 appends the **part
 * number** (A6: the maps are part-local), streams in part order, ascending within a part.
 * The part column is not decoration — without it the rows cannot be routed back to the map
 * that produced them, and a consumer would re-create exactly the global-map defect A6 fixes.
 */
function articulationJson(piece, v3) {
  if (v3) return piece.maps.articulation.map((a) => `[${num(a.date)},${num(a.relDur)},${num(a.velChange)}]`).join(',');
  const rows = [];
  for (const p of piece.parts)
    for (const a of p.articulation ?? []) rows.push(`[${num(a.date)},${num(a.relDur)},${num(a.velChange)},${num(p.number)}]`);
  return rows.join(',');
}

export function pieceToJsonl(piece, data, v3, provenance) {
  const m = piece.maps;
  // `renderer` and `seed` are provenance, not data: a JSONL that does not say which renderer
  // labelled it cannot be told apart from one labelled by the defective path (E1/E2), and a
  // set whose seed is only in someone's shell history is not reproducible.
  const prov = v3 || !provenance ? '' : `,"renderer":"${provenance.renderer}","seed":${num(provenance.seed)}`;
  const head = v3
    ? `{"id":${piece.index},"ppq":${PPQ}`
    : `{"id":${piece.index},"ppq":${PPQ},"total_ticks":${num(piece.totalTicks)}${prov}`;
  const out = [`${head},"notes":[`, notesJson(data, v3), '],"tempo":['];
  out.push(m.tempo.map((t) => `[${num(t.date)},${fmt(t.bpm)},${t.transitionTo === null ? 'null' : fmt(t.transitionTo)},${orNull(t.meanTempoAt)}]`).join(','));
  out.push('],"dynamics":[');
  out.push(m.dynamics.map((d) => `[${num(d.date)},${fmt(d.volume)},${d.transitionTo === null ? 'null' : fmt(d.transitionTo)},${orNull(d.curvature)},${orNull(d.protraction)}]`).join(','));
  out.push('],"articulation":[');
  out.push(articulationJson(piece, v3));
  out.push('],"rubato":[');
  out.push(m.rubato.map((r) => `[${num(r.date)},${num(r.frameLength)},${num(r.intensity)},${num(r.lateStart)},${num(r.earlyEnd)},${r.loop ? 1 : 0}]`).join(','));
  out.push(']');

  if (!v3) {
    const asyn = piece.parts.flatMap((p) => p.asynchrony ?? []);
    out.push(',"asynchrony":[');
    out.push(asyn.map((a) => `[${num(a.date)},${num(a.msOffset)}]`).join(','));
    out.push('],"movement":[');
    out.push(
      m.movement
        .map(
          (v) =>
            `[${num(v.date)},${num(v.position)},${orNull(v.transitionTo)},${orNull(v.curvature)},` +
            `${orNull(v.protraction)},"${v.controller ?? 'sustain'}"]`,
        )
        .join(','),
    );
    out.push('],"sustain_cc":[');
    const s = sustainStream(data);
    // The MIDI observable, `Math.round(value)` — see the header note 2 on sustain_cc.
    out.push(s ? s.points.map((p) => `[${num(p.milliseconds)},${num(Math.round(p.value))}]`).join(',') : '');
    out.push(']');
    if (m.accentuation) {
      out.push(',"accentuation":{"length":', num(m.accentuation.length), ',"scale":', num(m.accentuation.scale), ',"anchors":[');
      out.push(m.accentuation.anchors.map((a) => `[${num(a.beat)},${num(a.value)},${num(a.from)},${num(a.to)}]`).join(','));
      out.push(']}');
    }
  }
  out.push('}');
  return out.join('');
}

// -------------------------------------------------------------------------------------------

export async function main(argv) {
  const opt = parseArgs(argv);
  if (opt.printDomain) {
    process.stdout.write(JSON.stringify(DOMAIN, null, 2) + '\n');
    return 0;
  }
  // `--maps` used to be matched with String.includes and never validated, so `--maps
  // tempo,dynamcs` ran to completion with an empty dynamicsMap and no warning — and because the
  // omitted map's draws are skipped, the RNG stream shifts too, so the result is not even
  // comparable to the intended run. Split, validate, reject.
  const named = opt.maps.split(',').map((s) => s.trim()).filter((s) => s.length);
  const unknown = named.filter((s) => !KNOWN_MAPS.includes(s));
  if (unknown.length)
    throw new Error(`--maps: unknown map name(s) ${unknown.join(', ')}; known: ${KNOWN_MAPS.join(', ')}`);
  if (!named.includes('tempo')) throw new Error('--maps: tempo is always rendered and must be listed');
  const has = (n) => named.includes(n);
  const want = {
    dynamics: has('dynamics'),
    articulation: has('articulation'),
    rubato: has('rubato'),
    asynchrony: has('asynchrony'),
    movement: has('movement'),
    accentuation: opt.accentuation,
  };
  if (opt.accentuation)
    process.stderr.write(
      'NOTE: --with-accentuation is on. TD3 has landed and both renderers agree bit-exactly on ' +
        'accentuated velocities at the state in ESPRESSIVO_DEFECTS (E3) — but shipping this as ' +
        'supervision data is a program decision, so re-confirm the gate before you do.\n',
    );

  if (opt.renderer !== 'espressivo' && opt.renderer !== 'java')
    throw new Error(`--renderer must be espressivo or java, got ${opt.renderer}`);
  if (!(opt.movementMaxStep > 0)) throw new Error(`--movement-max-step must be > 0, got ${opt.movementMaxStep}`);
  if (opt.renderer === 'java' && opt.movementMaxStep !== MOVEMENT_MAX_STEP_DEFAULT)
    // ml/java/RenderMpm never assigns meico's `MovementMap.movementSampleMaxStep` static, so
    // the java path always renders at 0.1. Accepting the flag here would silently produce a
    // dataset labelled with a step it was not rendered at, and make any cross-renderer check at
    // that step report a structural FAIL that looks like a logic divergence.
    throw new Error(
      `--movement-max-step ${opt.movementMaxStep} is espressivo-only: ml/java/RenderMpm does not ` +
        `set MovementMap.movementSampleMaxStep, so --renderer java would silently render at ` +
        `${MOVEMENT_MAX_STEP_DEFAULT}. Re-run with --renderer espressivo, or drop the flag.`,
    );
  if (opt.renderer === 'espressivo' && (want.articulation || want.dynamics))
    process.stderr.write(
      'WARNING: at the meico-ts state recorded in ESPRESSIVO_DEFECTS, espressivo renders ' +
        'articulation as the identity (E1) and ignores dynamics curvature/protraction (E2). ' +
        'Use --renderer java for correct labels, or re-check E1/E2 if meico-ts has moved.\n',
    );

  mkdirSync(dirname(opt.out), { recursive: true });
  if (opt.dumpDir) mkdirSync(opt.dumpDir, { recursive: true });
  const workDir = opt.dumpDir ?? (opt.renderer === 'java' ? mkdtempSync(join(tmpdir(), 'v4gen-')) : null);

  // 1. sample every piece and write the two documents both renderers consume
  const tSample0 = Date.now();
  const pieces = [];
  for (let i = 0; i < opt.n; i++) {
    const rng = new JavaRandom(opt.seed * 1000003n + BigInt(i));
    const piece = opt.v3compat ? samplePieceV3(rng, i, want) : samplePieceV4(rng, i, want, opt);
    if (opt.probeNoPow) {
      for (const t of piece.maps.tempo) {
        t.transitionTo = null;
        t.meanTempoAt = null;
      }
      piece.maps.rubato = [];
    }
    piece.docs = documentsFor(piece);
    pieces.push(piece);
    if (workDir) {
      writeFileSync(join(workDir, `piece${i}.msm`), piece.docs.msm);
      writeFileSync(join(workDir, `piece${i}.mpm`), piece.docs.mpm);
    }
  }
  const tSample = Date.now() - tSample0;

  // 2. render
  const tRender0 = Date.now();
  let renders;
  if (opt.renderer === 'java') {
    const manifest = pieces
      .map((p) => `${join(workDir, `piece${p.index}.msm`)}\t${join(workDir, `piece${p.index}.mpm`)}\t${join(workDir, `piece${p.index}_java.msm`)}`)
      .join('\n');
    writeFileSync(join(workDir, 'manifest.tsv'), manifest + '\n');
    execFileSync('nice', ['-n', '15', 'java', '-cp', JAVA_CP, 'RenderMpm', '--batch', join(workDir, 'manifest.tsv')], {
      stdio: ['ignore', 'ignore', 'pipe'],
      maxBuffer: 1 << 28,
    });
    renders = pieces.map((p) => readAugmentedMsm(readFileSync(join(workDir, `piece${p.index}_java.msm`), 'utf8')));
  } else {
    const { performMsmToData } = await import(ESPRESSIVO);
    const captured = captureConsole(() =>
      pieces.map((p) => performMsmToData(p.docs, { movementSampleMaxStep: opt.movementMaxStep })),
    );
    renders = captured.value;
    const { progress, unexpected } = summarizeMessages(captured.messages);
    if (unexpected.length)
      process.stderr.write(
        `WARNING: espressivo emitted ${unexpected.reduce((s, u) => s + u[1], 0)} UNRECOGNISED console ` +
          `message(s) during rendering, ${unexpected.length} distinct:\n` +
          unexpected.slice(0, 10).map(([t, n]) => `  ${n}x ${t}\n`).join('') +
          (unexpected.length > 10 ? `  … ${unexpected.length - 10} more\n` : ''),
      );
    else if (progress) process.stderr.write(`espressivo: ${progress} progress message(s), all recognised.\n`);
  }
  const tRender = Date.now() - tRender0;

  // 3. emit
  const sink = createWriteStream(opt.out);
  let notes = 0;
  let ccPoints = 0;
  for (let i = 0; i < pieces.length; i++) {
    for (const p of renders[i].parts) {
      notes += p.notes.length;
      for (const s of p.controlChanges) ccPoints += s.points.length;
    }
    if (!sink.write(pieceToJsonl(pieces[i], renders[i], opt.v3compat, { renderer: opt.renderer, seed: Number(opt.seed) }) + '\n'))
      await new Promise((r) => sink.once('drain', r));
  }
  await new Promise((r) => sink.end(r));
  if (!opt.dumpDir && workDir) rmSync(workDir, { recursive: true, force: true });

  const ms = tSample + tRender;
  process.stdout.write(
    `Done: ${opt.n} pieces, ${notes} notes, ${ccPoints} CC points via ${opt.renderer} in ${ms} ms ` +
      `(sample ${tSample} ms + render ${tRender} ms; ${(ms / opt.n).toFixed(2)} ms/piece, ` +
      `${((opt.n * 1000) / ms).toFixed(1)} pieces/s) -> ${opt.out}\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
