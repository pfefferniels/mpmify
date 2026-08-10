#!/usr/bin/env node
/**
 * Step 4: real score + era-conditioned canonical MPM -> rendered v4-schema JSONL.
 *
 *   nice -n 15 node generate_corpus.mjs ../data/corpus_pilot_v4.jsonl [options]
 *
 * Options
 *   --data d              corpus directory (default ../data/corpus_pilot)
 *   --seed n              base seed; a window's stream is `seed*1000003 + globalIndex`,
 *                         the same derivation `generate_v4.mjs` uses (CANONICAL G9)
 *   --window-beats a,b    window length bounds in beats (default 24,64)
 *   --min-notes n         skip a window with fewer notes (default 12)
 *   --max-parts n         fold parts beyond this into the last one (default 2; see compactParts)
 *   --renderer r          espressivo (default, the T13 facade) | java (the fork)
 *   --imprecision         ALSO write `<out>.imprecision.jsonl`: the same interpretations
 *                         plus a seeded `imprecisionMap.timing`, rendered again
 *   --dump-dir d          write `piece<id>.msm` / `piece<id>.mpm`, the inputs
 *                         `ml/node/verify_v4.mjs cross` consumes
 *   --only id...          restrict to these piece ids
 *
 * ## Schema
 *
 * The line is produced by `ml/node/generate_v4.mjs::pieceToJsonl` — the *same function* the
 * synthetic generator uses, so the two corpora cannot drift apart in schema — and then four
 * provenance fields are appended by string surgery on the closing brace, which is why the
 * shared part of the line is byte-identical rather than merely equivalent:
 *
 *   "era"        baroque | classical | romantic
 *   "piece_id"   the manifest id of the source movement
 *   "window"     0-based window index within that movement
 *   "window_ticks" [startTick, lengthTicks] in the source movement's own tick frame
 *   "build"      the renderer builds that produced this line — see `provenance.mjs`. The
 *                shared `renderer` field names a program; this names a *build*, including a
 *                fingerprint of espressivo's `dist/` tree, which git does not track and which
 *                moves independently of its commit. Carried per record rather than only in
 *                the sidecar so that one line torn out of the file is still self-describing.
 *
 * and, in the imprecision variant, one more:
 *
 *   "imprecision" {"map":"timing","distribution":"gaussian","sigma_ms":…,"limit_ms":…,
 *                  "timing_basis_ms":…,"seed":…}
 *
 * That object is the **target** for this band. The per-note offsets are a *sample* from the
 * distribution; asking a model to reproduce them is asking it to reproduce a random number
 * generator. CANONICAL §13.4 and the study both put imprecision's supervision at the level of
 * distribution parameters.
 *
 * ## Reproducibility — which output, exactly
 *
 * The **base** file regenerates byte-identically: the score partition is seed-independent, the
 * sampler is a seeded `JavaRandom`, and espressivo's render of a fixed (MSM, MPM) pair is
 * deterministic. The run prints the sha256 of what it wrote and `repro_check.mjs` gates it.
 *
 * The **imprecision variant does not**, and the earlier version of this file implied it did by
 * saying "the seed is recorded as provenance so a render can be repeated". It cannot be, on
 * this repertoire: espressivo's shake layer breaks ties between events sharing a millisecond
 * date with an *unseeded* `Math.random()` (`probe_imprecision.mjs`, README §5), and 75.6 % of
 * the pilot's notes share such a date. Re-running this command reproduces the base file
 * exactly and produces a *different* variant: 58/58 lines differ, ~62 % of onsets move, up to
 * ~21 ms. The maps, the distribution parameters and the seed are stable — everything that is a
 * training target — and only the rendered milliseconds move. The variant that is on disk is
 * therefore the artefact; the command is not a recipe for it.
 *
 * ## Windows
 *
 * Movements are 48-272 beats; the model's target budget is 448 DSL tokens (LOG.md). So each
 * movement is tiled into windows of a whole number of bar-groups, deterministically — the
 * window layout does not depend on the seed, only the interpretation does, so re-sampling a
 * corpus at a new seed keeps the score partition fixed and changes one variable.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';

import { captureConsole, pieceToJsonl } from '../node/generate_v4.mjs';
import { JavaRandom } from '../node/java_random.mjs';
import { ESPRESSIVO, JAVA_CP } from '../node/paths.mjs';
import { readAugmentedMsm } from '../node/augmented_msm.mjs';
import { buildMpm } from '../node/xml.mjs';
import { PPQ, barGroupTicks, buildImprecisionTimingXml, sampleEraPerformance, ERA_RANGES } from './era_sampler.mjs';
import { buildTag, corpusProvenance, verovioVersion } from './provenance.mjs';
import { buildScoreMsm, parseMsm, windowScore } from './score_msm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const o = {
    out: null,
    data: resolve(HERE, '../data/corpus_pilot'),
    seed: 20260810,
    windowBeats: [24, 64],
    minNotes: 12,
    renderer: 'espressivo',
    maxParts: 2,
    imprecision: false,
    dumpDir: null,
    only: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') && o.out === null) o.out = resolve(a);
    else if (a === '--data') o.data = resolve(argv[++i]);
    else if (a === '--seed') o.seed = Number(argv[++i]);
    else if (a === '--window-beats') o.windowBeats = argv[++i].split(',').map(Number);
    else if (a === '--min-notes') o.minNotes = Number(argv[++i]);
    else if (a === '--max-parts') o.maxParts = Number(argv[++i]);
    else if (a === '--renderer') o.renderer = argv[++i];
    else if (a === '--imprecision') o.imprecision = true;
    else if (a === '--dump-dir') o.dumpDir = resolve(argv[++i]);
    else if (a === '--only') {
      o.only = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o.only.push(argv[++i]);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!o.out) throw new Error('usage: generate_corpus.mjs <out.jsonl> [options]');
  if (o.renderer !== 'espressivo' && o.renderer !== 'java')
    throw new Error(`--renderer must be espressivo or java, got ${o.renderer}`);
  return o;
}

/**
 * Deterministic window layout for one movement: `[{start, length}]` in ticks.
 *
 * Windows are a whole number of bar-groups (so every window starts on a bar line and its
 * length is a whole number of beats, which G4 requires of every map date inside it). The
 * length is the largest group multiple that fits `maxBeats`; the tail is dropped when it
 * would be shorter than `minBeats`, because a 3-beat window cannot carry a 4-beat minimum
 * segment (T1/D1) and would be a piece with exactly one instruction per map.
 */
export function planWindows(totalTicks, measureTicks, minBeats, maxBeats) {
  const group = barGroupTicks(measureTicks);
  const mult = Math.max(1, Math.floor((maxBeats * PPQ) / group));
  const len = mult * group;
  const out = [];
  for (let start = 0; start + len <= totalTicks; start += len) out.push({ start, length: len });
  const rest = totalTicks - out.length * len;
  if (rest >= minBeats * PPQ) {
    // Trim the tail to a whole number of groups so it, too, is bar- and beat-aligned.
    const tail = Math.floor(rest / group) * group;
    if (tail >= minBeats * PPQ) out.push({ start: out.length * len, length: tail });
  }
  return out;
}

/**
 * Drop parts with no notes in this window, renumber 1..k preserving register order, and fold
 * everything below part `maxParts` into the last one.
 *
 * The fold is not cosmetic. CANONICAL Y1 names **part 2** as the only place an asynchronyMap
 * may live, `dataset.piece_to_features_v4` spells its `part` feature as "0 for part 1, 1 for
 * any other part", and `ml/node/verify_v4.mjs invariants` rejects a note whose part is neither
 * 1 nor 2 — so three parts is outside the representation, not merely unusual in it. It arises
 * because the CCARH Well-Tempered Clavier encodings put a fugue on three Humdrum spines, which
 * Verovio renders as three staves; folding voices 2 and 3 onto one MSM part is what a pianist's
 * left hand does with them anyway. Reported per window as `foldedParts`.
 */
function compactParts(parts, maxParts) {
  const live = parts.filter((p) => p.notes.length).map((p, i) => ({ ...p, number: i + 1 }));
  if (live.length <= maxParts) return { parts: live, folded: 0 };
  const keep = live.slice(0, maxParts - 1);
  const rest = live.slice(maxParts - 1);
  const merged = {
    ...rest[0],
    number: maxParts,
    name: rest.map((p) => p.name || `part${p.number}`).join('+'),
    notes: rest.flatMap((p) => p.notes).sort((a, b) => a.date - b.date || a.pitch - b.pitch),
  };
  return { parts: [...keep, merged], folded: rest.length - 1 };
}

export async function main(argv) {
  const opt = parseArgs(argv);
  const index = JSON.parse(readFileSync(join(opt.data, 'msm', 'index.json'), 'utf8'));
  const workDir = opt.dumpDir ?? (opt.renderer === 'java' ? mkdtempSync(join(tmpdir(), 'corpusgen-')) : null);
  if (workDir) mkdirSync(workDir, { recursive: true });
  mkdirSync(dirname(opt.out), { recursive: true });

  // ---- 1. sample every window ------------------------------------------------------------
  const pieces = [];
  const skipped = [];
  for (const meta of index.pieces) {
    if (opt.only && !opt.only.includes(meta.id)) continue;
    const msmPath = join(opt.data, 'msm', `${meta.id}.msm`);
    if (!existsSync(msmPath)) throw new Error(`${meta.id}: no MSM — run build_msm.mjs first`);
    const score = parseMsm(readFileSync(msmPath, 'utf8'));
    const totalTicks = Math.max(...score.parts.flatMap((p) => p.notes.map((n) => n.date + n.dur)));
    const plan = planWindows(totalTicks, meta.measureTicks, opt.windowBeats[0], opt.windowBeats[1]);

    plan.forEach((w, wi) => {
      const { parts, folded } = compactParts(windowScore(score.parts, w.start, w.length), opt.maxParts);
      const n = parts.reduce((s, p) => s + p.notes.length, 0);
      if (n < opt.minNotes || !parts.length) {
        skipped.push({ id: meta.id, window: wi, notes: n });
        return;
      }
      const globalIndex = pieces.length;
      const rng = new JavaRandom(BigInt(opt.seed) * 1000003n + BigInt(globalIndex));
      const perf = sampleEraPerformance(
        rng,
        { parts, totalTicks: w.length, measureTicks: meta.measureTicks },
        meta.era,
      );
      const piece = {
        index: globalIndex,
        totalTicks: w.length,
        parts: perf.parts,
        maps: perf.maps,
        // provenance, not schema
        era: meta.era,
        pieceId: meta.id,
        window: wi,
        windowTicks: [w.start, w.length],
        sampleMeta: { ...perf.meta, foldedParts: folded },
        imprecision: null,
      };
      if (opt.imprecision) {
        const r = ERA_RANGES[meta.era].imprecision.sigmaMs;
        const sigma = Math.round((r[0] + rng.nextDouble() * (r[1] - r[0])) * 10) / 10;
        piece.imprecision = {
          map: 'timing',
          distribution: 'gaussian',
          sigma_ms: sigma,
          limit_ms: Math.round(3 * sigma * 10) / 10,
          timing_basis_ms: 200,
          seed: opt.seed + globalIndex,
        };
      }
      pieces.push(piece);
    });
  }
  if (!pieces.length) throw new Error('no windows survived: check --window-beats / --min-notes');

  // ---- 2. documents ----------------------------------------------------------------------
  for (const p of pieces) {
    const msm = buildScoreMsm(`${p.pieceId}#${p.window}`, `${p.pieceId}-w${p.window}`, p.parts, null);
    const mpmBase = buildMpm('perf', PPQ, p.maps, p.parts);
    p.docs = { msm, mpm: mpmBase };
    if (p.imprecision) {
      const imp = buildImprecisionTimingXml({
        sigma: p.imprecision.sigma_ms,
        seed: p.imprecision.seed,
        limit: p.imprecision.limit_ms,
        timingBasis: p.imprecision.timing_basis_ms,
      });
      // One deterministic insertion point, asserted: the global `<dated>` close. A silent
      // no-op replacement here would produce an "imprecision" set with no imprecision in it.
      const marker = '</dated></global>';
      const at = mpmBase.indexOf(marker);
      if (at < 0 || mpmBase.indexOf(marker, at + 1) >= 0)
        throw new Error(`${p.pieceId}#${p.window}: expected exactly one ${marker} in the MPM`);
      p.docsImp = { msm, mpm: mpmBase.slice(0, at) + imp + mpmBase.slice(at) };
    }
    if (workDir) {
      writeFileSync(join(workDir, `piece${p.index}.msm`), msm);
      writeFileSync(join(workDir, `piece${p.index}.mpm`), mpmBase);
      if (p.docsImp) writeFileSync(join(workDir, `piece${p.index}_imp.mpm`), p.docsImp.mpm);
    }
  }

  // ---- 3. render -------------------------------------------------------------------------
  const renderAll = async (docsKey) => {
    if (opt.renderer === 'java') {
      const suffix = docsKey === 'docs' ? '' : '_imp';
      const manifest = pieces
        .map((p) => {
          const mpmPath = join(workDir, `piece${p.index}${suffix}.mpm`);
          if (docsKey !== 'docs') writeFileSync(mpmPath, p[docsKey].mpm);
          return `${join(workDir, `piece${p.index}.msm`)}\t${mpmPath}\t${join(workDir, `piece${p.index}${suffix}_java.msm`)}`;
        })
        .join('\n');
      writeFileSync(join(workDir, `manifest${suffix}.tsv`), manifest + '\n');
      execFileSync('nice', ['-n', '15', 'java', '-cp', JAVA_CP, 'RenderMpm', '--batch', join(workDir, `manifest${suffix}.tsv`)], {
        stdio: ['ignore', 'ignore', 'pipe'],
        maxBuffer: 1 << 28,
      });
      return pieces.map((p) => readAugmentedMsm(readFileSync(join(workDir, `piece${p.index}${suffix}_java.msm`), 'utf8')));
    }
    const { performMsmToData } = await import(ESPRESSIVO);
    return captureConsole(() => pieces.map((p) => performMsmToData(p[docsKey]))).value;
  };

  const t0 = Date.now();
  const renders = await renderAll('docs');
  const renderMs = Date.now() - t0;
  const rendersImp = opt.imprecision ? await renderAll('docsImp') : null;

  // ---- 4. emit ---------------------------------------------------------------------------
  const provenance = { renderer: opt.renderer, seed: opt.seed };
  const build = corpusProvenance({ verovio: verovioVersion(opt.data) });
  const buildStr = buildTag(build);
  /** `pieceToJsonl` + the corpus provenance fields, appended on the closing brace. */
  const line = (p, data, imp) => {
    const base = pieceToJsonl(p, data, false, provenance);
    const extra =
      `,"era":"${p.era}","piece_id":"${p.pieceId}","window":${p.window},` +
      `"window_ticks":[${p.windowTicks[0]},${p.windowTicks[1]}],"build":${JSON.stringify(buildStr)}` +
      (imp ? `,"imprecision":${JSON.stringify(p.imprecision)}` : '');
    return base.slice(0, -1) + extra + '}';
  };

  const write = async (path, data, imp) => {
    const sink = createWriteStream(path);
    for (let i = 0; i < pieces.length; i++)
      if (!sink.write(line(pieces[i], data[i], imp) + '\n')) await new Promise((r) => sink.once('drain', r));
    await new Promise((r) => sink.end(r));
  };
  const impPath = opt.out.replace(/\.jsonl$/, '') + '.imprecision.jsonl';
  await write(opt.out, renders, false);
  if (rendersImp) await write(impPath, rendersImp, true);

  // ---- 5. report -------------------------------------------------------------------------
  const byEra = {};
  for (const p of pieces) {
    const e = (byEra[p.era] ??= { windows: 0, notes: 0, pieces: new Set() });
    e.windows++;
    e.pieces.add(p.pieceId);
    e.notes += p.parts.reduce((s, q) => s + q.notes.length, 0);
  }
  // Each output's sha256, with a per-file reproducibility claim spelled out next to it. The
  // claim is not decoration: `repro_check.mjs` re-runs this command and holds the base file to
  // `reproducible: true` as a gate, while `false` is what makes the variant's stored bytes —
  // rather than this command line — the artefact. See the header.
  const outputs = [
    {
      path: opt.out,
      sha256: createHash('sha256').update(readFileSync(opt.out)).digest('hex'),
      reproducible: true,
      note: 'seeded sampler + deterministic render of a fixed (MSM, MPM) pair',
    },
  ];
  if (rendersImp)
    outputs.push({
      path: impPath,
      sha256: createHash('sha256').update(readFileSync(impPath)).digest('hex'),
      reproducible: false,
      note:
        "espressivo's shake layer breaks same-millisecond ties with an unseeded Math.random(); " +
        'maps, distribution parameters and seed are stable, rendered milliseconds are not. ' +
        'Keep this file, not this command.',
    });
  const summary = {
    out: opt.out,
    renderer: opt.renderer,
    seed: opt.seed,
    build: buildStr,
    provenance: build,
    windows: pieces.length,
    windowBeats: opt.windowBeats,
    skipped,
    outputs,
    byEra: Object.fromEntries(
      Object.entries(byEra).map(([k, v]) => [k, { movements: v.pieces.size, windows: v.windows, notes: v.notes }]),
    ),
  };
  writeFileSync(opt.out.replace(/\.jsonl$/, '') + '.summary.json', JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(
    Object.entries(summary.byEra)
      .map(([e, v]) => `${e}: ${v.movements} movements, ${v.windows} windows, ${v.notes} notes\n`)
      .join('') +
      `total ${pieces.length} windows, ${skipped.length} skipped (< ${opt.minNotes} notes), ` +
      `rendered by ${opt.renderer} in ${renderMs} ms\n` +
      `build: ${buildStr}\n` +
      outputs
        .map(
          (o) =>
            `${o.reproducible ? 'REPRODUCIBLE    ' : 'NOT REPRODUCIBLE'} ${o.sha256.slice(0, 16)}… ${o.path}\n` +
            (o.reproducible ? '' : `                 ${o.note}\n`),
        )
        .join(''),
  );
  if (!opt.dumpDir && workDir) rmSync(workDir, { recursive: true, force: true });
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
