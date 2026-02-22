// @vitest-environment jsdom

import { describe, test, expect } from "vitest"
import { MSM } from "../../src/msm"
import { MPM, Tempo } from "mpm-ts"
import { ApproximateLogarithmicTempo, SilentOnset } from "../../src/transformers/tempo/ApproximateLogarithmicTempo"

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
 * Run the fitter for a single segment and return tempo instructions
 */
function fitAndGetTempos(
    onsets: { date: number; onset: number }[],
    from: number, to: number, beatLength: number,
    silentOnsets: SilentOnset[] = []
): Tempo[] {
    const msm = buildMsm(onsets);
    const mpm = new MPM();
    const transformer = new ApproximateLogarithmicTempo({
        scope: 'global',
        from, to, beatLength,
        silentOnsets
    });
    callTransform(transformer, msm, mpm);
    return mpm.getInstructions<Tempo>('tempo', 'global');
}

// ── Tests ───────────────────────────────────────────────────────────

describe('ApproximateLogarithmicTempo', () => {

    test('constant tempo (100 BPM)', () => {
        const onsets = generateOnsets(() => 100, 4);
        const tempos = fitAndGetTempos(onsets, 0, 4 * BEAT, 0.25);

        expect(tempos).toHaveLength(1);
        expect(tempos[0].bpm).toBeCloseTo(100, 0);
        expect(tempos[0]['transition.to']).toBeUndefined();
    });

    test('linear accelerando 80 → 120 BPM', () => {
        const totalTicks = 4 * BEAT;
        const onsets = generateOnsets(
            (d) => 80 + 40 * (d / totalTicks),
            4
        );
        const tempos = fitAndGetTempos(onsets, 0, totalTicks, 0.25);

        expect(tempos).toHaveLength(1);
        expect(tempos[0].bpm).toBeGreaterThan(77);
        expect(tempos[0].bpm).toBeLessThan(83);
        expect(tempos[0]['transition.to']).toBeGreaterThan(117);
        expect(tempos[0]['transition.to']).toBeLessThan(123);
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

        expect(tempos).toHaveLength(1);
        expect(tempos[0].bpm).toBeGreaterThan(117);
        expect(tempos[0].bpm).toBeLessThan(123);
        expect(tempos[0]['transition.to']).toBeGreaterThan(77);
        expect(tempos[0]['transition.to']).toBeLessThan(83);
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

        expect(tempos).toHaveLength(1);
        expect(tempos[0].bpm).toBeGreaterThan(75);
        expect(tempos[0].bpm).toBeLessThan(95);
        expect(tempos[0]['transition.to']).toBeGreaterThan(105);
        expect(tempos[0]['transition.to']).toBeLessThan(125);
        expect(tempos[0]['transition.to']!).toBeGreaterThan(tempos[0].bpm);
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

        const tempos = mpm.getInstructions<Tempo>('tempo', 'global')
            .sort((a, b) => a.date - b.date);

        expect(tempos).toHaveLength(2);
        expect(tempos[0].bpm).toBeGreaterThan(76);
        expect(tempos[0].bpm).toBeLessThan(84);
        expect(tempos[0]['transition.to']).toBeGreaterThan(116);
        expect(tempos[0]['transition.to']).toBeLessThan(124);
        expect(tempos[1].bpm).toBeGreaterThan(116);
        expect(tempos[1].bpm).toBeLessThan(124);
        expect(tempos[1]['transition.to']).toBeGreaterThan(76);
        expect(tempos[1]['transition.to']).toBeLessThan(84);
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

        expect(tempos).toHaveLength(1);
        expect(tempos[0].bpm).toBeGreaterThan(57);
        expect(tempos[0].bpm).toBeLessThan(63);
        expect(tempos[0]['transition.to']).toBeGreaterThan(117);
        expect(tempos[0]['transition.to']).toBeLessThan(123);
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

        expect(tempos).toHaveLength(1);
        expect(tempos[0].bpm).toBeGreaterThan(78);
        expect(tempos[0].bpm).toBeLessThan(82);
        expect(tempos[0]['transition.to']).toBeGreaterThan(118);
        expect(tempos[0]['transition.to']).toBeLessThan(122);
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

        const tempos = mpm.getInstructions<Tempo>('tempo', 'global')
            .sort((a, b) => a.date - b.date);

        expect(tempos).toHaveLength(2);
        expect(tempos[0].meanTempoAt).toBeDefined();
        expect(tempos[1].meanTempoAt).toBeDefined();
        expect(tempos[0].meanTempoAt!).toBeLessThan(0.5);
        expect(tempos[1].meanTempoAt!).toBeGreaterThan(0.5);
        expect(tempos[0].meanTempoAt! + tempos[1].meanTempoAt!).toBeGreaterThan(0.85);
        expect(tempos[0].meanTempoAt! + tempos[1].meanTempoAt!).toBeLessThan(1.15);
        expect(Math.abs(tempos[0]['transition.to']! - tempos[1].bpm)).toBeLessThan(2.5);
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

        const tempos = mpm.getInstructions<Tempo>('tempo', 'global')
            .sort((a, b) => a.date - b.date);

        expect(tempos).toHaveLength(2);
        expect(tempos[0]['transition.to']).toBeGreaterThan(tempos[0].bpm);
        expect(tempos[1]['transition.to']).toBeLessThan(tempos[1].bpm);
    });

    test('keeps existing tempos unchanged when fitting yields no segments', () => {
        const msm = new MSM([], { numerator: 4, denominator: 4 });
        const mpm = new MPM();
        mpm.insertInstruction({
            type: 'tempo',
            'xml:id': 'tempo_existing',
            date: 0,
            bpm: 88,
            beatLength: 0.25
        }, 'global');

        const transformer = new ApproximateLogarithmicTempo({
            scope: 'global',
            from: 0, to: BEAT, beatLength: 0.25,
            silentOnsets: []
        });
        callTransform(transformer, msm, mpm);

        const tempos = mpm.getInstructions<Tempo>('tempo', 'global');
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
        mpm.insertInstructions([
            {
                type: 'tempo',
                'xml:id': 'tempo_1',
                date: 0,
                bpm: 90,
                beatLength: 0.25
            },
            {
                type: 'tempo',
                'xml:id': 'tempo_2',
                date: BEAT,
                bpm: 91,
                beatLength: 0.25
            },
            {
                type: 'tempo',
                'xml:id': 'tempo_boundary',
                date: 2 * BEAT,
                bpm: 150,
                beatLength: 0.25
            }
        ], 'global');

        const transformer = new ApproximateLogarithmicTempo({
            scope: 'global',
            from: BEAT, to: 2 * BEAT, beatLength: 0.25,
            silentOnsets: []
        });
        callTransform(transformer, msm, mpm);

        const tempos = mpm.getInstructions<Tempo>('tempo', 'global');
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
        mpm.insertInstructions([
            {
                type: 'tempo',
                'xml:id': 'tempo_1',
                date: 0,
                bpm: 50,
                beatLength: 0.25
            },
            {
                type: 'tempo',
                'xml:id': 'tempo_2',
                date: BEAT / 2,
                bpm: 200,
                beatLength: 0.25
            }
        ], 'global');

        const transformer = new ApproximateLogarithmicTempo({
            scope: 'global',
            from: 0, to: BEAT, beatLength: 0.25,
            silentOnsets: []
        });
        callTransform(transformer, msm, mpm);

        const tempos = mpm.getInstructions<Tempo>('tempo', 'global');
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

        const tempos = mpm.getInstructions<Tempo>('tempo', 'global');
        expect(tempos).toHaveLength(1);
        expect(tempos[0].bpm).toBeCloseTo(100, 0);
    });

    test('continue chain stops at different beatLength', () => {
        const onsets = generateOnsets(() => 100, 8);
        const msm = buildMsm(onsets);
        const mpm = new MPM();

        // Insert a predecessor with different beatLength
        mpm.insertInstruction({
            type: 'tempo',
            'xml:id': 'tempo_other',
            date: 0,
            bpm: 60,
            beatLength: 0.5
        }, 'global');

        // Fit segment starting at 4*BEAT with continue — should NOT chain with beatLength=0.5
        const transformer = new ApproximateLogarithmicTempo({
            scope: 'global', from: 4 * BEAT, to: 8 * BEAT, beatLength: 0.25,
            silentOnsets: [], continue: true
        });
        callTransform(transformer, msm, mpm);

        const tempos = mpm.getInstructions<Tempo>('tempo', 'global')
            .sort((a, b) => a.date - b.date);

        // The beatLength=0.5 instruction should be untouched
        expect(tempos.find(t => t.date === 0 && t.beatLength === 0.5)).toBeDefined();
        // The new segment should be fitted independently
        expect(tempos.find(t => t.date === 4 * BEAT && t.beatLength === 0.25)).toBeDefined();
    });
});
