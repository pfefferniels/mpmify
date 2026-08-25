import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performMsmToData } from 'espressivo';
import type { PerformanceData, PerformedNote } from 'espressivo';
import { Alignment } from '../../src/alignment';
import { createMpm } from '../../src/mpm';
import { importWork } from '../../src/Work';
import { asMSM } from '../../scripts/bake/asMSM';
import { runPipeline } from '../../scripts/bake/deriveSegments';
import { AspectError, Errors, EMPTY_MPM, statistics } from './harness';

/**
 * The round trip on a performance no MPM produced.
 *
 * Every case in `cases.ts` states its ground truth *as an MPM*, which is what makes the truth
 * exact — and also what bounds it: the chain is asked to recover something the renderer could
 * have written in the first place. A real recording is not in that image. Nothing guarantees a
 * Welte roll's onsets are a tempo curve plus a rubato frame, and what the chain cannot express
 * has nowhere to go but the error.
 *
 *     aligned MEI       --convertMeiToMsm--> score MSM
 *     MEI + score MSM   --asMSM------------> the recording, on the score
 *     that + info.json  --the chain--------> MPM
 *     score MSM + MPM   --espressivo-------> a performance
 *                                            assert it is the recording again
 *
 * This is the check issue #51 asks for, and it runs the bake — `scripts/bake/deriveSegments`,
 * the one place mpmify's pipeline still runs in production — rather than a chain assembled
 * here. The fixture is therefore also the input that bake never had in this repo.
 */

const fixture = (name: string) =>
  readFileSync(join(__dirname, '..', 'fixtures', 'roundtrip', name), 'utf-8');

export interface AlignedRun {
  /** The MEI as MSM — what the render performs. */
  scoreMsm: string;
  /** The chain's MPM. */
  mpmXml: string;
  /** The recording the chain was asked to reproduce, shifted to start at zero. */
  observed: Alignment;
  rendered: PerformanceData;
  errors: Errors;
  /**
   * How far the recording departs from the bare score under an empty MPM.
   *
   * A fixture that lost its `<when>` elements — or a chain that resolved to nothing — would
   * leave the round trip comparing the score against itself and passing. This is what says
   * the fixture still carries a performance.
   */
  exercised: Errors;
  /** How much of the recording the chain's MPM actually accounts for, per aspect. */
  explained: { onset: number; duration: number; velocity: number };
  /** How many transformer calls the chain file holds, and how many of them ran. */
  calls: { declared: number; ran: number };
}

export const runAligned = (): AlignedRun => {
  const mei = fixture('traeumerei.mei');
  const info = fixture('chain.json');

  const { scoreMsm, mpmXml, transformers } = runPipeline(mei, info);

  const rendered = performMsmToData({ msm: scoreMsm, mpm: mpmXml });
  const bare = performMsmToData({ msm: scoreMsm, mpm: EMPTY_MPM });
  const observed = recording(mei, scoreMsm, info);

  const errors = compareToRecording(observed, rendered);
  const exercised = compareToRecording(observed, bare);

  return {
    scoreMsm,
    mpmXml,
    observed,
    rendered,
    errors,
    exercised,
    explained: {
      onset: explained(exercised.onset, errors.onset),
      duration: explained(exercised.duration, errors.duration),
      velocity: explained(exercised.velocity, errors.velocity),
    },
    calls: { declared: declaredCalls(info), ran: transformers.length },
  };
};

/**
 * The recording as the chain was asked to reproduce it.
 *
 * Two of the chain's transformers are about the observation rather than about the MPM, and both
 * have to be applied before the recording is a target. `MakeChoice` picks one of the two
 * readings the MEI carries — without it every note is in the file twice, once per source — and
 * `Modify` is the editor saying a note was played softer than the roll scan says. Rebuilding
 * the MSM here rather than reading back the one the chain ran on is deliberate: a transformer
 * that quietly wrote its answer into the observations would otherwise be measured against its
 * own writing and score perfectly.
 */
const recording = (mei: string, scoreMsm: string, info: string): Alignment => {
  const observed = asMSM(mei, scoreMsm);
  const { transformers } = importWork(info);
  const scratch = createMpm();

  for (const transformer of transformers) {
    if (transformer.name === 'MakeChoice' || transformer.name === 'Modify') {
      transformer.run(observed, scratch);
    }
  }

  // The render starts the piece at zero; the roll starts it 28 seconds in.
  observed.shiftToFirstOnset();
  return observed;
};

const declaredCalls = (info: string): number => {
  const parsed = JSON.parse(info) as { provenance: unknown[] };
  return parsed.provenance.length;
};

/** The share of the recording's departure from the bare score that the MPM accounts for. */
const explained = (exercised: AspectError, remaining: AspectError) =>
  exercised.mean === 0 ? 0 : 1 - remaining.mean / exercised.mean;

/**
 * The recording against a render of it, note by note, matched on `xml:id`.
 *
 * The score MSM holds notes the recording does not: `asMSM` drops a note whose date and pitch a
 * longer one already claims, and a note the alignment never reached has no `<when>` at all.
 * Those are absent from the comparison rather than counted as error — what they measure is the
 * alignment, not the chain. A note the recording *does* have and the render does not is
 * `missing`, and that is a failure.
 */
const compareToRecording = (observed: Alignment, rendered: PerformanceData): Errors => {
  const byId = new Map<string, PerformedNote>();
  for (const part of rendered.parts) {
    for (const note of part.notes) if (note.id) byId.set(note.id, note);
  }

  const onsets: number[] = [];
  const durations: number[] = [];
  const velocities: number[] = [];
  let missing = 0;

  for (const note of observed.allNotes) {
    const performed = byId.get(note['xml:id']);
    if (!performed) {
      missing++;
      continue;
    }
    onsets.push(Math.abs(performed.milliseconds.date - note['milliseconds.date']));
    durations.push(
      Math.abs(
        performed.milliseconds.end -
          performed.milliseconds.date -
          (note['milliseconds.date.end'] - note['milliseconds.date']),
      ),
    );
    velocities.push(Math.abs(performed.velocity - note.velocity));
  }

  return {
    onset: statistics(onsets),
    duration: statistics(durations),
    velocity: statistics(velocities),
    matched: onsets.length,
    missing,
  };
};
