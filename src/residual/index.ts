/**
 * What the MPM as it stands does not yet explain.
 *
 * mpmify is a reduction: each transformer accounts for one slice of the deviation between the
 * score and the recording, and the next one works on what is left. That remainder used to be
 * *carried* — written back onto the MSM notes as `tickDate`, `tickDuration` and
 * `absoluteVelocityChange`, each step subtracting its own share for the next. This module
 * computes it instead, from the score, the recording and the MPM, on demand.
 *
 * The difference is not tidiness. An accumulated remainder cannot be undone (undoing step 4
 * leaves steps 5 to 8's subtractions behind) and cannot be refitted (revise the tempo and every
 * later fit was made against a remainder that no longer exists, silently). A computed one is
 * free of both.
 *
 * ## `without`
 *
 * A transformer asks for the residual with its own dimension held out:
 *
 * ```ts
 * const residual = deriveResidual(msm, mpm, { without: ['articulation'] })
 * ```
 *
 * — "what does everything *else* explain?" That is the same quantity the subtraction produced,
 * arrived at by construction rather than by bookkeeping.
 *
 * ## Two domains, two sources, deliberately
 *
 * The tick figures come from replaying the tempo walk in `tickTimes.ts`; the velocity comes from
 * rendering the MPM through espressivo. That split is not an accident of implementation:
 *
 * - **Ticks cannot come from a render.** The walk re-anchors on the recorded onset at every
 *   tempo boundary, so it is a function of the MPM *and* the recording. A rendered performance
 *   has no recording to anchor to, and inverting one gives a different table — the failure mode
 *   being that every rubato silently moves. See the note at the top of `tickTimes.ts`.
 * - **Velocity should not come from anywhere else.** It is the dynamics curve times the
 *   accentuation pattern times articulation's `relativeVelocity`. espressivo composes all three
 *   and is held byte-equivalent to meico on it; reassembling that here would be new and
 *   unproven code that has to stay in step with a renderer it does not own.
 */
import { InstructionType, MPM } from "../mpm"
import { MSM, MsmNote, MsmPedal } from "../msm"
import { addTickDurations, addTickOnsets } from "../transformers/tempo/tickTimes"
import { performMsmToData } from "espressivo"

export interface NoteResidual {
    readonly note: MsmNote

    /**
     * Where the recorded onset falls on the score grid, in ticks. `undefined` when no `<tempo>`
     * covers the note, which is what the MPM having no tempoMap yet looks like.
     */
    readonly tickDate: number | undefined

    /** The recorded duration on the score grid, in ticks. */
    readonly tickDuration: number | undefined

    /**
     * Recorded velocity minus rendered, in MIDI units. The quantity the accumulator spelled
     * `absoluteVelocityChange`.
     */
    readonly velocity: number | undefined
}

export interface PedalResidual {
    readonly pedal: MsmPedal
    readonly tickDate: number | undefined
    readonly tickDuration: number | undefined
}

export interface Residual {
    of(note: MsmNote): NoteResidual | undefined
    ofPedal(pedal: MsmPedal): PedalResidual | undefined
    readonly notes: readonly NoteResidual[]
    readonly pedals: readonly PedalResidual[]
}

export interface DeriveResidualOptions {
    /**
     * Instruction types to take out of the MPM before measuring — normally the one dimension
     * the caller is about to fit, so that what comes back is what it has to account for.
     */
    readonly without?: readonly InstructionType[]
}

/**
 * espressivo needs a seed for any imprecision distribution that carries none of its own. A fixed
 * one keeps the residual from moving between two calls that were asked the same question.
 */
const RESIDUAL_SEED = 0x6D706D

export const deriveResidual = (
    msm: MSM,
    mpm: MPM,
    options: DeriveResidualOptions = {}
): Residual => {
    const probe = options.without?.length ? mpm.without(options.without) : mpm

    const ticks = tickTimesOf(msm, probe)
    const rendered = renderedVelocities(msm, probe)

    const notes: NoteResidual[] = msm.allNotes.map(note => {
        const scratch = ticks.notes.get(note['xml:id'])
        const renderedVelocity = rendered?.get(note['xml:id'])
        return {
            note,
            tickDate: scratch?.tickDate,
            tickDuration: scratch?.tickDuration,
            velocity: renderedVelocity === undefined
                ? undefined
                : note['midi.velocity'] - renderedVelocity,
        }
    })

    const pedals: PedalResidual[] = msm.pedals.map(pedal => {
        const scratch = ticks.pedals.get(pedal['xml:id'])
        return { pedal, tickDate: scratch?.tickDate, tickDuration: scratch?.tickDuration }
    })

    const byNote = new Map(notes.map(entry => [entry.note['xml:id'], entry]))
    const byPedal = new Map(pedals.map(entry => [entry.pedal['xml:id'], entry]))

    return {
        of: note => byNote.get(note['xml:id']),
        ofPedal: pedal => byPedal.get(pedal['xml:id']),
        notes,
        pedals,
    }
}

interface TickTimes {
    tickDate: number | undefined
    tickDuration: number | undefined
}

/**
 * The tick figures, computed on a scratch copy of the score.
 *
 * `addTickOnsets` and `addTickDurations` write onto the notes they are given, which is what
 * `TranslatePhysicalTimeToTicks` wants and what this must not do. Running them against a deep
 * clone gets the numbers without touching the score being fitted — and, because it is the same
 * code the transformer runs, gets them identically rather than approximately.
 */
const tickTimesOf = (msm: MSM, mpm: MPM) => {
    const scratch = msm.deepClone()
    addTickOnsets(scratch, mpm)
    addTickDurations(scratch, mpm)

    return {
        notes: new Map<string, TickTimes>(
            scratch.allNotes.map(n => [n['xml:id'], { tickDate: n.tickDate, tickDuration: n.tickDuration }])
        ),
        pedals: new Map<string, TickTimes>(
            scratch.pedals.map(p => [p['xml:id'], { tickDate: p.tickDate, tickDuration: p.tickDuration }])
        ),
    }
}

/** What the probed MPM renders each note at, by `xml:id`. */
const renderedVelocities = (msm: MSM, mpm: MPM): Map<string, number> | undefined => {
    const score = msm.serializeScore()
    if (!score) return undefined

    const data = performMsmToData(
        { msm: score, mpm: mpm.toXML() },
        // No ornament expansion: a v3 ornament generates notes the score never had, and a
        // generated note has no recorded counterpart to be a residual against. Held out, every
        // performed note answers to an `xml:id` the score also knows.
        { expandOrnaments: false, seed: RESIDUAL_SEED }
    )

    const velocities = new Map<string, number>()
    for (const part of data.parts) {
        for (const note of part.notes) {
            if (note.id !== null) velocities.set(note.id, note.velocity)
        }
    }
    return velocities
}
