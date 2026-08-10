#!/usr/bin/env node
/**
 * Determinism probe for the NEW map: `imprecisionMap.timing` with a seeded Gaussian.
 *
 *   nice -n 15 node probe_imprecision.mjs [<msmPath> ...]
 *
 * SYSTEM.md v1.1 wants seeded imprecision with *distribution parameters* as the target. Both
 * halves of that need this measurement first, because a seeded render that is not reproducible
 * cannot be a training pair at all, and the facade says so in as many words:
 *
 *   > **This is not a promise of reproducible output.** Where two imprecision offsets land on
 *   > the same `milliseconds.date`, the interior picks which one keeps its value with a bare
 *   > `Math.random()` and re-rolls the rest through an unseeded generator — faithfully, from
 *   > `ImprecisionMap.java:845,894`. A seeded render is reproducible only while no two offsets
 *   > share a date, which for polyphonic input is often false.   (dist/api/types.d.ts)
 *
 * A *seed attribute in the MPM* wins over `PerformOptions.seed` (`ImprecisionMap.ts:352`), but
 * it seeds the distribution's own provider only — the shake layer's two `Math.random()` calls
 * (`shakeTimingOffsets:554`, `shake()`'s unseeded triangular provider) are outside every seed
 * this API exposes. So the question is empirical: on *real piano repertoire*, which is
 * polyphonic almost everywhere, how much of a seeded render actually reproduces?
 *
 * One subtlety in reading the "shares a ms date" column: the offsets map is keyed by
 * millisecond date and holds note **ends** as well as note starts (`pendingDurations`, same
 * method), so a note whose onset coincides with some other note's *offset* is also in a group
 * of two and also gets shaken. That is why the reproducing count comes out below the
 * not-shared count rather than equal to it.
 *
 * The probe renders each score twice with the same seed and once with a different seed, and
 * reports per-note onset agreement. It prints one of three verdicts:
 *
 *   IMPRECISION_DETERMINISTIC      same seed -> bit-identical onsets, different seed -> differs
 *   IMPRECISION_PARTIAL            same seed -> a documented fraction differs (the shake layer)
 *   IMPRECISION_NONDETERMINISTIC   same seed -> the offsets do not reproduce at all
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESPRESSIVO } from '../node/paths.mjs';
import { buildImprecisionTimingXml } from './era_sampler.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A minimal MPM: one constant tempo plus the imprecision map under test. Nothing else. */
function probeMpm(parts, sigma, seed) {
  const imp = buildImprecisionTimingXml({ sigma, seed, limit: 3 * sigma, timingBasis: 200 });
  return (
    '<?xml version="1.0"?>\n<mpm xmlns="http://www.cemfi.de/mpm/ns/1.0">' +
    '<performance name="probe" pulsesPerQuarter="720"><global><header /><dated>' +
    '<tempoMap><tempo date="0.0" bpm="90" beatLength="0.25" /></tempoMap>' +
    imp +
    '</dated></global>' +
    parts.map((n) => `<part name="p${n}" number="${n}" midi.channel="${n - 1}" midi.port="0"><header /><dated /></part>`).join('') +
    '</performance></mpm>'
  );
}

const onsets = (data) => data.parts.flatMap((p) => p.notes.map((n) => n.milliseconds.date));

function quiet(fn) {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

export async function main(argv) {
  const { performMsmToData } = await import(ESPRESSIVO);
  const paths = argv.length
    ? argv.map((p) => resolve(p))
    : ['romantic-chopin-op28-07', 'classical-mozart-k331-1a', 'baroque-bach-wtc1p09'].map((id) =>
        join(HERE, '../data/corpus_pilot/msm', `${id}.msm`),
      );

  const rows = [];
  for (const path of paths) {
    const msm = readFileSync(path, 'utf8');
    const partNums = [...msm.matchAll(/<part [^>]*number="(\d+)"/g)].map((m) => Number(m[1]));
    const sigma = 18;
    const a = quiet(() => performMsmToData({ msm, mpm: probeMpm(partNums, sigma, 20260810) }));
    const b = quiet(() => performMsmToData({ msm, mpm: probeMpm(partNums, sigma, 20260810) }));
    const c = quiet(() => performMsmToData({ msm, mpm: probeMpm(partNums, sigma, 20260811) }));
    const base = quiet(() => performMsmToData({ msm, mpm: probeMpm(partNums, sigma, null) }));

    const [oa, ob, oc] = [onsets(a), onsets(b), onsets(c)];
    const same = oa.filter((v, i) => Object.is(v, ob[i])).length;
    const across = oa.filter((v, i) => Object.is(v, oc[i])).length;
    // How many notes share a millisecond date with another note *before* imprecision: the
    // population the shake layer can touch. Measured on the unseeded/no-imprecision render.
    const plain = quiet(() => performMsmToData({ msm, mpm: probeMpm(partNums, 0, 1) }));
    const counts = new Map();
    for (const v of onsets(plain)) counts.set(v, (counts.get(v) ?? 0) + 1);
    const shared = onsets(plain).filter((v) => counts.get(v) > 1).length;

    rows.push({
      file: path.split('/').pop(),
      notes: oa.length,
      sameSeedIdentical: same,
      diffSeedIdentical: across,
      sharedMsDates: shared,
      unseededDiffers: onsets(base).filter((v, i) => !Object.is(v, oa[i])).length,
    });
    process.stdout.write(
      `${rows.at(-1).file.padEnd(34)} notes ${String(oa.length).padStart(5)} | same seed identical ` +
        `${same}/${oa.length} | different seed identical ${across}/${oa.length} | ` +
        `notes sharing a ms date pre-imprecision ${shared}\n`,
    );
  }

  const total = rows.reduce((s, r) => s + r.notes, 0);
  const same = rows.reduce((s, r) => s + r.sameSeedIdentical, 0);
  const across = rows.reduce((s, r) => s + r.diffSeedIdentical, 0);
  const shared = rows.reduce((s, r) => s + r.sharedMsDates, 0);
  const verdict =
    same === total ? 'IMPRECISION_DETERMINISTIC' : same > 0 ? 'IMPRECISION_PARTIAL' : 'IMPRECISION_NONDETERMINISTIC';
  process.stdout.write(
    `\ntotal ${total} notes | same-seed identical ${same} (${((100 * same) / total).toFixed(1)} %) | ` +
      `different-seed identical ${across} (${((100 * across) / total).toFixed(1)} %) | ` +
      `polyphonic (shared ms date) ${shared} (${((100 * shared) / total).toFixed(1)} %)\n${verdict}\n`,
  );
  return verdict === 'IMPRECISION_NONDETERMINISTIC' ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
