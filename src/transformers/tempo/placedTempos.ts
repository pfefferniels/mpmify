/**
 * The piece cut into tempo segments, with the millisecond timeline anchored on the recording.
 *
 * ## Why this exists
 *
 * Four functions used to walk the tempo list themselves — `addTickOnsets`, `addTickDurations`,
 * `TranslatePhysicalTimeToTicks.msToTicks` and `.ticksToMs` — and each carried its own copy of
 * the same loop: close the instruction against the next one, convert the span to milliseconds,
 * and advance a running cursor. That loop encodes the single most consequential rule in mpmify:
 *
 * > **At every tempo boundary the cursor is re-anchored on the recorded onset of the note sitting
 * > on it, not on the tempo's own prediction.**
 *
 * It is what keeps one segment's error out of the next, and it is why the tick domain cannot be
 * recovered by inverting a rendered performance — a render has no recording to anchor to. A rule
 * that load-bearing should exist once. In four hand-copies it had already diverged: two looked
 * the anchor up in `msm.notesInPart(scope)` and two in `msm.allNotes`, so in a piece with
 * part-scoped tempo maps the latter two anchored on notes from a different part than the one
 * whose tempo they were walking.
 *
 * ## Modelled and measured
 *
 * A segment has two lengths and they are not the same number:
 *
 * - {@link PlacedTempo.modelledMs} — what the `<tempo>` says it lasts.
 * - {@link PlacedTempo.measuredMs} — what the recording says it lasts, when a note lands on the
 *   boundary to say so; {@link PlacedTempo.modelledMs} when none does.
 *
 * The cursor always advances by the measured length, which is the anchoring rule stated as
 * arithmetic: `startMs + measuredMs` is the anchor's own onset wherever there is an anchor.
 *
 * The callers used to disagree about which of the two bounds a segment *as a window*, and the
 * disagreement was left standing here on the grounds that resolving it changes which segment a
 * pedal is measured in. Issue #27 is what that cost: windows built from `modelledMs` while the
 * cursor advanced by `measuredMs` are neither contiguous nor exhaustive, so a note or a pedal
 * falling in a gap between two of them was assigned no tick position at all, and one falling in
 * an overlap could take its onset from one segment and its duration from the next. The windows
 * are a partition now, and {@link segmentAtMs} is where that is stated — see its note.
 */
import { MPM, Scope } from "../../mpm"
import { MSM, MsmNote } from "../../msm"
import { millisecondsAt, resolveSpan, TempoWithEndDate } from "./tempoCalculations"
import type { Tempo as ResolvedTempo } from 'espressivo'

export interface PlacedTempo {
    /** The instruction, carrying the date the next one starts (or the end of the score). */
    readonly tempo: TempoWithEndDate

    /**
     * The instruction as the renderer resolves it. Resolved once per segment because the
     * consumers evaluate it many times, and resolving parses `@bpm` out of text: a walk over a
     * score asks about the same span once per note, and `dateAtMilliseconds` several times per
     * ask.
     */
    readonly resolved: ResolvedTempo

    /**
     * The date the *next* instruction starts, or `undefined` for the last segment.
     *
     * Distinct from `tempo.endDate`, which for the last segment is the end of the score. A note
     * belongs to a segment when it is at or after `tempo.date` and, if there is a next
     * instruction, before it — the open-ended last segment takes everything remaining.
     */
    readonly nextDate: number | undefined

    /** Where the segment begins on the recorded millisecond timeline. */
    readonly startMs: number

    /** What the `<tempo>` says the segment lasts, in milliseconds. */
    readonly modelledMs: number

    /** The note whose recorded onset sits exactly on the segment's end, if there is one. */
    readonly anchor: MsmNote | undefined

    /**
     * What the *recording* says the segment lasts: the anchor's onset less {@link startMs}, or
     * {@link modelledMs} where no note lands on the boundary.
     *
     * `startMs + measuredMs` is therefore the next segment's `startMs`, always — which is why
     * this and not {@link modelledMs} is what bounds a segment as a window on the recording.
     * {@link segmentAtMs} is the only place that division is made.
     */
    readonly measuredMs: number
}

/**
 * The tempo segments of one scope, in order, with the millisecond cursor already anchored.
 *
 * Returns an empty array when the scope has no `<tempo>` at all, which is what an MPM with no
 * tempoMap yet looks like — every caller reads that as "no tick position is derivable".
 */
export const placeTempos = (msm: MSM, mpm: MPM, scope: Scope): PlacedTempo[] => {
    const tempos = mpm.getInstructions('tempo', scope)
    const notes = msm.notesInPart(scope)

    const segments: PlacedTempo[] = []
    let startMs = 0

    for (let i = 0; i < tempos.length; i++) {
        const nextDate = tempos[i + 1]?.date
        const endDate = nextDate ?? msm.end

        const tempo: TempoWithEndDate = { ...tempos[i], endDate }
        const resolved = resolveSpan(tempo)
        const modelledMs = millisecondsAt(endDate, resolved)

        // The anchoring rule, in one place. `notesInPart(scope)` and not `allNotes`: the tempo
        // being walked governs this scope, so the note that dates its boundary must be one it
        // governs.
        const anchor = notes.find(n => n.date === endDate)
        const measuredMs = anchor ? anchor["midi.onset"] * 1000 - startMs : modelledMs

        segments.push({ tempo, resolved, nextDate, startMs, modelledMs, anchor, measuredMs })

        startMs += measuredMs
    }

    return segments
}

/**
 * Whether `date` falls in the stretch of *score* this segment governs.
 *
 * The tick windows tile `[tempos[0].date, ∞)` exactly, so a note has one segment or none, and
 * none means the tempo map does not reach back as far as the note. That case is deliberately not
 * folded into the first segment the way {@link segmentAtMs} folds the millisecond one: before its
 * first `<tempo>` the renderer does not extrapolate backwards either — it falls back on MPM's
 * default of 100 quarter-bpm (`TempoMap.renderTempoToMap`) — so a tick position invented from the
 * first instruction's tempo would be one the performance will not agree with.
 */
export const coversDate = (segment: PlacedTempo, date: number): boolean =>
    date >= segment.tempo.date && (segment.nextDate === undefined || date < segment.nextDate)

/**
 * The segment governing a millisecond time on the *recording*'s timeline.
 *
 * The windows are `[startMs, startMs + measuredMs)`, and because the cursor advances by exactly
 * `measuredMs` that makes each one's end the next one's start: contiguous by construction rather
 * than by two expressions happening to agree. The first window opens at −∞ and the last closes at
 * +∞, so **every** finite time has exactly one segment and no caller has to decide what to do
 * with one that has none.
 *
 * Both open ends earn their place. A recording is aligned to the score, not generated from it, so
 * an onset can land before the first modelled moment; and a note or pedal released after the last
 * one is ordinary rather than exceptional — the final `<tempo>` runs to the end of the *score*,
 * and a performer's hand comes off the key after that. Issue #27 is what closing them cost: the
 * last note of the run had no `tickDuration`, `InsertRubato` saw it and abandoned the whole
 * frame, and `InsertArticulation` did not see it and wrote `NaN` into the document.
 *
 * Searching from the end rather than the start is what makes the fold-in work, and it also
 * decides the degenerate case: where a recording is so far out of order that the cursor goes
 * backwards, the later segment wins.
 */
export const segmentAtMs = (segments: PlacedTempo[], ms: number): PlacedTempo | undefined => {
    for (let i = segments.length - 1; i > 0; i--) {
        if (ms >= segments[i].startMs) return segments[i]
    }
    return segments[0]
}
