import { getRange, Alignment, Segment, Transformer } from 'mpmify';
import type { Residual } from 'mpmify';

/**
 * Fold segments covering exactly the same ticks into one.
 *
 * Two groups of calls that resolve to an identical range are one gesture as far as the viewer is
 * concerned. The segment with the most calls wins and takes over the losers' calls, elements and
 * notes; the losers drop out. Returns the same array reference when nothing overlaps, so the
 * merge is idempotent.
 *
 * @param residual how the chain's MPM places the score on the tick grid. A pedal carries no
 * symbolic date of its own, so `getRange` derives one — and throws without this.
 */
export function mergeOverlappingSegments(
  segments: Segment[],
  transformers: Transformer[],
  msm: Alignment,
  residual: Residual,
): Segment[] {
  const byCallId = new Map(transformers.map((t) => [t.id, t]));
  const callsOf = (segment: Segment) =>
    segment.calls.map((id) => byCallId.get(id)).filter((t): t is Transformer => t !== undefined);

  const sharingRange = new Map<string, Segment[]>();
  for (const segment of segments) {
    const range = getRange(callsOf(segment), msm, residual);
    if (!range) continue;
    const key = `${range.from}:${range.to ?? range.from}`;
    const sharing = sharingRange.get(key);
    if (sharing) sharing.push(segment);
    else sharingRange.set(key, [segment]);
  }

  /** winner id → the segments it absorbs, most-calls-first as the sort left them */
  const absorbed = new Map<string, Segment[]>();
  for (const sharing of sharingRange.values()) {
    if (sharing.length <= 1) continue;
    const [winner, ...losers] = [...sharing].sort((a, b) => b.calls.length - a.calls.length);
    absorbed.set(winner.id, losers);
  }
  if (absorbed.size === 0) return segments;

  const lost = new Set([...absorbed.values()].flat().map((segment) => segment.id));

  return segments
    .filter((segment) => !lost.has(segment.id))
    .map((segment) => {
      const losers = absorbed.get(segment.id);
      if (!losers) return segment;

      const note = [segment, ...losers]
        .map((s) => s.note)
        .filter((n): n is string => !!n)
        .join('; ');

      return {
        id: segment.id,
        ...(note ? { note } : {}),
        calls: [segment, ...losers].flatMap((s) => s.calls),
        elements: [...new Set([segment, ...losers].flatMap((s) => s.elements))],
      };
    });
}
