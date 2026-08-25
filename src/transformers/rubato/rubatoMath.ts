/**
 * The rubato warp, and how to take it back off a recorded position.
 *
 * `<rubato>` moves notes within a frame without moving the frame, so it is a warp of the tick
 * grid — the domain `tickDate` and `tickDuration` live in. Once the MPM says a rubato is there,
 * the part of a note's deviation that rubato accounts for is no longer anyone else's to explain,
 * and `removeRubatoDistortion` is what takes it off.
 *
 * It lives apart from `InsertRubato` because two callers need it: the transformer, which applies
 * it to the rubatos it has just written, and `deriveResidual`, which applies it to every rubato
 * the MPM already carries. `explains` is what tells those two apart.
 *
 * The frame lookups address the score grid, so the positions handed to them are symbolic. That
 * was issue #40: the offset used to be `note.date + note.tickDuration`, a symbolic position plus
 * a performed one.
 */
import { MPM, Rubato, Scope } from "../../mpm"
import { MSM } from "../../msm"

/**
 * This function calculates the effect of the rubato
 * on the MSM notes
 */
export const calculateRubatoOnDate = (date: number, rubato: Rubato) => {
    // compute the position of the map element within the rubato frame
    const localDate = (date - rubato.date) % rubato.frameLength;
    const lateStart = Math.max(Math.min(rubato.lateStart || 0, 0.9), 0)
    const earlyEnd = Math.max(Math.min(rubato.earlyEnd || 1, 1), 0.1)
    const d = (Math.pow(localDate / rubato.frameLength, rubato.intensity) * (earlyEnd - lateStart) + lateStart) * rubato.frameLength;
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
 * Takes the rubato warp back off the tick date and duration of every note it covers.
 *
 * @todo remove the distortion from pedals as well.
 * @param explains which rubatos count as already accounted for. `InsertRubato` passes an
 * identity test against the frames it has just written, so a frame some earlier run wrote is
 * left alone; `deriveResidual` passes `() => true`, because every rubato the document carries
 * is by then explained.
 */
export const removeRubatoDistortion = (
    msm: MSM,
    mpm: MPM,
    scope: Scope,
    explains: (rubato: Rubato) => boolean
) => {
    const affectedNotes =
        scope === 'global' ?
            msm.allNotes :
            msm.allNotes.filter(n => n.part - 1 === scope)

    for (const note of affectedNotes) {
        if (!note.tickDuration) continue

        const onsetRubato = mpm.instructionsEffectiveAtDate<Rubato>(note.date, 'rubato', scope)[0];
        if (!onsetRubato || !explains(onsetRubato)) continue

        const onsetInTicks = onsetRubato
            ? calculateRubatoOnDate(note.date, onsetRubato)
            : note.date

        const onsetDiff = onsetInTicks - note.date
        if (note.tickDate) {
            note.tickDate -= onsetDiff
        }
        note.tickDuration -= onsetDiff

        // Where the note ends, on the score grid. Both terms are symbolic, which is the domain
        // the rubato frames below are addressed in. This used to read
        // `note.date + note.tickDuration` — a symbolic position plus a performed one, so the
        // position handed to the frame lookup was neither. See issue #40.
        const offset = note.date + note.duration

        const rubatos = mpm.instructionsEffectiveAtDate<Rubato>(offset, 'rubato', scope)
        const effectiveRubato = rubatos[0]
        if (!effectiveRubato || !explains(effectiveRubato)) continue

        const rubatoStart = offset - ((offset - effectiveRubato.date) % effectiveRubato.frameLength)
        const remainder = offset - rubatoStart
        note['tickDuration'] -= remainder

        const remainderWithoutRubato = removeRubatoFromDate(effectiveRubato.date + remainder, effectiveRubato)!
        note['tickDuration'] += remainderWithoutRubato
    }
}
