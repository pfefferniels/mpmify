/**
 * The work file: what a reconstruction is saved as, and read back from.
 *
 * Two arrays, and nothing else.
 *
 * - **`provenance`** — the calls, in the order they ran, each with the options it ran with.
 *   This is the reconstructible half: `importWork` builds the chain back out of it, and running
 *   that chain over the same MEI produces the same MPM.
 * - **`segments`** — the baked half: how the calls group into stretches of the performance, the
 *   note that says why, and the `xml:id`s of the MPM elements the group produced. Derived from
 *   a run, so it is a record of one rather than an input to it.
 *
 * It used to be a JSON-LD graph in CIDOC-CRM and CRMinf: every group of calls was an
 * `I1_Argumentation` that `J2_concluded_that` an `I2_Belief` with a motivation and a
 * `J5_holds_to_be` certainty. Nothing read the certainty, nothing read the actor, and the
 * ontology bought a vocabulary for claims mpmify does not make: it fits a performance and says
 * which call produced which element. That is what is here.
 */
import { v4 } from 'uuid';
import { MakeChoice, compareTransformers } from './transformers/index.js';
import type { TransformationOptions, Transformer } from './transformers/Transformer.js';
import { createTransformer } from './transformers/TransformerRegistry.js';

export interface Work {
  name: string;
  mei: string;
  mpm: string;
}

/** One transformer call, as the file records it: enough to build it and run it again. */
export interface Call {
  id: string;
  name: string;
  options: TransformationOptions;
}

/**
 * A stretch of the performance a group of calls accounts for.
 *
 * `elements` is not derivable from `calls` without running the chain — that is the point of
 * recording it — and `calls` is not derivable from `elements` at all.
 */
export interface Segment {
  id: string;
  /** Why this group of calls belongs together. */
  note?: string;
  /** The `id`s of the {@link Call}s in `provenance` that make it up. */
  calls: string[];
  /** The `xml:id`s of the MPM elements those calls wrote, as of the run this was saved from. */
  elements: string[];
}

export interface WorkFile extends Work {
  provenance: Call[];
  segments: Segment[];
  secondary?: Record<string, unknown>;
}

export interface ImportResult {
  transformers: Transformer[];
  segments: Segment[];
  secondary?: Record<string, unknown>;
}

/** The recording ids a `MakeChoice` call preferred — which recording each note was taken from. */
export const sourcesOf = (transformers: Transformer[]): string[] =>
  Array.from(
    new Set(
      transformers
        .filter((t): t is MakeChoice => t.name === 'MakeChoice')
        .flatMap((t) =>
          'prefer' in t.options ? [t.options.prefer] : [t.options.velocity, t.options.timing],
        ),
    ),
  );

/**
 * Serialize a chain and its grouping.
 *
 * @param segments how the calls group, by call id. Each segment's `elements` is filled in from
 * what those calls actually created, so a caller that has run the chain gets the element ids for
 * free and one that has not gets an empty list rather than a wrong one.
 */
export function exportWork(
  work: Work,
  transformers: Transformer[],
  segments: readonly Omit<Segment, 'elements'>[] = [],
  secondary?: Record<string, unknown>,
): string {
  const createdById = new Map(transformers.map((t) => [t.id, t.created]));

  const file: WorkFile = {
    ...work,
    provenance: transformers.map(({ id, name, options }) => ({ id, name, options })),
    segments: segments.map((segment) => ({
      ...segment,
      elements: Array.from(new Set(segment.calls.flatMap((id) => createdById.get(id) ?? []))),
    })),
    ...(secondary !== undefined && { secondary }),
  };

  return JSON.stringify(file, replacer, 2);
}

/** `Map` and `Set` survive the round trip; nothing else needs to. */
function replacer(_: string, value: unknown) {
  if (value instanceof Map) return { dataType: 'Map', value: Array.from(value.entries()) };
  if (value instanceof Set) return { dataType: 'Set', value: Array.from(value.values()) };
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The calls of a parsed work file.
 *
 * This is the only place mpmify reads a document it did not write in this process, so each step
 * says what it expected to find rather than surfacing as `Cannot read properties of undefined`.
 * The narrowing goes as far as each call naming a transformer; below that the cast stands in for
 * a schema, because the option shapes are the transformers' own and this module does not know
 * them.
 */
const readProvenance = (imported: Record<string, unknown>): Call[] => {
  const provenance = imported['provenance'];
  if (!Array.isArray(provenance)) {
    throw new Error('Not a work file: "provenance" is missing or not a list');
  }

  return provenance.map((call, index) => {
    if (!isRecord(call) || typeof call['name'] !== 'string') {
      throw new Error(`Work file call ${String(index)} has no name`);
    }
    return {
      id: typeof call['id'] === 'string' ? call['id'] : v4(),
      name: call['name'],
      options: isRecord(call['options']) ? call['options'] : {},
    };
  });
};

const readSegments = (imported: Record<string, unknown>): Segment[] => {
  const segments = imported['segments'];
  if (segments === undefined) return [];
  if (!Array.isArray(segments)) {
    throw new Error('Not a work file: "segments" is not a list');
  }

  return segments.map((segment, index) => {
    if (!isRecord(segment) || !Array.isArray(segment['calls'])) {
      throw new Error(`Work file segment ${String(index)} has no "calls" list`);
    }
    return {
      id: typeof segment['id'] === 'string' ? segment['id'] : v4(),
      ...(typeof segment['note'] === 'string' && segment['note'] ? { note: segment['note'] } : {}),
      calls: segment['calls'].filter((id): id is string => typeof id === 'string'),
      elements: Array.isArray(segment['elements'])
        ? segment['elements'].filter((id): id is string => typeof id === 'string')
        : [],
    };
  });
};

export function importWork(json: string): ImportResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function reviver(_: string, value: any) {
    if (typeof value === 'object' && value !== null) {
      if (value.dataType === 'Map') return new Map(value.value);
      if (value.dataType === 'Set') return new Set(value.value);
    }
    return value;
  }

  const imported: unknown = JSON.parse(json, reviver);
  if (!isRecord(imported)) {
    throw new Error('Not a work file: expected a JSON object');
  }

  const transformers = readProvenance(imported)
    .map((call) => {
      const transformer = createTransformer(call.name);
      if (!transformer) {
        console.error(`Unknown transformer name: ${call.name}`);
        return null;
      }
      transformer.id = call.id;
      transformer.options = call.options;
      return transformer;
    })
    .filter((transformer): transformer is Transformer => transformer !== null);

  return {
    transformers: transformers.sort(compareTransformers),
    segments: readSegments(imported),
    ...(imported['secondary'] !== undefined && {
      secondary: imported['secondary'] as Record<string, unknown>,
    }),
  };
}
