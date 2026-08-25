// @vitest-environment jsdom

import { describe, test, expect } from "vitest"
import { MSM } from "../src/msm"
import { MPM } from "../src/mpm"
import { ApproximateLogarithmicTempo } from "../src/transformers/tempo/ApproximateLogarithmicTempo"
import { InsertDynamicsInstructions } from "../src/transformers/dynamics/InsertDynamicsInstructions"
import { Transformer } from "../src/transformers/Transformer"

/**
 * The pipeline re-folds the *entire* chain over a fresh MPM on every edit, so the fold has to be
 * a function: the same chain over the same MSM must produce the same document. Two transformers
 * fit their curves by simulated annealing, which used to draw from `Math.random` — touching any
 * desk then re-fitted every tempo and dynamics curve in the piece to slightly different numbers.
 *
 * These tests fold twice and compare the serialized result, which is exactly what the worker
 * hands back to the UI.
 */

const BEAT = 720

/** Notes whose onsets accelerate and whose velocities swell — enough to make both fitters work. */
const buildMsm = () => {
    const notes = Array.from({ length: 17 }, (_, i) => {
        const x = i / 16
        return {
            'xml:id': `n_1_${i}`,
            date: i * BEAT,
            part: 1,
            pitchname: 'g' as const,
            octave: 4,
            duration: BEAT,
            accidentals: 0,
            'midi.pitch': 67,
            // accelerando: beats get closer together
            'midi.onset': 0.75 * i - 0.18 * x * i,
            'midi.duration': 0.5,
            // a swell, so the dynamics fit is neither flat nor a straight line
            'midi.velocity': Math.round(50 + 45 * Math.sin(Math.PI * x)),
        }
    })
    return new MSM(notes, { numerator: 4, denominator: 4 })
}

/**
 * Ids are pinned because the real chain's are: they live in the saved work file and are what
 * `corresp` points at. A fresh `v4()` per run would differ for reasons that have nothing to do
 * with the fitting this test is about.
 */
const chain = (): Transformer[] => {
    const tempo = new ApproximateLogarithmicTempo({
        scope: 'global', from: 0, to: 16 * BEAT, beatLength: 0.25, silentOnsets: [],
    })
    tempo.id = 'call-tempo'
    const dynamics = new InsertDynamicsInstructions({
        scope: 'global', from: 0, to: 16 * BEAT, phantomVelocities: new Map(),
    })
    dynamics.id = 'call-dynamics'
    return [tempo, dynamics]
}

/** What the worker does: fresh MPM, cloned MSM, run every transformer, serialize. */
const fold = (transformers: Transformer[]) => {
    const msm = buildMsm().deepClone()
    const mpm = new MPM()
    for (const transformer of transformers) transformer.run(msm, mpm)
    return mpm.toXML()
}

describe('the pipeline fold is a function of its inputs', () => {
    test('folding the same chain twice yields the same MPM', () => {
        expect(fold(chain())).toBe(fold(chain()))
    })

    test('the fitted tempo does not drift across runs', () => {
        const bpms = () => {
            const msm = buildMsm().deepClone()
            const mpm = new MPM()
            chain()[0].run(msm, mpm)
            return mpm.getInstructions('tempo', 'global')
                .map(t => [t.bpm, t.transitionTo, t.meanTempoAt])
        }
        const first = bpms()
        expect(first.length).toBeGreaterThan(0)
        expect(bpms()).toEqual(first)
        expect(bpms()).toEqual(first)
    })

    test('the fitted dynamics curve does not drift across runs', () => {
        const curves = () => {
            const msm = buildMsm().deepClone()
            const mpm = new MPM()
            chain()[1].run(msm, mpm)
            return mpm.getInstructions('dynamics', 'global')
                .map(d => [d.volume, d.transitionTo, d.curvature, d.protraction])
        }
        const first = curves()
        expect(first.length).toBeGreaterThan(0)
        expect(curves()).toEqual(first)
        expect(curves()).toEqual(first)
    })
})
