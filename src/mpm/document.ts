/**
 * Where a {@link Scope} meets an espressivo document.
 *
 * The document is espressivo's `Mpm` — passed around by the transformers as it is, with its
 * whole surface. What is here is the one question espressivo does not answer: mpmify and the alignment
 * name a part `'global'` or by index, and turning that into a `<global>` or a numbered
 * `<part>`, then into its `<dated>`, then into the map, creating each on the way, is four steps
 * no transformer should repeat.
 *
 * {@link requireMap} hands back espressivo's own `TempoMap`, `DynamicsMap` and so on, and a
 * transformer calls `addTempo`, `updateTempoAt`, `removeElement` on it directly. Nothing here
 * wraps a write.
 */
import {
  Dated,
  Document,
  Global,
  Mpm,
  Part,
  Performance,
  type AnyResult,
  type Header,
  type OkOf,
} from 'espressivo';
import { PULSES_PER_QUARTER } from '../ppq.js';
import { InstructionType, mapNames, MapFor, Scope } from './types.js';

/** The `<performance>` mpmify writes into. mpm-ts wrote exactly one, unnamed. */
const PERFORMANCE_NAME = 'unknown';

/**
 * The value of one of espressivo's `Result`-returning factories, or a throw naming the reason.
 *
 * The factories are total over what mpmify hands them — a name it just generated, a length it
 * just computed — so a failure is a bug in the caller and not a case to branch on. Written once
 * so that no caller has to decide what to do about a `Result` it cannot meaningfully recover
 * from.
 */
export const unwrap = <R extends AnyResult>(result: R, what = 'value'): OkOf<R> => {
  if (!result.ok) {
    throw new Error(`espressivo refused to build a ${what}: ${JSON.stringify(result.error)}`);
  }
  return result.value as OkOf<R>;
};

/** An empty MPM with the one `<performance>` mpmify writes into, at mpmify's own PPQ. */
export const createMpm = (): Mpm => {
  const mpm = new Mpm();
  mpm.addPerformance(
    unwrap(Performance.fromName(PERFORMANCE_NAME, PULSES_PER_QUARTER), 'performance'),
  );
  return mpm;
};

/**
 * Read MPM source.
 *
 * Be aware that espressivo's parser *repairs*: it fills in `pulsesPerQuarter`, gives
 * `accentuationPatternDef` a `length`, re-sorts every map by date and drops duplicate maps. A
 * round trip is therefore normalising, not faithful.
 */
export const parseMPM = (xml: string): Mpm => new Mpm(xml);

/** Serialize an MPM document. */
export const exportMPM = (mpm: Mpm): string => mpm.writeMpm() ?? '';

/**
 * The `<performance>` mpmify works in, created if the document has none.
 *
 * Every scope-addressed function below goes through this, so a document parsed from a file
 * without a performance behaves like a fresh one rather than silently answering nothing.
 */
export const performanceOf = (mpm: Mpm): Performance => {
  const existing = mpm.getPerformance(0);
  if (existing) return existing;
  const performance = unwrap(
    Performance.fromName(PERFORMANCE_NAME, PULSES_PER_QUARTER),
    'performance',
  );
  mpm.addPerformance(performance);
  return performance;
};

export const setPerformanceName = (mpm: Mpm, name: string): void => {
  performanceOf(mpm).setName(name);
};

/**
 * Every scope the document has something in — `'global'` first, then parts by number.
 *
 * `<global>` always exists in an espressivo performance, so it is always listed; a transformer
 * looping over scopes finds no instructions there and moves on.
 */
export const scopesOf = (mpm: Mpm): Scope[] => {
  const performance = performanceOf(mpm);
  const scopes: Scope[] = performance.getGlobal() ? ['global'] : [];
  for (const part of performance.getAllParts()) scopes.push(part.getNumber() - 1);
  return scopes;
};

/**
 * The `<global>` or `<part>` a scope names, created if `create` and it is not there yet.
 *
 * A part's `@number` is `scope + 1` and its `@midi.channel` is `scope`, which is the numbering
 * mpm-ts's serializer wrote and what `Alignment.notesInPart` assumes.
 */
const environmentOf = (mpm: Mpm, scope: Scope, create: boolean): Global | Part | null => {
  const performance = performanceOf(mpm);
  if (scope === 'global') return performance.getGlobal();

  const existing = performance.getPart(scope + 1);
  if (existing || !create) return existing;

  const part = unwrap(
    Part.fromValues(`part_${String(scope)}`, scope + 1, scope, 0),
    `part ${String(scope)}`,
  );
  performance.addPart(part);
  return part;
};

const datedOf = (mpm: Mpm, scope: Scope, create: boolean): Dated | null => {
  const environment = environmentOf(mpm, scope, create);
  if (!environment) return null;
  return create ? environment.requireDated() : environment.getDated();
};

/** The `<header>` of a scope. Only the style functions need it. */
export const headerOf = (mpm: Mpm, scope: Scope, create: boolean): Header | null =>
  environmentOf(mpm, scope, create)?.getHeader() ?? null;

const map = <K extends InstructionType>(
  mpm: Mpm,
  type: K,
  scope: Scope,
  create: boolean,
): MapFor<K> | null => {
  const dated = datedOf(mpm, scope, create);
  if (!dated) return null;

  const kind = mapNames[type];
  const existing = dated.getMapOfKind(kind);
  if (existing || !create) return existing;

  dated.addMapByType(kind);
  return dated.getMapOfKind(kind);
};

/** The espressivo map an instruction type lives in, in this scope, or null if there is none. */
export const mapOf = <K extends InstructionType>(
  mpm: Mpm,
  type: K,
  scope: Scope,
): MapFor<K> | null => map(mpm, type, scope, false);

/** {@link mapOf}, creating the part, the `<dated>` and the map if they are not there yet. */
export const requireMap = <K extends InstructionType>(mpm: Mpm, type: K, scope: Scope): MapFor<K> =>
  map(mpm, type, scope, true)!;

/**
 * A copy of this document with the maps of these instruction types taken out.
 *
 * The point is to ask what the rest of the MPM explains. Rendering `withoutMaps(mpm,
 * ['articulation'])` and comparing against the recording gives the deviation articulation still
 * has to account for — the same quantity the transformers used to accumulate by subtracting
 * their own share from the alignment, obtained by construction instead of by bookkeeping.
 *
 * The document is deep-copied, so this never disturbs the one being fitted. It is a probe:
 * render it and throw it away.
 */
export const withoutMaps = (mpm: Mpm, types: readonly InstructionType[]): Mpm => {
  const root = mpm.getRootElement();
  if (!root) return createMpm();

  const copy = new Mpm(new Document(root.copy()));
  for (const performance of copy.getAllPerformances()) {
    const environments: (Global | Part | null)[] = [
      performance.getGlobal(),
      ...performance.getAllParts(),
    ];
    for (const environment of environments) {
      const dated = environment?.getDated();
      if (!dated) continue;
      for (const type of types) dated.removeMap(mapNames[type]);
    }
  }
  return copy;
};
