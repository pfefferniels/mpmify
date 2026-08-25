// @vitest-environment jsdom

import { describe, test, expect } from "vitest"
import { MSM } from "../../src/msm"
import { Instruction, MPM } from "../../src/mpm"
import { ApproximateLogarithmicTempo, SilentOnset } from "../../src/transformers/tempo/ApproximateLogarithmicTempo"
import { computeMillisecondsAt, TempoWithEndDate } from "../../src/transformers/tempo/tempoCalculations"

/** Call the protected `transform` method for testing */
function callTransform(transformer: ApproximateLogarithmicTempo, msm: MSM, mpm: MPM) {
    type Transformable = { transform(msm: MSM, mpm: MPM): void };
    (transformer as unknown as Transformable).transform(msm, mpm);
}

const BEAT = 720; // ticks per quarter note

/**
 * Generate synthetic onset times by numerically integrating a tempo curve.
 * tempo(d) returns BPM at tick position d.
 * Returns onset pairs: [{date, onset_seconds}, ...]
 */
function generateOnsets(
    tempoFn: (d: number) => number,
    numBeats: number,
    startTime: number = 0
): { date: number; onset: number }[] {
    const result: { date: number; onset: number }[] = [];
    let time = startTime;
    const stepsPerBeat = 100;

    for (let beat = 0; beat <= numBeats; beat++) {
        result.push({ date: beat * BEAT, onset: time });

        if (beat < numBeats) {
            // Integrate 1/T(d) over [beat*BEAT, (beat+1)*BEAT] using trapezoidal rule
            let integral = 0;
            for (let s = 0; s < stepsPerBeat; s++) {
                const d0 = (beat + s / stepsPerBeat) * BEAT;
                const d1 = (beat + (s + 1) / stepsPerBeat) * BEAT;
                const T0 = tempoFn(d0);
                const T1 = tempoFn(d1);
                integral += 0.5 * (1 / T0 + 1 / T1) * (d1 - d0);
            }
            // integral is in minutes (BPM * ticks cancel), convert to seconds
            time += integral * 60 / BEAT;
        }
    }

    return result;
}

function imToExponent(im: number): number {
    return Math.log(0.5) / Math.log(im);
}

/**
 * Build MSM notes from onset data
 */
function buildMsm(onsets: { date: number; onset: number }[]): MSM {
    const notes = onsets.map((o, i) => ({
        'xml:id': `n_1_${i}`,
        date: o.date,
        part: 1,
        pitchname: 'g' as const,
        octave: 4,
        duration: BEAT,
        accidentals: 0,
        'midi.pitch': 67,
        'midi.onset': o.onset,
        'midi.duration': 0.5,
        'midi.velocity': 100
    }));
    return new MSM(notes, { numerator: 4, denominator: 4 });
}

/**
 * `@bpm` and `@transition.to` are `number | string`, because MPM lets either be a style-relative
 * name. The fitter only ever writes numbers, so a test that does arithmetic on one says so here
 * rather than casting at the site.
 */
const bpmOf = (value: number | string | undefined): number => Number(value)

/**
 * Run the fitter for a single segment and return tempo instructions
 */
function fitAndGetTempos(
    onsets: { date: number; onset: number }[],
    from: number, to: number, beatLength: number,
    silentOnsets: SilentOnset[] = []
): Instruction<'tempo'>[] {
    const msm = buildMsm(onsets);
    const mpm = new MPM();
    const transformer = new ApproximateLogarithmicTempo({
        scope: 'global',
        from, to, beatLength,
        silentOnsets
    });
    callTransform(transformer, msm, mpm);
    return mpm.getInstructions('tempo', 'global')
        .sort((a, b) => a.date - b.date);
}

/**
 * The last fitted segment carries a `transition.to` that nothing else closes, and an open
 * `transition.to` renders as a constant — the renderer drops the transition altogether. So the
 * fit writes one more instruction at the end of its span, holding the tempo the curve arrives
 * at. See issue #24.
 */
function expectClosedAt(tempos: Instruction<'tempo'>[], date: number) {
    const closing = tempos[tempos.length - 1];
    const fitted = tempos[tempos.length - 2];
    expect(closing.date).toBe(date);
    expect(closing.bpm).toBeCloseTo(bpmOf(fitted.transitionTo), 6);
    expect(closing.transitionTo).toBeUndefined();
    expect(closing.beatLength).toBe(fitted.beatLength);
}

// ── Tests ───────────────────────────────────────────────────────────

describe('ApproximateLogarithmicTempo', () => {

    test('constant tempo (100 BPM)', () => {
        const onsets = generateOnsets(() => 100, 4);
        const tempos = fitAndGetTempos(onsets, 0, 4 * BEAT, 0.25);

        expect(tempos).toHaveLength(1);
        expect(tempos[0].bpm).toBeCloseTo(100, 0);
        expect(tempos[0].transitionTo).toBeUndefined();
    });

    test('linear accelerando 80 → 120 BPM', () => {
        const totalTicks = 4 * BEAT;
        const onsets = generateOnsets(
            (d) => 80 + 40 * (d / totalTicks),
            4
        );
        const tempos = fitAndGetTempos(onsets, 0, totalTicks, 0.25);

        expect(tempos).toHaveLength(2);
        expectClosedAt(tempos, totalTicks);
        expect(tempos[0].bpm).toBeGreaterThan(77);
        expect(tempos[0].bpm).toBeLessThan(83);
        expect(tempos[0].transitionTo).toBeGreaterThan(117);
        expect(tempos[0].transitionTo).toBeLessThan(123);
        expect(tempos[0].meanTempoAt).toBeDefined();
        expect(tempos[0].meanTempoAt!).toBeGreaterThan(0.4);
        expect(tempos[0].meanTempoAt!).toBeLessThan(0.6);
    });

    test('linear ritardando 120 → 80 BPM', () => {
        const totalTicks = 4 * BEAT;
        const onsets = generateOnsets(
            (d) => 120 - 40 * (d / totalTicks),
            4
        );
        const tempos = fitAndGetTempos(onsets, 0, totalTicks, 0.25);

        expect(tempos).toHaveLength(2);
        expectClosedAt(tempos, totalTicks);
        expect(tempos[0].bpm).toBeGreaterThan(117);
        expect(tempos[0].bpm).toBeLessThan(123);
        expect(tempos[0].transitionTo).toBeGreaterThan(77);
        expect(tempos[0].transitionTo).toBeLessThan(83);
        expect(tempos[0].meanTempoAt!).toBeGreaterThan(0.4);
        expect(tempos[0].meanTempoAt!).toBeLessThan(0.6);
    });

    test('non-linear accelerando (im = 0.3) with 8 beats', () => {
        const totalTicks = 8 * BEAT;
        const p = Math.log(0.5) / Math.log(0.3);
        const onsets = generateOnsets(
            (d) => {
                const x = d / totalTicks;
                return 80 + 40 * Math.pow(Math.max(x, 0), p);
            },
            8
        );
        const tempos = fitAndGetTempos(onsets, 0, totalTicks, 0.25);

        expect(tempos).toHaveLength(2);
        expectClosedAt(tempos, totalTicks);
        expect(tempos[0].bpm).toBeGreaterThan(75);
        expect(tempos[0].bpm).toBeLessThan(95);
        expect(tempos[0].transitionTo).toBeGreaterThan(105);
        expect(tempos[0].transitionTo).toBeLessThan(125);
        expect(tempos[0].transitionTo!).toBeGreaterThan(bpmOf(tempos[0].bpm));
        expect(tempos[0].meanTempoAt).toBeDefined();
        expect(tempos[0].meanTempoAt!).toBeGreaterThan(0.1);
        expect(tempos[0].meanTempoAt!).toBeLessThan(0.9);
    });

    test('tempo bow: 80 → 120 → 80 (continue chaining)', () => {
        const halfTicks = 4 * BEAT;
        const totalTicks = 8 * BEAT;

        const onsets = generateOnsets((d) => {
            if (d <= halfTicks) {
                return 80 + 40 * (d / halfTicks);
            } else {
                return 120 - 40 * ((d - halfTicks) / halfTicks);
            }
        }, 8);

        const msm = buildMsm(onsets);
        const mpm = new MPM();

        // Fit first segment
        const t1 = new ApproximateLogarithmicTempo({
            scope: 'global', from: 0, to: halfTicks, beatLength: 0.25, silentOnsets: []
        });
        callTransform(t1, msm, mpm);

        // Fit second segment with continue — re-fits the whole chain jointly
        const t2 = new ApproximateLogarithmicTempo({
            scope: 'global', from: halfTicks, to: totalTicks, beatLength: 0.25,
            silentOnsets: [], continue: true
        });
        callTransform(t2, msm, mpm);

        const tempos = mpm.getInstructions('tempo', 'global')
            .sort((a, b) => a.date - b.date);

        expect(tempos).toHaveLength(3);
        expectClosedAt(tempos, totalTicks);
        expect(tempos[0].bpm).toBeGreaterThan(76);
        expect(tempos[0].bpm).toBeLessThan(84);
        expect(tempos[0].transitionTo).toBeGreaterThan(116);
        expect(tempos[0].transitionTo).toBeLessThan(124);
        expect(tempos[1].bpm).toBeGreaterThan(116);
        expect(tempos[1].bpm).toBeLessThan(124);
        expect(tempos[1].transitionTo).toBeGreaterThan(76);
        expect(tempos[1].transitionTo).toBeLessThan(84);
        expect(tempos[0].meanTempoAt!).toBeLessThan(0.5);
        expect(tempos[1].meanTempoAt!).toBeGreaterThan(0.5);
    });

    test('8-beat linear 60 → 120', () => {
        const totalTicks = 8 * BEAT;
        const onsets = generateOnsets(
            (d) => 60 + 60 * (d / totalTicks),
            8
        );
        const tempos = fitAndGetTempos(onsets, 0, totalTicks, 0.25);

        expect(tempos).toHaveLength(2);
        expectClosedAt(tempos, totalTicks);
        expect(tempos[0].bpm).toBeGreaterThan(57);
        expect(tempos[0].bpm).toBeLessThan(63);
        expect(tempos[0].transitionTo).toBeGreaterThan(117);
        expect(tempos[0].transitionTo).toBeLessThan(123);
    });

    test('meanTempoAt is in valid range for transitions', () => {
        const totalTicks = 4 * BEAT;
        const onsets = generateOnsets(
            (d) => 80 + 40 * (d / totalTicks),
            4
        );
        const tempos = fitAndGetTempos(onsets, 0, totalTicks, 0.25);

        expect(tempos[0].meanTempoAt).toBeDefined();
        expect(tempos[0].meanTempoAt!).toBeGreaterThanOrEqual(0.02);
        expect(tempos[0].meanTempoAt!).toBeLessThanOrEqual(0.98);
    });

    test('16-beat linear transition has better accuracy', () => {
        const totalTicks = 16 * BEAT;
        const onsets = generateOnsets(
            (d) => 80 + 40 * (d / totalTicks),
            16
        );
        const tempos = fitAndGetTempos(onsets, 0, totalTicks, 0.25);

        expect(tempos).toHaveLength(2);
        expectClosedAt(tempos, totalTicks);
        expect(tempos[0].bpm).toBeGreaterThan(78);
        expect(tempos[0].bpm).toBeLessThan(82);
        expect(tempos[0].transitionTo).toBeGreaterThan(118);
        expect(tempos[0].transitionTo).toBeLessThan(122);
    });

    test('rit → acc valley keeps a rounded two-segment gesture (continue)', () => {
        const halfTicks = 6 * BEAT;
        const totalTicks = 12 * BEAT;
        const pRit = imToExponent(0.3);
        const pAcc = imToExponent(0.7);

        const onsets = generateOnsets((d) => {
            if (d <= halfTicks) {
                const x = d / halfTicks;
                return 120 + (80 - 120) * Math.pow(Math.max(x, 0), pRit);
            }
            const x = (d - halfTicks) / halfTicks;
            return 80 + (120 - 80) * Math.pow(Math.max(x, 0), pAcc);
        }, 12);

        const msm = buildMsm(onsets);
        const mpm = new MPM();

        const t1 = new ApproximateLogarithmicTempo({
            scope: 'global', from: 0, to: halfTicks, beatLength: 0.25, silentOnsets: []
        });
        callTransform(t1, msm, mpm);

        const t2 = new ApproximateLogarithmicTempo({
            scope: 'global', from: halfTicks, to: totalTicks, beatLength: 0.25,
            silentOnsets: [], continue: true
        });
        callTransform(t2, msm, mpm);

        const tempos = mpm.getInstructions('tempo', 'global')
            .sort((a, b) => a.date - b.date);

        expect(tempos).toHaveLength(3);
        expectClosedAt(tempos, totalTicks);
        expect(tempos[0].meanTempoAt).toBeDefined();
        expect(tempos[1].meanTempoAt).toBeDefined();
        expect(tempos[0].meanTempoAt!).toBeLessThan(0.5);
        expect(tempos[1].meanTempoAt!).toBeGreaterThan(0.5);
        expect(tempos[0].meanTempoAt! + tempos[1].meanTempoAt!).toBeGreaterThan(0.85);
        expect(tempos[0].meanTempoAt! + tempos[1].meanTempoAt!).toBeLessThan(1.15);
        expect(Math.abs(bpmOf(tempos[0].transitionTo) - bpmOf(tempos[1].bpm))).toBeLessThan(2.5);
    });

    test('chained segments preserve inferred acc → rit direction (continue)', () => {
        const halfTicks = 4 * BEAT;
        const totalTicks = 8 * BEAT;

        const onsets = [
            { date: 0 * BEAT, onset: 0.0 },
            { date: 1 * BEAT, onset: 0.80 },
            { date: 2 * BEAT, onset: 1.53 },
            { date: 3 * BEAT, onset: 2.19 },
            { date: 4 * BEAT, onset: 2.80 },
            { date: 5 * BEAT, onset: 3.43 },
            { date: 6 * BEAT, onset: 4.10 },
            { date: 7 * BEAT, onset: 4.84 },
            { date: 8 * BEAT, onset: 5.65 }
        ];

        const msm = buildMsm(onsets);
        const mpm = new MPM();

        const t1 = new ApproximateLogarithmicTempo({
            scope: 'global', from: 0, to: halfTicks, beatLength: 0.25, silentOnsets: []
        });
        callTransform(t1, msm, mpm);

        const t2 = new ApproximateLogarithmicTempo({
            scope: 'global', from: halfTicks, to: totalTicks, beatLength: 0.25,
            silentOnsets: [], continue: true
        });
        callTransform(t2, msm, mpm);

        const tempos = mpm.getInstructions('tempo', 'global')
            .sort((a, b) => a.date - b.date);

        expect(tempos).toHaveLength(3);
        expectClosedAt(tempos, totalTicks);
        expect(tempos[0].transitionTo).toBeGreaterThan(bpmOf(tempos[0].bpm));
        expect(tempos[1].transitionTo).toBeLessThan(bpmOf(tempos[1].bpm));
    });

    test('keeps existing tempos unchanged when fitting yields no segments', () => {
        const msm = new MSM([], { numerator: 4, denominator: 4 });
        const mpm = new MPM();
        mpm.requireMap('tempo', 'global').addTempo({
            id: 'tempo_existing',
            date: 0,
            bpm: 88,
            beatLength: 0.25
        });

        const transformer = new ApproximateLogarithmicTempo({
            scope: 'global',
            from: 0, to: BEAT, beatLength: 0.25,
            silentOnsets: []
        });
        callTransform(transformer, msm, mpm);

        const tempos = mpm.getInstructions('tempo', 'global');
        expect(tempos).toHaveLength(1);
        expect(tempos[0].date).toBe(0);
        expect(tempos[0].bpm).toBe(88);
    });

    test('treats overlap as half-open and keeps touching end boundary instructions', () => {
        const msm = buildMsm([
            { date: BEAT, onset: 0 },
            { date: 2 * BEAT, onset: 1 }
        ]);
        const mpm = new MPM();
        const tempi = mpm.requireMap('tempo', 'global');
        tempi.addTempo({
            id: 'tempo_1',
            date: 0,
            bpm: 90,
            beatLength: 0.25
        });
        tempi.addTempo({
            id: 'tempo_2',
            date: BEAT,
            bpm: 91,
            beatLength: 0.25
        });
        tempi.addTempo({
            id: 'tempo_boundary',
            date: 2 * BEAT,
            bpm: 150,
            beatLength: 0.25
        });

        const transformer = new ApproximateLogarithmicTempo({
            scope: 'global',
            from: BEAT, to: 2 * BEAT, beatLength: 0.25,
            silentOnsets: []
        });
        callTransform(transformer, msm, mpm);

        const tempos = mpm.getInstructions('tempo', 'global');
        const touchingBoundary = tempos.find(t => t.date === 2 * BEAT);
        expect(touchingBoundary).toBeDefined();
        expect(touchingBoundary!.bpm).toBe(150);
        expect(tempos.find(t => t.date === (BEAT + BEAT / 2))).toBeUndefined();
    });

    test('restores a continuation tempo at segment end when removed tempo extends beyond', () => {
        const msm = buildMsm([
            { date: 0, onset: 0 },
            { date: BEAT, onset: 1 }
        ]);
        const mpm = new MPM();
        const tempi = mpm.requireMap('tempo', 'global');
        tempi.addTempo({
            id: 'tempo_1',
            date: 0,
            bpm: 50,
            beatLength: 0.25
        });
        tempi.addTempo({
            id: 'tempo_2',
            date: BEAT / 2,
            bpm: 200,
            beatLength: 0.25
        });

        const transformer = new ApproximateLogarithmicTempo({
            scope: 'global',
            from: 0, to: BEAT, beatLength: 0.25,
            silentOnsets: []
        });
        callTransform(transformer, msm, mpm);

        const tempos = mpm.getInstructions('tempo', 'global');
        const continuation = tempos.find(t => t.date === BEAT);
        expect(continuation).toBeDefined();
        expect(continuation!.bpm).toBeCloseTo(200, 4);
    });

    test('continue without predecessor works as normal single segment', () => {
        const totalTicks = 4 * BEAT;
        const onsets = generateOnsets(() => 100, 4);

        const msm = buildMsm(onsets);
        const mpm = new MPM();

        const transformer = new ApproximateLogarithmicTempo({
            scope: 'global', from: 0, to: totalTicks, beatLength: 0.25,
            silentOnsets: [], continue: true
        });
        callTransform(transformer, msm, mpm);

        const tempos = mpm.getInstructions('tempo', 'global');
        expect(tempos).toHaveLength(1);
        expect(tempos[0].bpm).toBeCloseTo(100, 0);
    });

    test('silentOnsets carrying another performance\'s timing cannot produce a negative BPM', () => {
        // Models the actual Träumerei pipeline:
        //
        // The segment for m2.2 covers dates 3600–5760 (beatLength=0.25).
        // info.json specifies a silentOnset at {date:5040, onset:7.7} — this
        // is from the REFERENCE performance (Welte-Mignon roll).
        //
        // After implantLocal(), the student's note onsets are much later
        // (student is consistently slower). After shiftToFirstOnset(),
        // student onsets around date 5040 might be ~10s, but the silentOnset
        // at 5040 is still 7.7s (reference timing, NOT adjusted).
        //
        // In extractOnsetPairs, silentOnsets take priority (set first).
        // This creates a backwards jump in the onset sequence:
        //   date 4320 → ~10.0s (student)
        //   date 5040 →  7.7s  (reference silentOnset!)  ← backwards!
        //   date 5760 → ~11.5s (student)
        //
        // The data is self-contradictory and no tempo curve describes it, so what the fit
        // returns is not the point. What is, is that it stays a tempo: the fit used to
        // extrapolate a sparse downward trend straight through zero and write a *negative* BPM,
        // which the renderer turns into negative elapsed time. Boundary tempos are now held to
        // the same 5–600 BPM band an inter-onset interval has to fall in to be believed, so a
        // fit with nothing to say saturates at the edge of that band instead of leaving it.

        // Student notes: monotonic but much slower than reference.
        // Reference would be at ~80 BPM; student at ~30 BPM.
        // After shiftToFirstOnset, student note at date 5040 ≈ 14s.
        // But silentOnset at 5040 = 7.7s (reference).
        const onsets = [
            { date: 0 * BEAT, onset: 0.0 },
            { date: 1 * BEAT, onset: 2.0 },  // ~30 BPM
            { date: 2 * BEAT, onset: 4.0 },
            { date: 3 * BEAT, onset: 6.0 },
            { date: 4 * BEAT, onset: 8.0 },
            { date: 5 * BEAT, onset: 10.0 },   // date=3600
            { date: 6 * BEAT, onset: 12.0 },   // date=4320
            { date: 7 * BEAT, onset: 14.0 },   // date=5040 (silentOnset overrides!)
            { date: 8 * BEAT, onset: 16.0 },   // date=5760
        ];

        // The silentOnset at date 5040 with reference timing 7.7s
        // will override the student's onset of 9.33s at that date.
        const silentOnsets: SilentOnset[] = [
            { date: 5040, onset: 7.7 },
        ];

        const tempos = fitAndGetTempos(onsets, 5 * BEAT, 8 * BEAT, 0.25, silentOnsets);

        expect(tempos).toHaveLength(2);
        for (const tempo of tempos) {
            for (const bpm of [tempo.bpm, tempo.transitionTo]) {
                if (bpm === undefined) continue;
                expect(Number.isFinite(bpm)).toBe(true);
                expect(bpm).toBeGreaterThanOrEqual(5);
                expect(bpm).toBeLessThanOrEqual(600);
            }
        }
    });

    // Superseded by test/roundtrip: the 'tempo: ritardando' and 'tempo: accelerando' cases
    // render the fit and measure the onset error in milliseconds, rather than asserting only
    // that the inter-onset intervals decrease.

    test('continue chain stops at different beatLength', () => {
        const onsets = generateOnsets(() => 100, 8);
        const msm = buildMsm(onsets);
        const mpm = new MPM();

        // Insert a predecessor with different beatLength
        mpm.requireMap('tempo', 'global').addTempo({
            id: 'tempo_other',
            date: 0,
            bpm: 60,
            beatLength: 0.5
        });

        // Fit segment starting at 4*BEAT with continue — should NOT chain with beatLength=0.5
        const transformer = new ApproximateLogarithmicTempo({
            scope: 'global', from: 4 * BEAT, to: 8 * BEAT, beatLength: 0.25,
            silentOnsets: [], continue: true
        });
        callTransform(transformer, msm, mpm);

        const tempos = mpm.getInstructions('tempo', 'global')
            .sort((a, b) => a.date - b.date);

        // The beatLength=0.5 instruction should be untouched
        expect(tempos.find(t => t.date === 0 && t.beatLength === 0.5)).toBeDefined();
        // The new segment should be fitted independently
        expect(tempos.find(t => t.date === 4 * BEAT && t.beatLength === 0.25)).toBeDefined();
    });
});

/**
 * Issue #39, measured the way the issue measured it.
 *
 * Every case here is a `<tempo>` the renderer can draw exactly, so a fitter that inverts the
 * renderer has to recover it to the last digit — anything above zero is the fitter's own error
 * and nothing else's. The `generateOnsets` cases above integrate the curve themselves and so
 * carry a quadrature difference of their own; these do not.
 *
 * The right-hand column is what the fitter measured when the issue was filed. It reported the
 * cause as the elapsed-time term being outweighted by the IOI term, and that turned out not to
 * be it: scored by the *old* objective the truth beat the fit by a factor of 300 000, so the
 * fitter was not choosing the wrong optimum but failing to reach its own. Its two steps
 * descended different functions, and on an accelerando the pair diverged — every figure got
 * monotonically worse for all 30 iterations and the loop stopped by running out of them.
 */
describe('recovering a curve the renderer can draw exactly (#39)', () => {
    const NBEATS = 16;

    // `bpm` and `to` are as wide as the attributes are, so a span refitted from what the document
    // says goes back in without a conversion step that could quietly change the number.
    const truthSpan = (
        bpm: number | string, to: number | string, im: number, beats: number
    ): TempoWithEndDate => ({
        id: 'truth', date: 0, endDate: beats * BEAT,
        beatLength: 0.25, bpm, transitionTo: to, meanTempoAt: im,
    });

    const renderOnsets = (span: TempoWithEndDate, beats: number) =>
        Array.from({ length: beats + 1 }, (_, beat) => ({
            date: beat * BEAT,
            onset: computeMillisecondsAt(beat * BEAT, span) / 1000,
        }));

    //                                                     was, at the time of the issue
    const cases: [number, number, number, string][] = [
        [60, 90, 0.50, '0.3 ms'],
        [90, 45, 0.70, '5.7 ms'],
        [120, 60, 0.25, '8.5 ms'],
        [72, 108, 0.65, '32.1 ms'],
        [60, 120, 0.30, '130.9 ms'],
        [60, 120, 0.70, '157.2 ms'],
        // The pair that made the asymmetry visible: same shape, same 2:1 ratio, and the
        // accelerando fitted 27 times worse than the ritardando.
        [45, 90, 0.70, '209.6 ms'],
        // Shapes at the ends of the writable range, which the renderer's Simpson rule integrates
        // least well and which a fit measured against anything else gets wrong by several ms.
        [60, 120, 0.05, 'untested'],
        [120, 60, 0.95, 'untested'],
    ];

    for (const [bpm, to, im, before] of cases) {
        test(`${bpm} → ${to} at im ${im} (was ${before} out)`, () => {
            const truth = truthSpan(bpm, to, im, NBEATS);
            const onsets = renderOnsets(truth, NBEATS);

            const fitted = ApproximateLogarithmicTempo.preview({
                scope: 'global', from: 0, to: NBEATS * BEAT, beatLength: 0.25, silentOnsets: [],
            }, buildMsm(onsets));

            expect(fitted).toHaveLength(1);
            const refit = truthSpan(
                fitted[0].bpm, fitted[0].transitionTo ?? fitted[0].bpm,
                fitted[0].meanTempoAt ?? 0.5, NBEATS);

            for (const { date, onset } of onsets) {
                expect(computeMillisecondsAt(date, refit) / 1000).toBeCloseTo(onset, 3);
            }
        });
    }

    test('a shorter segment is recovered as exactly as a long one', () => {
        // Four beats, five onsets, three unknowns. The old fitter needed length to average its
        // way past the IOI term's bias; this one is solving for the curve that produced the
        // onsets, so the shortest identifiable segment is enough.
        const truth = truthSpan(60, 120, 0.7, 4);
        const onsets = renderOnsets(truth, 4);

        const fitted = ApproximateLogarithmicTempo.preview({
            scope: 'global', from: 0, to: 4 * BEAT, beatLength: 0.25, silentOnsets: [],
        }, buildMsm(onsets));

        expect(fitted[0].bpm).toBeCloseTo(60, 2);
        expect(fitted[0].transitionTo!).toBeCloseTo(120, 2);
        expect(fitted[0].meanTempoAt!).toBeCloseTo(0.7, 3);
    });

    test('the fit is a chord\'s median onset, not whichever note is listed first', () => {
        // A spread chord: the notes of each beat are 40 ms apart, and the middle one is on the
        // beat. Reading the first note read the earliest of them, which is a 20 ms bias on
        // every onset in the piece — and a bias in the onsets is a bias in the tempo.
        const truth = truthSpan(90, 45, 0.7, 8);
        const beats = renderOnsets(truth, 8);
        const spread = [-0.02, 0, 0.02];
        const notes = beats.flatMap((beat, index) => spread.map((offset, voice) => ({
            'xml:id': `n_1_${index}_${voice}`, date: beat.date, part: 1,
            pitchname: 'g' as const, octave: 4 + voice, duration: BEAT, accidentals: 0,
            'midi.pitch': 67 + 12 * voice, 'midi.onset': beat.onset + offset,
            'midi.duration': 0.5, 'midi.velocity': 100,
        })));

        const fitted = ApproximateLogarithmicTempo.preview({
            scope: 'global', from: 0, to: 8 * BEAT, beatLength: 0.25, silentOnsets: [],
        }, new MSM(notes, { numerator: 4, denominator: 4 }));

        expect(fitted[0].bpm).toBeCloseTo(90, 2);
        expect(fitted[0].transitionTo!).toBeCloseTo(45, 2);
        expect(fitted[0].meanTempoAt!).toBeCloseTo(0.7, 3);
    });

    test('the same request twice gives the same answer', () => {
        // The shape search used to anneal, and a seeded anneal is only as reproducible as the
        // order it is seeded in. There is nothing random left in the fit.
        const truth = truthSpan(72, 108, 0.65, 12);
        const onsets = renderOnsets(truth, 12);
        const request = {
            scope: 'global' as const, from: 0, to: 12 * BEAT, beatLength: 0.25, silentOnsets: [],
        };
        const first = ApproximateLogarithmicTempo.preview(request, buildMsm(onsets));
        const second = ApproximateLogarithmicTempo.preview(request, buildMsm(onsets));

        expect(second[0].bpm).toBe(first[0].bpm);
        expect(second[0].transitionTo).toBe(first[0].transitionTo);
        expect(second[0].meanTempoAt).toBe(first[0].meanTempoAt);
    });
});
