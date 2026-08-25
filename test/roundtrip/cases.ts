import { Case } from "./harness"
import { QUARTER } from "./score"

/**
 * The coverage matrix.
 *
 * Every case's truth is **exactly representable in MPM** — it *is* an MPM document — so a
 * perfect chain would round-trip it to zero error. Whatever a bound admits above zero is a
 * measured gap in mpmify, and `note` says what causes it. Tightening a bound is what "fixed"
 * means for the issue it names; loosening one without a reason is the regression this file
 * exists to catch.
 *
 * Bounds are in milliseconds (onset, duration) and MIDI velocity units.
 */

const END = 7 * QUARTER
const EIGHT_BEATS = { beats: 8 }

/** A tempo map every case can borrow: constant, so it contributes nothing to the error. */
const STEADY_TEMPO = [{ date: 0, bpm: 120 }]

export const tierTwoCases: Case[] = [
    {
        name: 'tempo: constant',
        score: EIGHT_BEATS,
        truth: { tempo: [{ date: 0, bpm: 100 }] },
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { max: 0.5 } },
    },
    {
        name: 'tempo: ritardando 120 to 60',
        score: EIGHT_BEATS,
        truth: {
            tempo: [
                { date: 0, bpm: 120, 'transition.to': 60, meanTempoAt: 0.5 },
                { date: END, bpm: 60 },
            ],
        },
        // Exact since #39. It was mean 0.88 / max 2.10.
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { max: 0.5 } },
    },
    {
        name: 'tempo: accelerando 60 to 120',
        score: EIGHT_BEATS,
        truth: {
            tempo: [
                { date: 0, bpm: 60, 'transition.to': 120, meanTempoAt: 0.5 },
                { date: END, bpm: 120 },
            ],
        },
        // The mirror image of the ritardando above, and it used to fit five times worse — mean
        // 4.42 / max 12.18 against 0.88 / 2.10 — because the fitter's two steps descended
        // different objectives and the pair diverged on an accelerando. Both are exact now (#39).
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { max: 0.5 } },
    },
    {
        name: 'tempo: two segments, slower then faster',
        score: { beats: 17 },
        truth: {
            tempo: [
                { date: 0, bpm: 100, 'transition.to': 70, meanTempoAt: 0.5 },
                { date: 8 * QUARTER, bpm: 70, 'transition.to': 110, meanTempoAt: 0.5 },
                { date: 16 * QUARTER, bpm: 110 },
            ],
        },
        // All of what is left is `TURNING_EPS`. The fit is at the optimum the rounding prior
        // allows — 100.44 → 70.51 → 110.87 against a truth of 100 → 70 → 110 — but that prior
        // forbids a *linear* shape either side of a turn, and this truth is linear on both
        // sides: the shapes are held at 0.48 and 0.52 where 0.5 would round-trip exactly. The
        // single-segment cases above, which have no turn, are exact.
        note: 'the rounded-turn prior cannot represent a linear approach to a turn',
        bounds: { onset: { mean: 4, max: 12 }, duration: { mean: 2.5, max: 6.5 }, velocity: { max: 0.5 } },
    },
    {
        name: 'dynamics: constant',
        score: EIGHT_BEATS,
        truth: { tempo: STEADY_TEMPO, dynamics: [{ date: 0, volume: 70 }] },
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { max: 0.5 } },
    },
    {
        name: 'dynamics: linear crescendo 40 to 100',
        score: EIGHT_BEATS,
        truth: {
            tempo: STEADY_TEMPO,
            dynamics: [
                { date: 0, volume: 40, 'transition.to': 100, curvature: 0, protraction: 0 },
                { date: END, volume: 100 },
            ],
        },
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { mean: 0.8, max: 1.8 } },
    },
    {
        name: 'dynamics: curved diminuendo',
        score: EIGHT_BEATS,
        truth: {
            tempo: STEADY_TEMPO,
            dynamics: [
                { date: 0, volume: 110, 'transition.to': 45, curvature: 0.4, protraction: 0.3 },
                { date: END, volume: 45 },
            ],
        },
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { mean: 0.9, max: 2.6 } },
    },
    {
        name: 'dynamics: two segments, swell then fall',
        score: { beats: 17 },
        truth: {
            tempo: STEADY_TEMPO,
            dynamics: [
                { date: 0, volume: 45, 'transition.to': 105, curvature: 0, protraction: 0 },
                { date: 8 * QUARTER, volume: 105, 'transition.to': 55, curvature: 0, protraction: 0 },
                { date: 16 * QUARTER, volume: 55 },
            ],
        },
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { mean: 0.9, max: 1.9 } },
    },
    {
        name: 'articulation: one legato for every note',
        score: EIGHT_BEATS,
        truth: {
            tempo: STEADY_TEMPO,
            dynamics: [{ date: 0, volume: 64 }],
            articulation: {
                defs: [{ name: 'legato', relativeDuration: 1.3 }],
                defaultArticulation: 'legato',
            },
        },
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { max: 0.5 } },
    },
    {
        name: 'articulation: a chord, every note the same shortening',
        // The case #53 needed and no other case here provides: notes that share a date *and* an
        // articulation unit. `InsertArticulation` used to fold those into one instruction
        // carrying `noteid="#a #b #c"`, which names no note at all — so every articulation on a
        // chord was inert, and the whole chord rendered at its written length. Every other
        // articulation case is monophonic, which is why 78 green tests never saw it.
        score: { beats: 8, pitches: [60, 64, 67] },
        truth: {
            tempo: STEADY_TEMPO,
            dynamics: [{ date: 0, volume: 64 }],
            articulation: {
                defs: [{ name: 'staccato', relativeDuration: 0.5 }],
                defaultArticulation: 'staccato',
            },
        },
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { max: 0.5 } },
    },
    {
        name: 'articulation: alternating relativeVelocity 1.4 / 0.7',
        score: EIGHT_BEATS,
        truth: {
            tempo: STEADY_TEMPO,
            dynamics: [{ date: 0, volume: 64 }],
            articulation: {
                defs: [
                    { name: 'loud', relativeVelocity: 1.4 },
                    { name: 'soft', relativeVelocity: 0.7 },
                ],
                pattern: ['loud', 'soft'],
            },
        },
        // Issue #23 is fixed, and this bound is *not* what is left of it: with one articulation
        // unit per note the round trip is exact, which tier 1 asserts to six decimals. What
        // remains is the averaging. `InsertArticulation` writes one ratio per unit — the mean of
        // its notes — and the fitted dynamics curve here is a descending ramp (the fitter sees
        // the alternation as a diminuendo), so the notes in one unit sit at different points on
        // it and their `recorded/prescribed` ratios differ. One average cannot satisfy all of
        // them. That is an ordering problem, not an arithmetic one: dynamics is fitted before
        // articulation is known.
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { mean: 26, max: 55 } },
    },
    {
        name: 'articulation: alternating relativeDuration 1.4 / 0.5',
        score: EIGHT_BEATS,
        truth: {
            tempo: STEADY_TEMPO,
            dynamics: [{ date: 0, volume: 64 }],
            articulation: {
                defs: [
                    { name: 'long', relativeDuration: 1.4 },
                    { name: 'short', relativeDuration: 0.5 },
                ],
                pattern: ['long', 'short'],
            },
        },
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { max: 0.5 } },
    },
    {
        name: 'rubato: one looping frame, intensity 0.7',
        score: EIGHT_BEATS,
        // Nothing but rubato is in the truth, yet the error is in the hundreds of milliseconds:
        // the tempo fitter runs first, over onsets the rubato has already warped, and explains
        // them as an accelerando. The audit's map ablation says the same thing from the other
        // end — timing error is essentially all tempo.
        truth: {
            tempo: STEADY_TEMPO,
            rubato: [{ date: 0, frameLength: 4 * QUARTER, intensity: 0.7, loop: true }],
        },
        // The figures here rose with #39 — onset was mean 25.04 / max 130.95 — and rose for the
        // reason above rather than against it. The tempo fitter now reproduces the onsets it is
        // given, and the onsets it is given are warped, so more of the warp ends up in the tempo
        // curve: over a window that is 1.75 rubato frames long, a steady 120 comes back as
        // 54 → 128. Fitting tempo and rubato in sequence is the defect, not the fitter.
        bounds: { onset: { mean: 105, max: 260 }, duration: { mean: 80, max: 140 }, velocity: { max: 0.5 } },
    },
    {
        name: 'accentuation: 4/4 metrical pattern',
        // Nine beats, not eight: a metrical cell is one bar and its last sample is the *next*
        // bar's downbeat, so a piece that stops mid-bar leaves the final cell unable to close.
        score: { beats: 9 },
        truth: {
            tempo: STEADY_TEMPO,
            dynamics: [{ date: 0, volume: 64 }],
            accentuation: {
                date: 0, name: 'metre', length: 4, scale: 1, loop: true,
                accentuations: [
                    { beat: 1, value: 20 }, { beat: 2, value: 4 },
                    { beat: 3, value: 12 }, { beat: 4, value: 0 },
                ],
            },
        },
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { max: 0.5 } },
    },
    {
        name: 'ornamentation: rolled chords',
        // Three notes to a beat, so there is a chord to roll at all.
        score: { beats: 4, pitches: [60, 64, 67] },
        truth: {
            tempo: STEADY_TEMPO,
            dynamics: [{ date: 0, volume: 64 }],
            ornamentation: {
                defs: [{
                    name: 'roll',
                    temporalSpread: {
                        'frame.start': -250, frameLength: 500,
                        'time.unit': 'milliseconds', intensity: 1,
                    },
                }],
                instructions: [
                    { date: 0, 'name.ref': 'roll' },
                    { date: 2 * QUARTER, 'name.ref': 'roll' },
                ],
            },
        },
        // Both rolls survive now, and the fitted frame is exact: -360 ticks over 720, which is
        // -250 ms over 500 at this tempo. What is left is the renderer's, not mpmify's.
        //
        // espressivo performs any ornament frame that *begins* before the first <tempo> at its
        // no-tempo default of 100 bpm, ignoring the tempo map for that frame entirely — measured
        // by rendering one frame at 60, 100 and 120 bpm and getting 600 ms every time, while the
        // identical frame one bar later gives 1000, 600 and 500. So the roll on beat 1 comes out
        // 20% wide here and the roll at 1440 comes out exact.
        //
        // mpmify could match that by converting pre-piece frames at 100 bpm, and should not: it
        // would bake one renderer's fallback into the document and mean something else anywhere
        // else. The 50 ms is recorded rather than fitted away.
        note: 'espressivo renders a frame beginning before the first <tempo> at its 100 bpm '
            + 'default, whatever the tempo map says',
        bounds: { onset: { mean: 11, max: 60 }, duration: { mean: 11, max: 60 }, velocity: { max: 0.5 } },
    },
    {
        name: 'ornamentation: velocity gradient across the chord',
        score: { beats: 4, pitches: [60, 64, 67] },
        truth: {
            tempo: STEADY_TEMPO,
            dynamics: [{ date: 0, volume: 64 }],
            ornamentation: {
                defs: [{
                    name: 'ramp',
                    dynamicsGradient: { 'transition.from': -1, 'transition.to': 0 },
                }],
                // @scale gates the gradient entirely — without it the def performs nothing and
                // this case would round-trip a plain chord. See the note on the field.
                instructions: [
                    { date: 0, 'name.ref': 'ramp', scale: 25 },
                    { date: 2 * QUARTER, 'name.ref': 'ramp', scale: 25 },
                ],
            },
        },
        // Exact. This case used to lose the gradient entirely — an ornament with a ramp and no
        // roll was given a NaN frame by the tick translation, then discarded by the clustering,
        // which keys on the frame. It now keeps its ramp and gets a definition of its own.
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { max: 0.5 } },
    },
    {
        name: 'ornamentation: a roll that also swells',
        score: { beats: 4, pitches: [60, 64, 67] },
        truth: {
            tempo: STEADY_TEMPO,
            dynamics: [{ date: 0, volume: 64 }],
            ornamentation: {
                defs: [{
                    name: 'roll',
                    temporalSpread: {
                        'frame.start': -250, frameLength: 500,
                        'time.unit': 'milliseconds', intensity: 1,
                    },
                    dynamicsGradient: { 'transition.from': -1, 'transition.to': 0 },
                }],
                instructions: [
                    { date: 0, 'name.ref': 'roll', scale: 25 },
                    { date: 2 * QUARTER, 'name.ref': 'roll', scale: 25 },
                ],
            },
        },
        // Exact in velocity. This case came back mirrored — 64/51.5/39 against a truth of
        // 39/51.5/64 — for two reasons that had to be fixed together, and each of which hid the
        // other. The registry ran the spread before the gradient, so the gradient read its
        // direction off onsets the spread had just collapsed (#32); and the clustering's merge
        // read the two `transition.*` one index short of where they sit, so a correctly fitted
        // ramp was reversed again on its way into the definition.
        //
        // The onset bound is the renderer behaviour described on the rolled-chords case above.
        bounds: { onset: { mean: 11, max: 60 }, duration: { mean: 11, max: 60 }, velocity: { max: 0.5 } },
    },
]

/**
 * The truth both "all five aspects" cases below share. They differ in exactly one thing —
 * whether the chain is handed the segmentation — so the gap between their bounds is what
 * knowing the boundaries is worth.
 */
const EVERYTHING = {
    tempo: [
        { date: 0, bpm: 105, 'transition.to': 78, meanTempoAt: 0.5 },
        { date: 8 * QUARTER, bpm: 78, 'transition.to': 96, meanTempoAt: 0.5 },
        { date: 16 * QUARTER, bpm: 96 },
    ],
    dynamics: [
        { date: 0, volume: 48, 'transition.to': 98, curvature: 0.2, protraction: 0 },
        { date: 8 * QUARTER, volume: 98, 'transition.to': 60, curvature: 0, protraction: 0 },
        { date: 16 * QUARTER, volume: 60 },
    ],
    rubato: [{ date: 0, frameLength: 4 * QUARTER, intensity: 0.6, loop: true }],
    accentuation: {
        date: 0, name: 'metre', length: 4, scale: 1, loop: true,
        accentuations: [
            { beat: 1, value: 14 }, { beat: 2, value: 2 },
            { beat: 3, value: 8 }, { beat: 4, value: 0 },
        ],
    },
    articulation: {
        defs: [
            { name: 'loud', relativeVelocity: 1.3, relativeDuration: 1.15 },
            { name: 'soft', relativeVelocity: 0.8, relativeDuration: 0.65 },
        ],
        pattern: ['loud', 'soft'],
    },
}

export const tierThreeCases: Case[] = [
    {
        name: 'tempo + dynamics',
        score: EIGHT_BEATS,
        truth: {
            tempo: [
                { date: 0, bpm: 110, 'transition.to': 75, meanTempoAt: 0.5 },
                { date: END, bpm: 75 },
            ],
            dynamics: [
                { date: 0, volume: 50, 'transition.to': 100, curvature: 0, protraction: 0 },
                { date: END, volume: 100 },
            ],
        },
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { mean: 0.9, max: 2 } },
    },
    {
        name: 'tempo + dynamics + alternating articulation',
        score: EIGHT_BEATS,
        truth: {
            tempo: [
                { date: 0, bpm: 110, 'transition.to': 75, meanTempoAt: 0.5 },
                { date: END, bpm: 75 },
            ],
            dynamics: [
                { date: 0, volume: 50, 'transition.to': 100, curvature: 0, protraction: 0 },
                { date: END, volume: 100 },
            ],
            articulation: {
                defs: [
                    { name: 'loud', relativeVelocity: 1.35, relativeDuration: 1.2 },
                    { name: 'soft', relativeVelocity: 0.75, relativeDuration: 0.6 },
                ],
                pattern: ['loud', 'soft'],
            },
        },
        // A moving dynamics curve under a per-note articulation: the same averaging limit as
        // the tier-2 case above, now with a curve that moves for a second reason.
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { mean: 17, max: 35 } },
    },
    {
        name: 'tempo + rubato',
        score: EIGHT_BEATS,
        truth: {
            tempo: [
                { date: 0, bpm: 100, 'transition.to': 80, meanTempoAt: 0.5 },
                { date: END, bpm: 80 },
            ],
            rubato: [{ date: 0, frameLength: 4 * QUARTER, intensity: 0.65, loop: true }],
        },
        // This used to be recorded as issue #27, and it is not. Fixing #27 left every figure in
        // this row unchanged to the last digit, which says two things: the residual here is the
        // same tempo-runs-first-over-warped-onsets ordering as the rubato-only case above,
        // amplified because the tempo moves as well — and the round trip cannot see #27 at all.
        //
        // It cannot, by construction. Every performance in this suite is rendered from its own
        // truth MPM, so a note lands exactly where the tempo predicts and no note sounds ahead of
        // its predecessor. `measuredMs` therefore tracks `modelledMs` closely enough that no
        // event crosses a window boundary, and nothing is released past the final modelled
        // moment. Both #26 and #27 need a recording that disagrees with its notation, which is
        // what an alignment is and what a render is not. They are covered in test/tempo instead.
        note: 'the tempo fitter runs first, over onsets the rubato has already warped, and a '
            + 'moving tempo gives it more room to explain them away than the steady one above',
        bounds: { onset: { mean: 145, max: 410 }, duration: { mean: 165, max: 290 }, velocity: { max: 0.5 } },
    },
    {
        name: 'tempo + dynamics + accentuation',
        score: { beats: 9 },
        truth: {
            tempo: [
                { date: 0, bpm: 100, 'transition.to': 80, meanTempoAt: 0.5 },
                { date: END, bpm: 80 },
            ],
            dynamics: [
                { date: 0, volume: 55, 'transition.to': 95, curvature: 0, protraction: 0 },
                { date: END, volume: 95 },
            ],
            accentuation: {
                date: 0, name: 'metre', length: 4, scale: 1, loop: true,
                accentuations: [
                    { beat: 1, value: 16 }, { beat: 2, value: 2 },
                    { beat: 3, value: 9 }, { beat: 4, value: 0 },
                ],
            },
        },
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { mean: 0.7, max: 1.6 } },
    },
    {
        name: 'all five aspects at once',
        score: { beats: 17 },
        truth: EVERYTHING,
        // The one row in this file where #39 moved a figure the wrong way, and it is the same
        // ordering as the two rubato cases above. Every parameter got closer to the truth — the
        // shared boundary tempo lands on 78.12 against a truth of 78, where it used to be a flat
        // 94 followed by a ramp to 387 BPM, and the four rubato intensities cluster at
        // 0.64–0.80 against a truth of 0.6 where they used to spread over 0.28–0.68. Three of
        // the four timing figures improved with them: worst onset 822 → 575, duration 458 → 310
        // mean and 1011 → 752 max. Mean onset went 181 → 317, because a tempo curve that now
        // reproduces the onsets it was handed reproduces the rubato in them too, and leaves the
        // rubato fitter a residual that is no longer the warp it is built to describe.
        note: 'tempo is fitted before rubato, over onsets rubato has already warped',
        bounds: { onset: { mean: 415, max: 750 }, duration: { mean: 405, max: 980 }, velocity: { mean: 8, max: 20 } },
    },
    {
        name: 'all five aspects, boundaries withheld',
        score: { beats: 17 },
        discoverBoundaries: true,
        truth: EVERYTHING,
        // One fitting window over the whole piece for both tempo and dynamics, and one
        // articulation call that has to cluster itself back apart. `StylizeArticulation` is what
        // should do that clustering, and since issue #25 it runs: it reads what an
        // `<articulation>` articulates through the def its `@name.ref` names rather than off the
        // attributes `InsertArticulation` has just blanked, and the seventeen instructions here
        // are folded into one `defaultArticulation` instead of being labelled noise.
        //
        // What it still cannot do is recover a segmentation that is no longer in the document to
        // recover. A single `InsertArticulation` writes a single def holding the mean of every
        // note it covers — 0.79 / 1.03 here, against a truth that alternates 1.15 / 1.3 with
        // 0.65 / 0.8 — so the seventeen points offered to dbscan are seventeen copies of one
        // value and there is exactly one cluster. The figures below did not move when #25 was
        // fixed, for that reason: what changed is the document, not what it renders as.
        note: 'one articulation unit averages the alternation away before clustering can see it',
        bounds: { onset: { mean: 210, max: 490 }, duration: { mean: 330, max: 1350 }, velocity: { mean: 17, max: 31 } },
    },
]

export const allCases = [...tierTwoCases, ...tierThreeCases]
