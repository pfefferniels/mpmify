import { v4 } from 'uuid';
import { Mpm, requireMap, type Scope } from '../../mpm/index.js';
import { Alignment, type AlignedNote, type ChordMap } from '../../alignment/index.js';
import { isDefined } from '../../utils/utils.js';
import { AbstractTransformer, type TransformationOptions } from '../Transformer.js';

export type InsertAsynchronyOptions = TransformationOptions & {
  /**
   * Defines which part to apply asynchrony for. Global asynchrony is impossible.
   */
  part: Omit<Scope, 'global'>;
} & {
  from: number;
  to: number;
};

/**
 * The onsets of a chord, in ascending order, with the ones that were never performed left out.
 */
const performedOnsets = (chord: AlignedNote[]) =>
  chord
    .map((note) => note['milliseconds.date'])
    .filter((onset) => isDefined(onset))
    .sort((a, b) => a - b);

/**
 * Where a chord sounds, as one number.
 *
 * The median, not the first note in array order. Asynchrony is measured *between* the parts, so
 * letting the spread *within* a chord decide the measurement — which taking `chord.at(0)` did,
 * since `asChords` groups in whatever order the notes arrive — puts the noise this transformer
 * exists to describe into its own answer.
 */
const chordOnset = (chord: AlignedNote[] | undefined): number | undefined => {
  if (!chord) return undefined;
  const onsets = performedOnsets(chord);
  if (onsets.length === 0) return undefined;

  const middle = Math.floor(onsets.length / 2);
  return onsets.length % 2 === 1 ? onsets[middle] : (onsets[middle - 1] + onsets[middle]) / 2;
};

/**
 * The rest of the ensemble, grouped by date the way `asChords` groups one part.
 *
 * "The other part" used to be `part === 1 ? 0 : 1`, which answers part 1 for everything that is
 * not part 1 — so on a three-staff score part 2 was measured against part 1 and part 0 was
 * ignored, silently (issue #45). An `<asynchrony>` offsets one part against the timeline the
 * rest of the piece keeps, so the reference is every note that is not in `part`, and a two-staff
 * score — where that is exactly the other staff — keeps the answer it had.
 */
const referenceChords = (msm: Alignment, part: number): ChordMap => {
  return msm.allNotes.reduce<ChordMap>((chords, note) => {
    if (note.part - 1 === part) return chords;

    const chord = chords.get(note.date);
    if (chord) chord.push(note);
    else chords.set(note.date, [note]);
    return chords;
  }, new Map());
};

/**
 * This transformer inserts <asynchrony> instructions for a
 * given range and part and substracts the shift from
 * the affected notes. Since it only modifies physical
 * attributes it should be applied before translating
 * physical time to tick time.
 *
 * That ordering is carried by the registry, which places this transformer before
 * `TranslatePhysicalTimeToTicks`, and not by `requires` — `requires` says "this name must appear
 * *earlier* in the chain", so it cannot express a must-precede relation at all. Sorted last,
 * which is where an unregistered name went, it ran after the physical attributes it edits had
 * already been read (issue #31).
 */
export class InsertAsynchrony extends AbstractTransformer<InsertAsynchronyOptions> {
  name = 'InsertAsynchrony';
  requires = [];

  constructor(options?: InsertAsynchronyOptions) {
    super(
      options || {
        from: 0,
        to: 0,
        part: 1,
      },
    );
  }

  protected transform(msm: Alignment, mpm: Mpm): void {
    const part = this.options.part as Scope;
    const chords = Array.from(msm.asChords(part)).filter(([date, chord]) => {
      // Filter out chords that are not in the range
      return date >= this.options.from && date <= this.options.to && chord.length > 0;
    });

    // Built once, outside the walk. It used to be rebuilt inside it, so the whole note list
    // of the reference was walked and grouped again for every chord in the range — quadratic
    // in the number of chords, for a value that does not change (issue #45).
    const reference = referenceChords(msm, part as number);

    const shifts = chords.flatMap(([date, chord]) => {
      const onset = chordOnset(chord);
      const otherOnset = chordOnset(reference.get(date));

      // A date the other part does not sound at, or a note that carries no performance
      // onset yet, has no shift to contribute — dropping the pair here is what keeps it
      // out of the average, and doing it in one step is what lets the subtraction below
      // see two numbers.
      if (onset === undefined || otherOnset === undefined) return [];
      return [onset - otherOnset];
    });

    // Nothing paired up: no date in the range is sounded by both this part and the rest.
    // There is no asynchrony to report, and `0 / 0` is not a way of saying so — it went into
    // `@milliseconds.offset` and into every onset in the range, after which every tick
    // computation downstream was NaN too (issue #45). The audit in `Transformer.run` refuses
    // a non-finite attribute now, so this throws rather than corrupts; neither is an answer,
    // and writing no instruction is.
    if (shifts.length === 0) return;

    // A difference of two recorded onsets, so already the milliseconds `@milliseconds.offset`
    // is stated in.
    const averageShift = shifts.reduce((acc, shift) => acc + shift, 0) / shifts.length;

    const map = requireMap(mpm, 'asynchrony', part);

    map.addAsynchrony({
      id: `asynchrony_${v4()}`,
      date: this.options.from,
      millisecondsOffset: averageShift,
    });

    map.addAsynchrony({
      id: `asynchrony_${v4()}`,
      date: this.options.to,
      millisecondsOffset: 0,
    });

    // Move the notes by the average shift. Both ends, not just the onset: the instruction
    // displaces the whole note, so a release left where it was would shorten every note the
    // part is early on and lengthen every one it is late on.
    for (const [, chord] of chords) {
      for (const note of chord) {
        note['milliseconds.date'] -= averageShift;
        note['milliseconds.date.end'] -= averageShift;
      }
    }
  }
}
