/**
 * What the viewer reads: intensity segments that name MPM elements outright.
 *
 * There is no derivation step. `public/segments.json` holds exactly this shape,
 * `public/performance.mpm` holds the elements it names, and the two are baked
 * together by `scripts/bakeSegments.ts` from the transformer pipeline that used
 * to run in the browser on every load.
 */

/**
 * One performance gesture inside a segment: a run of MPM elements of a single
 * type, over the ticks the gesture covers.
 *
 * The range is not derivable from the elements. An instruction's `date` says
 * where it takes effect, never how far it reaches — a single `<dynamics>` can
 * govern a whole phrase — so the span carries the range explicitly.
 */
export interface Span {
  /** Stable id for selection; also the first entry of `elements`. */
  id: string;
  /** MPM element type: tempo, dynamics, rubato, articulation, … */
  type: string;
  from: number;
  to: number;
  /** `xml:id`s of the MPM elements this gesture consists of. */
  elements: string[];
}

/** A stretch of the piece one group of calls accounts for. */
export interface Segment {
  id: string;
  /** Why this group belongs together — shown when the segment is hovered or opened. */
  note?: string;
  from: number;
  /** Equal to `from` for a segment that acts on a single point in time. */
  to: number;
  /**
   * How hard the segment pushes the intensity curve, as a signed weight in `[-1, 1]`.
   *
   * Read off the MPM the spans name rather than declared: `Math.sign` of what the tempo
   * travels from its first value to its last, plus `Math.sign` of what the dynamics travel,
   * each worth half. Both rising is `+1`, both falling `-1`, one moving alone `±0.5`, and a
   * segment that is mixed or names neither is `0` — the curve passes over it.
   */
  intensity: number;
  spans: Span[];
}

export interface Reconstruction {
  title: string;
  author: string;
  segments: Segment[];
}
