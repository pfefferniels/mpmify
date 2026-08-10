#!/usr/bin/env node
/**
 * Does the corpus regenerate? Measured per output file, not claimed for the command.
 *
 *   nice -n 15 node repro_check.mjs [--data ../data/corpus_pilot] [--ref ../data/corpus_pilot_v4.jsonl]
 *                                   [--seed n] [--work <dir>] [--keep]
 *
 * ### Why this exists
 *
 * The delivery said "regeneration is byte-identical (verified by sha256)" under a command line
 * that writes **two** files, and only one of them reproduces. The base corpus does; the
 * `--imprecision` variant does not, because espressivo's shake layer breaks ties between
 * events sharing a millisecond date with an unseeded `Math.random()` (`probe_imprecision.mjs`,
 * `README.md` §5) and piano music is chords. The claim was true of the file the author
 * happened to check and false of the other, which is exactly the shape of an unscoped claim.
 *
 * So the claim is now a program. This script regenerates the corpus into a scratch directory
 * and reports, per output:
 *
 *  * **base** — must be byte-identical to the reference, twice over: to the stored corpus, and
 *    between the two fresh runs. A difference is a hard failure (`REPRO_FAIL`), because a
 *    corpus that does not regenerate cannot be re-derived from its inputs at all.
 *  * **imprecision variant** — expected to differ, and the *extent* of the difference is
 *    reported rather than the fact of it: how many lines, how many onsets, the largest
 *    millisecond shift, and — the part that matters — whether the six canonical maps, the
 *    distribution parameters and the seed are identical across runs. Those are the training
 *    targets; if they moved, the variant would be unusable and this would be a failure too.
 *    A variant that unexpectedly *did* reproduce is reported as a surprise, not as a pass:
 *    it would mean the renderer changed underneath the finding.
 *
 * Two runs rather than one because "differs from the stored file" and "differs from itself"
 * are different diagnoses: the first can be a stale artefact, only the second is nondeterminism.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const impOf = (p) => p.replace(/\.jsonl$/, '') + '.imprecision.jsonl';

function parseArgs(argv) {
  const o = {
    data: resolve(HERE, '../data/corpus_pilot'),
    ref: resolve(HERE, '../data/corpus_pilot_v4.jsonl'),
    seed: null,
    work: null,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data') o.data = resolve(argv[++i]);
    else if (a === '--ref') o.ref = resolve(argv[++i]);
    else if (a === '--seed') o.seed = Number(argv[++i]);
    else if (a === '--work') o.work = resolve(argv[++i]);
    else if (a === '--keep') o.keep = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function generate(out, data, seed) {
  const args = ['-n', '15', 'node', join(HERE, 'generate_corpus.mjs'), out, '--data', data, '--imprecision'];
  if (seed !== null) args.push('--seed', String(seed));
  execFileSync('nice', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] });
}

const load = (p) => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

/**
 * How far apart two renders of the same interpretations are.
 *
 * `maps` covers everything a model is trained on — the six canonical maps, the sustain CC
 * trace and the imprecision distribution parameters — and must be equal. `onsets` and
 * `maxDeltaMs` describe the rendered milliseconds, which are the sample and may move.
 */
function compareRenders(a, b) {
  const MAPS = ['tempo', 'dynamics', 'rubato', 'asynchrony', 'articulation', 'movement', 'sustain_cc', 'imprecision'];
  let lines = 0;
  let onsets = 0;
  let notes = 0;
  let maxDelta = 0;
  const mapDiffs = [];
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) lines++;
    for (const k of MAPS)
      if (JSON.stringify(a[i][k] ?? null) !== JSON.stringify(b[i][k] ?? null))
        mapDiffs.push(`${a[i].piece_id}#${a[i].window}: ${k}`);
    for (let j = 0; j < a[i].notes.length; j++) {
      notes++;
      const d = Math.abs(a[i].notes[j][3] - b[i].notes[j][3]);
      if (!Object.is(a[i].notes[j][3], b[i].notes[j][3])) onsets++;
      maxDelta = Math.max(maxDelta, d);
    }
  }
  return { lines, onsets, notes, maxDelta, mapDiffs };
}

export function main(argv) {
  const opt = parseArgs(argv);
  const work = opt.work ?? mkdtempSync(join(tmpdir(), 'repro-'));
  const outs = [join(work, 'run1.jsonl'), join(work, 'run2.jsonl')];
  process.stdout.write(`regenerating twice into ${work}\n`);
  for (const o of outs) generate(o, opt.data, opt.seed);

  let failed = 0;
  // --- base ---------------------------------------------------------------------------------
  const h1 = sha256(outs[0]);
  const h2 = sha256(outs[1]);
  const hRef = existsSync(opt.ref) ? sha256(opt.ref) : null;
  const selfSame = h1 === h2;
  const refSame = hRef !== null && h1 === hRef;
  process.stdout.write(
    `\n--- base corpus\n` +
      `  run 1     ${h1}\n  run 2     ${h2}\n` +
      `  reference ${hRef ?? '(absent)'} ${opt.ref}\n` +
      `  run1 == run2      ${selfSame ? 'yes' : 'NO — the generator is nondeterministic'}\n` +
      `  run1 == reference ${hRef === null ? 'n/a' : refSame ? 'yes' : 'NO — the stored corpus is not what this code produces'}\n`,
  );
  if (!selfSame) failed = 1;
  if (hRef !== null && !refSame) failed = 1;

  // --- imprecision variant -------------------------------------------------------------------
  const i1 = impOf(outs[0]);
  const i2 = impOf(outs[1]);
  if (existsSync(i1) && existsSync(i2)) {
    const same = sha256(i1) === sha256(i2);
    const cmp = compareRenders(load(i1), load(i2));
    process.stdout.write(
      `\n--- imprecision variant (expected NOT to reproduce)\n` +
        `  run 1     ${sha256(i1)}\n  run 2     ${sha256(i2)}\n` +
        `  identical ${same ? 'YES — SURPRISE: the renderer no longer randomises; re-check probe_imprecision.mjs' : 'no, as expected'}\n` +
        `  lines differing        ${cmp.lines}/${load(i1).length}\n` +
        `  note onsets differing  ${cmp.onsets}/${cmp.notes} (${((100 * cmp.onsets) / cmp.notes).toFixed(1)} %)\n` +
        `  largest onset shift    ${cmp.maxDelta.toFixed(3)} ms\n` +
        `  training targets (6 maps + sustain_cc + distribution parameters) differing: ${cmp.mapDiffs.length}\n`,
    );
    // The targets moving is the failure; the milliseconds moving is the finding.
    if (cmp.mapDiffs.length) {
      failed = 1;
      for (const d of cmp.mapDiffs.slice(0, 10)) process.stdout.write(`    ${d}\n`);
    }
    const refImp = impOf(opt.ref);
    if (existsSync(refImp)) {
      const c = compareRenders(load(i1), load(refImp));
      process.stdout.write(
        `  vs the stored variant: ${c.lines} lines, ${c.onsets}/${c.notes} onsets, max ${c.maxDelta.toFixed(3)} ms, ` +
          `${c.mapDiffs.length} target differences\n`,
      );
      if (c.mapDiffs.length) failed = 1;
    }
  }

  if (!opt.keep && !opt.work) rmSync(work, { recursive: true, force: true });
  process.stdout.write(`\n${failed ? 'REPRO_FAIL' : 'REPRO_PASS'}\n`);
  return failed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
