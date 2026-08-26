/**
 * The bake itself: MEI + info.json ⇒ score MSM, performance MPM, intensity segments.
 *
 * Shared by `bakeSegments.ts`, which writes the result to `public/`, and
 * `verifySegments.ts`, which re-derives it and diffs against what was written.
 *
 * Everything here is bake-time only. It is the last place mpmify runs.
 */
import {
  compareTransformers,
  createMpm,
  deriveResidual,
  getInstructions,
  getRange,
  exportMPM,
  importWork,
  InsertMetadata,
  registerTransformer,
  validate,
} from '../../src/index.js';
import type {
  InstructionType,
  Mpm,
  Alignment,
  Segment as WorkSegment,
  Transformer,
} from '../../src/index.js';
import { convertMeiToMsm } from 'espressivo';
import { InsertTempo } from './InsertTempo.js';
import { asMSM } from './asMSM.js';
import { mergeOverlappingSegments } from './mergeSegments.js';
import type { Reconstruction, Segment, Span } from './Reconstruction.js';

registerTransformer(InsertTempo, { after: 'ApproximateLogarithmicTempo' });

/**
 * The pipeline half of the bake: the MEI, the chain, and the MPM the chain writes.
 *
 * Split out of `derive` for `test/roundtrip/aligned.ts`, which renders this MPM back and
 * compares it against the recording it was fitted to. That check is about the pipeline, so it
 * has no use for the segments — and no reason to fail when the segment half does.
 */
interface Pipeline {
  /** The MEI as MSM — what a render performs. */
  scoreMsm: string;
  /** The recording on the score, as the chain left it. */
  msm: Alignment;
  mpm: Mpm;
  /** The chain's MPM, serialized. */
  mpmXml: string;
  /** The chain as it ran: the file's calls, metadata substituted, in registry order. */
  transformers: Transformer[];
  /** How the file groups those calls, by call id. */
  segments: WorkSegment[];
  title: string;
  author: string;
}

interface Derived {
  scoreMsm: string;
  mpmXml: string;
  reconstruction: Reconstruction;
  /** The run itself, for `verifySegments.ts` to compare the segments against. */
  pipeline: {
    transformers: Transformer[];
    segments: WorkSegment[];
    msm: Alignment;
    mpm: Mpm;
  };
  stats: {
    transformers: number;
    /** Groups the work file declares, before overlapping ones are folded together. */
    segments: number;
    /** Calls in no segment at all — they contribute no span. */
    ungrouped: number;
    /** Spans dropped because every element they made was removed again. */
    droppedSpans: number;
    /** Element ids dropped because a later transformer removed the instruction. */
    droppedElements: number;
  };
}

const quiet = <T>(fn: () => T): T => {
  const log = console.log;
  console.log = () => undefined;
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

export const runPipeline = (mei: string, info: string): Pipeline => {
  const movements = convertMeiToMsm(mei);
  if (!movements.length) throw new Error('MEI holds no convertible movement');
  const scoreMsm = movements[0].msm;

  const msm = asMSM(mei, scoreMsm);

  const { transformers: loaded, segments } = importWork(info);
  const messages = validate(loaded);
  if (messages.length) throw new Error(messages.map((m) => m.message).join('\n'));

  const metadata = loaded.find((t) => t.name === 'InsertMetadata') as InsertMetadata | undefined;
  const title = metadata?.options.comments?.[0]?.text ?? '';
  const author = metadata?.options.authors?.[0]?.text ?? '';

  // The app dropped the imported InsertMetadata and prepended its own, built
  // from the title and author it had extracted. Same document, one code path.
  // It belongs to no segment: it writes `<metadata>`, not an instruction.
  const metadataTransformer = new InsertMetadata({
    authors: author ? [{ number: 0, text: author }] : [],
    comments: title ? [{ text: title }] : [],
  });

  const ran: Transformer[] = [
    metadataTransformer,
    ...loaded.filter((t) => t.name !== 'InsertMetadata'),
  ].sort(compareTransformers);

  const mpm = createMpm();
  quiet(() => ran.forEach((transformer) => transformer.run(msm, mpm)));

  return { scoreMsm, msm, mpm, mpmXml: exportMPM(mpm), transformers: ran, segments, title, author };
};

/** The instructions of one type a set of element ids names, earliest first. */
const named = <K extends InstructionType>(mpm: Mpm, type: K, elements: Set<string>) =>
  getInstructions(mpm, type)
    .filter((instruction) => instruction.id !== undefined && elements.has(instruction.id))
    .sort((a, b) => a.date - b.date);

/** Only the values that are numbers: `@bpm` and `@volume` may hold a style-relative name. */
const numeric = (values: readonly (number | string | undefined)[]): number[] =>
  values.filter((value): value is number => typeof value === 'number');

/** How far a run of values travels from where it starts to where it ends. */
const travelled = (values: number[]): number =>
  values.length === 0 ? 0 : values[values.length - 1] - values[0];

/**
 * The segment's weight on the intensity curve, read off what its own elements do.
 *
 * See {@link Segment.intensity}: half for the direction the tempo takes over the segment, half
 * for the direction the dynamics take, so the two agreeing is worth twice one moving alone.
 */
const intensityOf = (mpm: Mpm, elements: Set<string>): number => {
  const tempo = named(mpm, 'tempo', elements).flatMap((instruction) =>
    numeric([instruction.bpm, instruction.transitionTo]),
  );
  const dynamics = named(mpm, 'dynamics', elements).flatMap((instruction) =>
    numeric([instruction.volume, instruction.transitionTo]),
  );

  return Math.sign(travelled(tempo)) * 0.5 + Math.sign(travelled(dynamics)) * 0.5;
};

export const derive = (mei: string, info: string): Derived => {
  const {
    scoreMsm,
    msm,
    mpm,
    mpmXml,
    transformers: ran,
    segments: grouping,
    title,
    author,
  } = runPipeline(mei, info);

  // Where the chain's MPM puts each note and pedal on the tick grid. Only the pedal
  // transformers need it — a pedal has no symbolic date of its own — but `getRange` cannot
  // know that before it looks, so it is derived once here and handed to every call below.
  // `without: ['movement']` is the probe `InsertPedal` itself uses.
  const residual = deriveResidual(msm, mpm, { without: ['movement'] });

  // The viewer ran this on every pipeline result, so it is part of what the
  // segments are: groups covering the exact same ticks are one.
  const segments = mergeOverlappingSegments(grouping, ran, msm, residual);

  const segmentOfCall = new Map<string, WorkSegment>();
  for (const segment of segments) {
    for (const call of segment.calls) segmentOfCall.set(call, segment);
  }

  const typeById = new Map(getInstructions(mpm).map((i) => [i.id, i.type]));

  // In chain order, so a segment appears where its first call runs.
  const groups = new Map<WorkSegment, Transformer[]>();
  let ungrouped = 0;
  for (const transformer of ran) {
    const segment = segmentOfCall.get(transformer.id);
    if (!segment) {
      ungrouped++;
      continue;
    }
    const group = groups.get(segment);
    if (group) group.push(transformer);
    else groups.set(segment, [transformer]);
  }

  const derived: Segment[] = [];
  let droppedSpans = 0;
  let droppedElements = 0;

  for (const [segment, group] of groups) {
    const range = getRange(group, msm, residual);
    if (!range) continue;
    const from = range.from;
    const to = range.to ?? range.from;

    const byId = new Map<string, Span>();
    for (const transformer of group) {
      // A transformer's `created` outlives the instructions: a later one
      // may have removed or merged them away again.
      const elements = transformer.created.filter((id) => typeById.has(id));
      droppedElements += transformer.created.length - elements.length;
      if (elements.length === 0) {
        droppedSpans++;
        continue;
      }

      // Transformers that act on the whole piece (InsertDynamicsGradient)
      // resolve to no range of their own and take the segment's.
      const spanRange = getRange(transformer.options, msm, residual);
      const span: Span = {
        id: elements[0],
        type: typeById.get(elements[0])!,
        from: spanRange?.from ?? from,
        to: spanRange?.to ?? to,
        elements,
      };

      // info.json holds a handful of transformers repeated verbatim; the
      // second overwrote the first's instruction and reported the same
      // deterministic id, so the viewer drew two identical lanes. One
      // element, one span.
      const existing = byId.get(span.id);
      if (!existing) {
        byId.set(span.id, span);
        continue;
      }
      existing.from = Math.min(existing.from, span.from);
      existing.to = Math.max(existing.to, span.to);
      for (const id of elements) if (!existing.elements.includes(id)) existing.elements.push(id);
    }
    const spans = [...byId.values()];
    if (spans.length === 0) continue;

    derived.push({
      id: segment.id,
      ...(segment.note ? { note: segment.note } : {}),
      from,
      to,
      intensity: intensityOf(mpm, new Set(spans.flatMap((span) => span.elements))),
      spans,
    });
  }

  return {
    scoreMsm,
    mpmXml,
    reconstruction: { title, author, segments: derived },
    pipeline: { transformers: ran, segments, msm, mpm },
    stats: {
      transformers: ran.length,
      segments: grouping.length,
      ungrouped,
      droppedSpans,
      droppedElements,
    },
  };
};
