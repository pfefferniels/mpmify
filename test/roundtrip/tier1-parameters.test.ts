// @vitest-environment jsdom

import { describe, expect, test } from "vitest"
import { performMsmToData } from "espressivo"
import { createMpm, exportMPM, getDefinitions, getInstructions } from "../../src/mpm"
import { compareTransformers } from "../../src/transformers"
import { ApproximateLogarithmicTempo, TranslatePhysicalTimeToTicks } from "../../src/transformers/tempo"
import { InsertDynamicsInstructions } from "../../src/transformers/dynamics"
import { InsertArticulation } from "../../src/transformers/articulation/InsertArticulation"
import { buildScore, QUARTER } from "./score"
import { truthMpm } from "./truth"
import { roundTrip, notesOf } from "./harness"
import { tierTwoCases } from "./cases"

/**
 * Tier 1 — the diagnostic tier.
 *
 * These compare **MPM parameters** against the truth's, which the round trip deliberately does
 * not: MPM to performance is many-to-one, so a chain is entitled to explain a performance
 * differently than the truth did. That freedom is exactly what makes a failing round trip hard
 * to read — it says the chain is wrong without saying where.
 *
 * So each case here is built to be *identifiable*: one aspect, exactly representable, and the
 * segmentation handed in, such that there is only one sensible answer and the fitter either
 * writes it or does not. When a tier-2 or tier-3 case fails, these are what say which fitter.
 */

const caseNamed = (name: string) => tierTwoCases.find(spec => spec.name === name)!

describe('the tempo fitter recovers its own curve', () => {
    test('a constant tempo comes back as one instruction at that bpm', () => {
        const { fitted } = roundTrip(caseNamed('tempo: constant'))
        const tempos = getInstructions(fitted, 'tempo', 'global')

        expect(tempos).toHaveLength(1)
        expect(tempos[0].date).toBe(0)
        expect(tempos[0].bpm).toBeCloseTo(100, 4)
        expect(tempos[0].transitionTo).toBeUndefined()
    })

    test('a ritardando comes back with both boundary tempos', () => {
        const { fitted } = roundTrip(caseNamed('tempo: ritardando 120 to 60'))
        const tempos = getInstructions(fitted, 'tempo', 'global')
            .sort((a, b) => a.date - b.date)

        expect(tempos.length).toBeGreaterThanOrEqual(2)

        // Bounded rather than exact, and the bound is a known limit rather than slack: the
        // tempo at x=0 is not observable from beat-level IOI data — the first interval's mean
        // already sits above the instantaneous tempo at the segment start — so the fitter
        // recovers it to about a bpm, not to the digit.
        expect(Math.abs((tempos[0].bpm as number) - 120)).toBeLessThan(1)
        expect(Math.abs((tempos[0].transitionTo as number) - 60)).toBeLessThan(1)
        // Closing the span is what makes the transition render at all — see issue #24.
        expect(tempos[tempos.length - 1].date).toBeGreaterThan(0)
    })
})

describe('the dynamics fitter recovers its own curve', () => {
    test('a linear crescendo comes back with both boundary volumes', () => {
        const { fitted } = roundTrip(caseNamed('dynamics: linear crescendo 40 to 100'))
        const dynamics = getInstructions(fitted, 'dynamics', 'global')
            .sort((a, b) => a.date - b.date)

        expect(dynamics.length).toBeGreaterThanOrEqual(2)
        expect(dynamics[0].volume as number).toBeCloseTo(40, 0)
        expect(dynamics[0].transitionTo as number).toBeCloseTo(100, 0)
    })

    test('a constant dynamic comes back flat, with no transition at all', () => {
        const { fitted } = roundTrip(caseNamed('dynamics: constant'))
        const dynamics = getInstructions(fitted, 'dynamics', 'global')

        expect(dynamics[0].volume as number).toBeCloseTo(70, 4)
        expect(dynamics[0].transitionTo).toBeUndefined()
    })
})

describe('the articulation fitter recovers its own ratios', () => {
    test('a uniform legato comes back as one def at that relativeDuration', () => {
        const { fitted } = roundTrip(caseNamed('articulation: one legato for every note'))
        const defs = getDefinitions(fitted, 'articulationDef', 'global')

        expect(defs).toHaveLength(1)
        expect(defs[0].getRelativeDuration()).toBeCloseTo(1.3, 2)
    })

    /**
     * The identity behind issue #23, isolated.
     *
     * `relativeVelocity` is a factor on what the dynamics curve prescribes, so its divisor has
     * to be that prescribed value — the velocity a render of the rest of the MPM would sound —
     * and not the performed velocity. With one articulation unit per note there is no averaging
     * to blur the result, so the round trip is *exact*: the renderer computes `prescribed x
     * (recorded/prescribed)` and lands back on `recorded`.
     *
     * Under the old divisor this same case errs by up to 43 velocity units, so a regression here
     * is unmissable rather than a slightly worse mean.
     */
    test('per-note articulation units reproduce the performed velocity exactly (#23)', () => {
        const score = buildScore({ beats: 8 })
        const scoreXml = score.serialize()!
        const scoreNotes = score.allNotes.map(note => ({ id: note['xml:id'], date: note.date }))

        const truthXml = truthMpm({
            tempo: [{ date: 0, bpm: 120 }],
            dynamics: [{ date: 0, volume: 64 }],
            articulation: {
                defs: [
                    { name: 'loud', relativeVelocity: 1.4 },
                    { name: 'soft', relativeVelocity: 0.7 },
                ],
                pattern: ['loud', 'soft'],
            },
        }, scoreNotes)

        const truthPerformance = performMsmToData({ msm: scoreXml, mpm: truthXml })
        const performed = buildScore({ beats: 8 })
        const byId = new Map(notesOf(truthPerformance).map(note => [note.id, note]))
        for (const note of performed.allNotes) {
            const rendered = byId.get(note['xml:id'])!
            note['milliseconds.date'] = rendered.milliseconds.date
            note['milliseconds.date.end'] = rendered.milliseconds.end
            note.velocity = rendered.velocity
        }

        const mpm = createMpm()
        const chain = [
            new ApproximateLogarithmicTempo({
                scope: 'global', from: 0, to: 7 * QUARTER, beatLength: 0.25, silentOnsets: [],
            }),
            new TranslatePhysicalTimeToTicks({ translatePhysicalModifiers: true }),
            new InsertDynamicsInstructions({
                scope: 'global', from: 0, to: 7 * QUARTER, phantomVelocities: new Map(),
            }),
            ...performed.allNotes.map(note => new InsertArticulation({
                scope: 'global',
                noteIDs: [note['xml:id']],
                aspects: new Set(['relativeVelocity' as const]),
                name: `unit_${note['xml:id']}`,
            })),
        ].sort(compareTransformers)
        for (const transformer of chain) transformer.run(performed, mpm)

        const refit = performMsmToData({ msm: scoreXml, mpm: exportMPM(mpm) })
        const truthVelocities = notesOf(truthPerformance).map(note => note.velocity)
        const refitVelocities = notesOf(refit).map(note => note.velocity)

        expect(truthVelocities).toEqual([89.6, 44.8, 89.6, 44.8, 89.6, 44.8, 89.6, 44.8])
        refitVelocities.forEach((velocity, index) => {
            expect(velocity).toBeCloseTo(truthVelocities[index], 6)
        })
    })
})
