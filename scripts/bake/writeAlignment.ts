/**
 * Regenerate `test/fixtures/roundtrip/alignment.*` from `traeumerei.mei`.
 *
 *     npx vite-node scripts/bake/writeAlignment.ts           # verify, then write
 *     npx vite-node scripts/bake/writeAlignment.ts --check   # verify only
 *
 * `asMSM` is the only reader of the MEI's private alignment vocabulary, which is why the
 * fixture has to be cut here. Nothing is written unless the triple reads back as the alignment
 * it was built from, note for note and pedal for pedal.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { convertMeiToMsm, prettyXml } from 'espressivo';
import type { Alignment } from '../../src/alignment/index.js';
import {
  deserializeAlignment,
  serializeAlignment,
  type AlignmentFixture,
} from '../../test/roundtrip/alignmentFixture.js';

const lengths = (what: string, expected: number, actual: number): string[] =>
  expected === actual ? [] : [`${what}: ${String(expected)} vs ${String(actual)}`];

const compare = (expected: object, actual: object, where: string): string[] => {
  const left = new Map(Object.entries(expected));
  const right = new Map(Object.entries(actual));
  const problems: string[] = [];

  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a: unknown = left.get(key);
    const b: unknown = right.get(key);
    if (!Object.is(a, b)) problems.push(`${where}: ${key} is ${String(b)}, should be ${String(a)}`);
  }
  return problems;
};

/**
 * Every difference between two alignments, over the union of the keys their notes carry — so an
 * attribute one side has and the other does not is a difference, not something to look past.
 */
const differences = (expected: Alignment, actual: Alignment): string[] => {
  const problems: string[] = [];

  const left = JSON.stringify(expected.timeSignature);
  const right = JSON.stringify(actual.timeSignature);
  if (left !== right) problems.push(`time signature: ${left} vs ${right}`);

  problems.push(...lengths('notes', expected.allNotes.length, actual.allNotes.length));
  problems.push(...lengths('pedals', expected.pedals.length, actual.pedals.length));
  if (problems.length > 0) return problems;

  expected.allNotes.forEach((note, index) => {
    problems.push(...compare(note, actual.allNotes[index], `note ${String(index)}`));
  });
  expected.pedals.forEach((pedal, index) => {
    problems.push(...compare(pedal, actual.pedals[index], `pedal ${String(index)}`));
  });

  return problems;
};

// `asMSM` reads the MEI with the browser's parser; nothing else here needs a DOM.
const { window } = new JSDOM();
globalThis.DOMParser = window.DOMParser;

const { asMSM } = await import('./asMSM.js');

const fixtures = fileURLToPath(new URL('../../test/fixtures/roundtrip/', import.meta.url));
const mei = readFileSync(`${fixtures}traeumerei.mei`, 'utf-8');
const movements = convertMeiToMsm(mei);
if (!movements.length) throw new Error('MEI holds no convertible movement');

const built = asMSM(mei, movements[0].msm);
// `writeMsm` puts the whole document on one line; the fixture is read by people too. The
// verification below runs on the indented text, so it covers what actually lands on disk.
const raw = serializeAlignment(built);
const fixture: AlignmentFixture = { ...raw, msm: prettyXml(raw.msm) };
const reread = deserializeAlignment(fixture);
const problems = differences(built, reread);

const ids = new Set(built.allNotes.map((note) => note['xml:id'])).size;
const meter = `${String(built.timeSignature?.numerator)}/${String(built.timeSignature?.denominator)}`;
console.log(
  `${String(built.allNotes.length)} notes under ${String(ids)} distinct ids, ` +
    `${String(built.pedals.length)} pedals, time signature ${meter}`,
);
console.log(
  problems.length === 0
    ? 'the triple reads back identical to what asMSM built'
    : `${String(problems.length)} differences:\n  ${problems.join('\n  ')}`,
);
if (problems.length > 0) process.exit(1);
if (process.argv.includes('--check')) process.exit(0);

const files: [string, string][] = [
  ['alignment.msm', `${fixture.msm.trimEnd()}\n`],
  ['alignment.pedals.json', `${JSON.stringify(fixture.pedals, null, 2)}\n`],
  ['alignment.sources.json', `${JSON.stringify(fixture.sources, null, 2)}\n`],
];
for (const [name, content] of files) {
  writeFileSync(`${fixtures}${name}`, content);
  console.log(`${name} ${String(content.length)} B`);
}
