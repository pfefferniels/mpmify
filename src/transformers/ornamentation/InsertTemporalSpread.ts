import { type AddOrnamentOptions, FrameDomain, NoteOffShift } from 'espressivo';
import {
  Mpm,
  type OrnamentDraft,
  fillInAt,
  requireMap,
  setOrnamentDraft,
} from '../../mpm/index.js';
import { Alignment } from '../../alignment/index.js';
import { isDefined } from '../../utils/utils.js';
import {
  AbstractTransformer,
  generateId,
  type ScopedTransformationOptions,
} from '../Transformer.js';

export type ArpeggioPlacement = 'on-beat' | 'before-beat' | 'estimate' | 'none';
export type DatedArpeggioPlacement = Map<number, ArpeggioPlacement>;

// onsets is a sorted array normalized to [0, 1]
export const determineIntensity = (onsets: number[]): number => {
  const n = onsets.length;
  // intensity only makes sense for more than 2 notes
  if (n <= 2) return 1;

  // The error function we want to minimize.
  const error = (intensity: number): number => {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const expected = Math.pow(i / (n - 1), intensity);
      const diff = onsets[i] - expected;
      sum += diff * diff;
    }
    return sum;
  };

  // Search bounds. TODO: make these configurable.
  let lower = 0.1,
    upper = 5.0;
  const tol = 1e-6;
  const goldenRatio = (Math.sqrt(5) + 1) / 2;

  let c = upper - (upper - lower) / goldenRatio;
  let d = lower + (upper - lower) / goldenRatio;

  // Continue refining the bounds until convergence.
  while (upper - lower > tol) {
    if (error(c) < error(d)) {
      upper = d;
    } else {
      lower = c;
    }
    c = upper - (upper - lower) / goldenRatio;
    d = lower + (upper - lower) / goldenRatio;
  }

  return (lower + upper) / 2;
};

/**
 * A little helper function to determine how an array is sorted.
 *
 * @param arr The array to check
 * @returns -1 if the array is sorted in descending order, 1 if its
 * sorted in ascending order, 0 if it isn't sorted.
 */
const determineSortDirection = (arr: number[]) => {
  if (arr.length < 2) return 0;

  const direction = Math.sign(arr[1] - arr[0]);
  return arr.slice(1).every((val, i) => Math.sign(val - arr[i]) === direction) ? direction : 0;
};

export type InsertTemporalSpreadOptions = ScopedTransformationOptions & {
  placement: ArpeggioPlacement;
  noteOffShiftTolerance: number;
} & ({ date: number } | { durationThreshold: number });

/**
 * Interpolates arpeggiated chords as ornaments, inserts them as physical
 * values into the MPM and substracts accordingly from the recorded onsets, so
 * that after the transformation all notes of the chord will have the same
 * onset.
 */
export class InsertTemporalSpread extends AbstractTransformer<InsertTemporalSpreadOptions> {
  name = 'InsertTemporalSpread';
  requires = [];

  constructor(options?: InsertTemporalSpreadOptions) {
    super(
      options || {
        durationThreshold: 35,
        placement: 'estimate',
        noteOffShiftTolerance: 500,
        scope: 'global',
      },
    );
  }

  protected transform(msm: Alignment, mpm: Mpm) {
    // Each ornament is written in two goes: what MPM lets an `<ornament>` say, and the
    // `<temporalSpread>` fields that have no place on one and are parked on its element for
    // `StylizeOrnamentation` to collect.
    const ornaments: { options: AddOrnamentOptions; draft: OrnamentDraft }[] = [];

    const chords = msm.asChords(this.options.scope);
    for (const [date, chordNotes] of chords) {
      if ('date' in this.options && date !== this.options.date) {
        // if a date is specified, only process that date
        continue;
      }

      // only consider notes with a defined onset time
      const arpeggioNotes = chordNotes.filter((note) => isDefined(note['milliseconds.date']));

      // Less than two notes cannot be arpeggiated
      if (arpeggioNotes.length < 2) continue;

      const sortedByOnset = arpeggioNotes.sort(
        (a, b) => a['milliseconds.date'] - b['milliseconds.date'],
      );

      // detecting the direction of the arpeggiated notes.
      const arpeggioDirection = determineSortDirection(
        sortedByOnset.map((note) => note['midi.pitch']),
      );
      let noteOrder = '';
      if (arpeggioDirection === 1) noteOrder = 'ascending pitch';
      else if (arpeggioDirection === -1) noteOrder = 'descending pitch';
      else noteOrder = sortedByOnset.map((note) => `#${note['xml:id']}`).join(' ');

      // the arpeggio's duration is the time distance between first and last onset, in ms
      const duration =
        sortedByOnset[sortedByOnset.length - 1]['milliseconds.date'] -
        sortedByOnset[0]['milliseconds.date'];
      if ('durationThreshold' in this.options) {
        if (duration <= (this.options?.durationThreshold || 0)) continue;
      }

      // by default, no offset shifting is applied
      let noteOffShift: NoteOffShift = NoteOffShift.False;
      const firstNote = sortedByOnset[0];
      const lastNote = sortedByOnset[sortedByOnset.length - 1];

      const sortedByOffset = sortedByOnset
        .slice()
        .sort((a, b) => a['milliseconds.date.end'] - b['milliseconds.date.end']);
      const sameOrder = sortedByOnset.every((note, i) => note === sortedByOffset[i]);

      const offsetScaleTolerance = 0.8;
      const minOffsetDistance = duration * offsetScaleTolerance;
      if (
        lastNote['milliseconds.date.end'] - firstNote['milliseconds.date.end'] >
          minOffsetDistance &&
        sameOrder
      ) {
        noteOffShift = NoteOffShift.True;
      }

      // in ms: how far a release may sit from the next onset and still count as one
      // note giving way to the next
      const monophonicTolerance = 20;
      let isMonophonic = true;
      for (let i = 1; i < sortedByOnset.length; i++) {
        const prev = sortedByOnset[i - 1];
        const curr = sortedByOnset[i];

        if (
          Math.abs(prev['milliseconds.date.end'] - curr['milliseconds.date']) > monophonicTolerance
        ) {
          isMonophonic = false;
          break;
        }
      }

      if (isMonophonic) {
        noteOffShift = NoteOffShift.Monophonic;
      }

      // define the frame start based on the given option
      const frameLength = duration;
      let frameStart: number, newOnset: number;

      const placement = this.options.placement;

      if (placement === 'none') {
        // leave everything as it is
        continue;
      } else if (placement === 'on-beat') {
        frameStart = 0;
        newOnset = sortedByOnset[0]['milliseconds.date'];
      } else if (placement === 'before-beat') {
        frameStart = -frameLength;
        newOnset = sortedByOnset[sortedByOnset.length - 1]['milliseconds.date'];
      } else {
        // the estimated onset is the average of all onsets
        newOnset =
          sortedByOnset.map((note) => note['milliseconds.date']).reduce((a, b) => a + b, 0) /
          arpeggioNotes.length;

        // frame start is the distance between the first note's onset and the estimated onset
        frameStart = sortedByOnset[0]['milliseconds.date'] - newOnset;
      }

      // determine the ornament's intensity
      const normalizedOnsets = sortedByOnset
        .map((note) => note['milliseconds.date'])
        .map((onset) => (onset - firstNote['milliseconds.date']) / duration);

      const intensity = determineIntensity(normalizedOnsets);

      ornaments.push({
        options: {
          id: generateId('ornament', date, mpm),
          date,
          nameRef: 'neutralArpeggio',
          noteOrder,
        },
        draft: {
          noteOffShift,
          frameStart,
          frameLength,
          frameDomain: FrameDomain.Milliseconds,
          intensity: intensity === 1 ? undefined : intensity,
        },
      });

      // The spread is now the ornament's to render, so the chord is collapsed onto one
      // onset. Each release travels the same distance as its onset: what is taken out here
      // is the stagger, not the length the note was held for.
      sortedByOnset.forEach((note) => {
        note['milliseconds.date.end'] += newOnset - note['milliseconds.date'];
        note['milliseconds.date'] = newOnset;
      });
    }

    // `fillInAt`, not `addOrnamentV3`: `InsertDynamicsGradient` may already have written
    // the ornament at this date, and the two describe one element between them.
    const map = requireMap(mpm, 'ornament', this.options.scope);
    for (const { options, draft } of ornaments) {
      setOrnamentDraft(
        fillInAt(map, options, {
          localName: 'ornament',
          add: (o) => map.addOrnamentV3(o),
          read: (i) => map.getOrnamentOptionsOf(i),
          update: (i, patch) => map.updateOrnamentAt(i, patch),
        }),
        draft,
      );
    }
  }
}
