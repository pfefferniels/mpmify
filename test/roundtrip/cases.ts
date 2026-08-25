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
        bounds: { onset: { mean: 1.5, max: 3.5 }, duration: { mean: 2.5, max: 7 }, velocity: { max: 0.5 } },
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
        // The mirror image of the ritardando above, and it fits far worse: the fitter's
        // elapsed-time constraint is outweighed by its IOI term. See issue #39.
        note: 'issue #39 — accelerandi fit worse than the mirror-image decelerandi',
        bounds: { onset: { mean: 7, max: 18 }, duration: { mean: 6, max: 18 }, velocity: { max: 0.5 } },
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
        note: 'issue #39 — the accelerando half carries the error',
        bounds: { onset: { mean: 4, max: 9 }, duration: { mean: 3, max: 8 }, velocity: { max: 0.5 } },
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
        bounds: { onset: { mean: 105, max: 300 }, duration: { mean: 80, max: 330 }, velocity: { max: 0.5 } },
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
        // Two identical rolls, and exactly one survives. The roll at date 0 starts 250 ms
        // *before* the beat, and `TranslatePhysicalTimeToTicks` has no tempo instruction
        // covering a negative time ("no tempo found for -250 ms"), so the frame converts to
        // NaN. `StylizeOrnamentation.asDef` then stamps `name.ref` on the ornament *before* its
        // caller decides whether to insert the def, so the NaN check skips the definition and
        // leaves the reference dangling. The roll at 1440 converts fine and round-trips exactly.
        //
        // A roll that begins before its beat is the ordinary case for an arpeggio, so this is
        // not a corner: every piece-initial ornament lands on it.
        note: 'issues #26, #28 — a pre-beat frame converts to NaN, and the skipped def leaves '
            + 'the @name.ref that was already stamped on the ornament',
        knownViolations: ['@name.ref resolves'],
        bounds: { onset: { mean: 55, max: 300 }, duration: { mean: 55, max: 300 }, velocity: { max: 0.5 } },
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
        // Nothing survives: the whole gradient is lost, both chords. An ornament fitted by
        // `InsertDynamicsGradient` carries no frame at all, but
        // `TranslatePhysicalTimeToTicks` stamps one on it anyway — `NaN`, converted from
        // nothing — which turns an ornament that had no frame into one with an unusable frame.
        // `StylizeOrnamentation` then skips every definition, and the `<style>` switch it
        // writes unconditionally names a `<styleDef>` that consequently never gets created.
        note: 'issue #28 — gradient-only ornaments are stripped, and the style switch is '
            + 'written whether or not any definition was',
        knownViolations: ['@name.ref resolves'],
        bounds: { onset: { max: 0.5 }, duration: { max: 0.5 }, velocity: { mean: 8, max: 30 } },
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
        // Both families on one chord, and both losses above compound. On top of them, the one
        // definition that does get written carries a `<temporalSpread>` and no
        // `<dynamicsGradient>` at all, even though its ornament carries `scale="25"`:
        // `asDef` guards the gradient with `transition.from !== undefined && transition.to`,
        // and `transition.to` is **0** for a crescendo — falsy, so the gradient is dropped.
        // mpmify's own default is `crescendo: { from: -1, to: 0 }`, so this fires on the
        // default configuration rather than on some unusual value.
        note: 'issues #26, #28, #46 — truthiness guards the gradient, and 0 is a legal '
            + 'transition.to that mpmify itself emits by default',
        knownViolations: ['@name.ref resolves'],
        bounds: { onset: { mean: 55, max: 300 }, duration: { mean: 55, max: 300 }, velocity: { mean: 8, max: 30 } },
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
        bounds: { onset: { mean: 0.5, max: 1 }, duration: { mean: 0.5, max: 1 }, velocity: { mean: 0.9, max: 2 } },
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
        bounds: { onset: { mean: 0.5, max: 1 }, duration: { mean: 0.5, max: 1 }, velocity: { mean: 17, max: 35 } },
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
        note: 'issue #27 — a frame boundary leaves notes without a tick date',
        bounds: { onset: { mean: 195, max: 430 }, duration: { mean: 130, max: 600 }, velocity: { max: 0.5 } },
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
        note: 'issue #39 — the accelerando dominates',
        bounds: { onset: { mean: 240, max: 1070 }, duration: { mean: 820, max: 1480 }, velocity: { mean: 8, max: 20 } },
    },
    {
        name: 'all five aspects, boundaries withheld',
        score: { beats: 17 },
        discoverBoundaries: true,
        truth: EVERYTHING,
        // One fitting window over the whole piece for both tempo and dynamics, and one
        // articulation call that has to cluster itself back apart. `StylizeArticulation` is what
        // should do that clustering, and issue #25 says it cannot: it clusters on the very
        // attributes `InsertArticulation` has just blanked.
        note: 'issue #25 — the chain cannot recover the segmentation it was not given',
        bounds: { onset: { mean: 265, max: 1410 }, duration: { mean: 1310, max: 3070 }, velocity: { mean: 17, max: 31 } },
    },
]

export const allCases = [...tierTwoCases, ...tierThreeCases]
