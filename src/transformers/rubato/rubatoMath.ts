/**
 * The rubato warp, and how to take it back off a recorded position.
 *
 * `<rubato>` moves notes within a frame without moving the frame, so it is a warp of the tick
 * grid — the domain `tickDate` and `tickDuration` live in. Once the MPM says a rubato is there,
 * the part of a note's deviation that rubato accounts for is no longer anyone else's to explain,
 * and `removeRubatoDistortion` is what takes it off.
 *
 * It lives apart from `InsertRubato` because the transformer no longer performs it: the score is
 * left as it was found, and the warp comes off the derived positions instead.
 *
 * The frame lookups address the score grid, so the positions handed to them are symbolic. That
 * was issue #40: the offset used to be `note.date + note.tickDuration`, a symbolic position plus
 * a performed one.
 */
import { resolveRubato, type Rubato as ResolvedRubato } from "espressivo"
import { MPM, Rubato, Scope } from "../../mpm"
import { MSM } from "../../msm"
import { TickTimes } from "../tempo/tickTimes"

/**
 * One `<rubato>` record with its parameters defaulted and clamped the way the renderer does it.
 *
 * The defaulting and the clamping used to be written out here, and they had drifted from meico
 * in two ways that a perfectly ordinary document reaches:
 *
 * - `lateStart` was capped at **0.9** and `earlyEnd` floored at **0.1**. Neither bound exists in
 *   meico, which only floors `lateStart` at 0 and caps `earlyEnd` at 1 — so a `lateStart="0.95"`
 *   was fitted against 0.9 while rendering at 0.95.
 * - an inverted or empty window (`lateStart >= earlyEnd`) was left inverted, producing a
 *   *reversed* warp, where meico widens it to the whole frame and produces the identity.
 *
 * Measured on a 720-tick frame read at its midpoint, four of seven test windows disagreed, by up
 * to 72 ticks. `resolveRubato` is the renderer's own resolution and settles all of it, in
 * RubatoMap.java's order, including the `@intensity` default of 1.0.
 *
 * `null` where there is no frame to warp — an absent `@frameLength`, which is the one parameter
 * with no default. That used to divide by `undefined` and hand back `NaN`.
 *
 * The `def` argument is `null` because mpmify models no `<rubatoDef>`: it writes every parameter
 * onto the instruction. This is the seam where def inheritance would arrive, and passing the
 * argument explicitly is what keeps that a one-line change rather than a rewrite.
 */
const resolve = (rubato: Rubato): ResolvedRubato | null => resolveRubato(
    { startDate: rubato.date, endDate: rubato.date + rubato.frameLength },
    {
        frameLength: rubato.frameLength,
        intensity: rubato.intensity,
        lateStart: rubato.lateStart,
        earlyEnd: rubato.earlyEnd,
        loop: rubato.loop,
    },
    null,
)

/**
 * Where a symbolic date lands once the rubato has warped its frame.
 *
 * The three lines of arithmetic are meico's `RubatoMap.computeRubatoTransformation`, which
 * espressivo keeps private — it is the one `…At()` evaluator the package does not export, where
 * tempo, dynamics and movement all do. Everything that decides *what numbers go into* it comes
 * from {@link resolve}, so what is duplicated here is a formula with no defaults and no
 * branches, rather than the policy that had actually drifted. If espressivo ever exports a
 * `rubatoAt`, this becomes a one-line delegation.
 *
 * An unresolvable rubato leaves the date where it was, which is what an identity warp means.
 */
export const calculateRubatoOnDate = (date: number, rubato: Rubato) => {
    const rd = resolve(rubato)
    if (rd === null) return date

    // compute the position of the map element within the rubato frame
    const localDate = (date - rd.startDate) % rd.frameLength;
    const d = (Math.pow(localDate / rd.frameLength, rd.intensity) * (rd.earlyEnd - rd.lateStart) + rd.lateStart) * rd.frameLength;
    return date + d - localDate
}

/**
 * This function does the opposite of `calculateRubatoDate`:
 * It removes the "rubato effect" from a given date.
 * TODO: find a numerical, non-iterative solution.
 */
const removeRubatoFromDate = (newDate: number, rubato: Rubato) => {
    const target = rubato.date + ((newDate - rubato.date) % rubato.frameLength);
    let lowerBound = rubato.date;
    let upperBound = rubato.date + rubato.frameLength;

    while (upperBound - lowerBound > 1e-6) {
        const middle = (upperBound + lowerBound) / 2;
        const middleNewDate = calculateRubatoOnDate(middle, rubato);

        if (Math.abs(target - middleNewDate) < 1) {
            return middle - rubato.date;
        } else if (middleNewDate < target) {
            lowerBound = middle;
        } else {
            upperBound = middle;
        }
    }

    return lowerBound - rubato.date;
};

/**
 * Takes the rubato warp back off the derived tick date and duration of every note it covers.
 *
 * Every rubato the document holds is by definition already explained, so unlike the version
 * this replaces there is nothing to filter: the transformer that used to call it with only the
 * frames it had just written no longer compensates the score at all.
 *
 * @todo remove the distortion from pedals as well.
 */
export const removeRubatoDistortion = (
    msm: MSM,
    mpm: MPM,
    scope: Scope,
    times: TickTimes
) => {
    const affectedNotes =
        scope === 'global' ?
            msm.allNotes :
            msm.allNotes.filter(n => n.part - 1 === scope)

    for (const note of affectedNotes) {
        const time = times.notes.get(note['xml:id'])
        if (!time?.tickDuration) continue

        const onsetRubato = mpm.instructionsEffectiveAtDate(note.date, 'rubato', scope)[0];
        if (!onsetRubato) continue

        const onsetInTicks = onsetRubato
            ? calculateRubatoOnDate(note.date, onsetRubato)
            : note.date

        const onsetDiff = onsetInTicks - note.date
        if (time.tickDate) {
            time.tickDate -= onsetDiff
        }
        time.tickDuration -= onsetDiff

        // Where the note ends, on the score grid. Both terms are symbolic, which is the domain
        // the rubato frames below are addressed in. This used to read
        // `note.date + note.tickDuration` — a symbolic position plus a performed one, so the
        // position handed to the frame lookup was neither. See issue #40.
        const offset = note.date + note.duration

        const rubatos = mpm.instructionsEffectiveAtDate(offset, 'rubato', scope)
        const effectiveRubato = rubatos[0]
        if (!effectiveRubato) continue

        const rubatoStart = offset - ((offset - effectiveRubato.date) % effectiveRubato.frameLength)
        const remainder = offset - rubatoStart
        time.tickDuration -= remainder

        const remainderWithoutRubato = removeRubatoFromDate(effectiveRubato.date + remainder, effectiveRubato)
        time.tickDuration += remainderWithoutRubato
    }
}
