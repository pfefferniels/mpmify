// @vitest-environment jsdom

import { describe, expect, test } from "vitest"
import { MSM } from "../../src/msm"
import { MPM, Ornament, OrnamentDef } from "../../src/mpm"
import { StylizeOrnamentation } from "../../src/transformers"

/**
 * `StylizeOrnamentation` moves the attributes an ornament was fitted with into an
 * `<ornamentDef>` and points the ornament at it. The failure mode this file pins is the one in
 * issue #28: the two halves coming apart, so that the map names a definition that was never
 * written and the ornament has been emptied of the attributes that would have described it.
 *
 * These drive the transformer directly with ornaments already in the MPM, because that is where
 * the fitters leave them and the shapes below are ones the ordinary chain no longer produces.
 */

const callTransform = (transformer: StylizeOrnamentation, msm: MSM, mpm: MPM) => {
    type Transformable = { transform(msm: MSM, mpm: MPM): void }
    ;(transformer as unknown as Transformable).transform(msm, mpm)
}

const run = (mpm: MPM) => callTransform(
    new StylizeOrnamentation({ tickTolerance: 10, gradientTolerance: 0.1, intensityTolerance: 0.3 }),
    new MSM([], { numerator: 4, denominator: 4 }),
    mpm)

const defNames = (mpm: MPM) =>
    mpm.getDefinitions<OrnamentDef>('ornamentDef', 'global').map(def => def.name)

const ornaments = (mpm: MPM) => mpm.getInstructions<Ornament>('ornament', 'global')

describe('an ornament and its definition do not come apart (#28)', () => {
    test('an unusable frame leaves the ornament untouched rather than half-processed', () => {
        const mpm = new MPM()
        mpm.insertInstruction({
            type: 'ornament',
            'xml:id': 'orn_broken',
            date: 0,
            'name.ref': 'neutralArpeggio',
            'frame.start': NaN,
            frameLength: NaN,
            'time.unit': 'ticks',
            'transition.from': -1,
            'transition.to': 0,
            scale: 25,
        } as Ornament, 'global')

        run(mpm)

        // No definition, so no reference to it — and the fit it arrived with is still there to
        // be read. Stripping those while writing no definition is what left the real corpus
        // with three unresolvable @name.ref in one run.
        expect(defNames(mpm)).toHaveLength(0)
        expect(ornaments(mpm)[0]['transition.from']).toBe(-1)
        expect(ornaments(mpm)[0]['transition.to']).toBe(0)
    })

    test('an ornament with a ramp and no roll still gets a definition', () => {
        const mpm = new MPM()
        for (const date of [0, 1440]) {
            mpm.insertInstruction({
                type: 'ornament',
                'xml:id': `orn_${date}`,
                date,
                'name.ref': 'neutralArpeggio',
                'transition.from': -1,
                'transition.to': 0,
                scale: 25,
            } as Ornament, 'global')
        }

        run(mpm)

        // `InsertDynamicsGradient` fits exactly this shape. Clustering keys on the frame, so
        // these used to fall out of it and keep pointing at `neutralArpeggio`, a name no
        // definition carries.
        const defs = mpm.getDefinitions<OrnamentDef>('ornamentDef', 'global')
        expect(defs).toHaveLength(1)
        expect(defs[0].dynamicsGradient).toBeDefined()
        expect(defs[0].dynamicsGradient!['transition.from']).toBeCloseTo(-1, 10)
        expect(defs[0].dynamicsGradient!['transition.to']).toBeCloseTo(0, 10)
        expect(defs[0].temporalSpread).toBeUndefined()

        for (const ornament of ornaments(mpm)) {
            expect(ornament['name.ref']).toBe(defs[0].name)
        }
    })

    test('every @name.ref a run writes resolves to a definition it wrote', () => {
        const mpm = new MPM()
        // A mixture: two rolls that cluster, one ramp-only, and one that cannot be used.
        for (const date of [0, 1440]) {
            mpm.insertInstruction({
                type: 'ornament', 'xml:id': `roll_${date}`, date,
                'frame.start': -360, frameLength: 720, 'time.unit': 'ticks',
                intensity: 1, 'noteoff.shift': false,
                'transition.from': -1, 'transition.to': 0, scale: 25,
            } as Ornament, 'global')
        }
        mpm.insertInstruction({
            type: 'ornament', 'xml:id': 'ramp_only', date: 2880,
            'name.ref': 'neutralArpeggio',
            'transition.from': 0, 'transition.to': -1, scale: 12,
        } as Ornament, 'global')
        mpm.insertInstruction({
            type: 'ornament', 'xml:id': 'unusable', date: 4320,
            'name.ref': 'neutralArpeggio',
            'frame.start': NaN, frameLength: NaN, 'time.unit': 'ticks',
        } as Ornament, 'global')

        run(mpm)

        const written = new Set(defNames(mpm))
        for (const ornament of ornaments(mpm)) {
            const reference = ornament['name.ref']
            if (reference === 'neutralArpeggio') {
                // Only the one that got no definition may still carry the fitter's placeholder.
                expect(ornament['xml:id']).toBe('unusable')
                continue
            }
            expect(written.has(reference!), `${ornament['xml:id']} names ${reference}`).toBe(true)
        }
    })

    test('a gradient is kept when transition.to is 0, which is a legal end (#46)', () => {
        const mpm = new MPM()
        mpm.insertInstruction({
            type: 'ornament', 'xml:id': 'crescendo', date: 0,
            'frame.start': -360, frameLength: 720, 'time.unit': 'ticks',
            intensity: 1, 'noteoff.shift': false,
            // The end of `InsertDynamicsGradient`'s own default crescendo.
            'transition.from': -1, 'transition.to': 0, scale: 25,
        } as Ornament, 'global')

        run(mpm)

        const defs = mpm.getDefinitions<OrnamentDef>('ornamentDef', 'global')
        expect(defs).toHaveLength(1)
        expect(defs[0].dynamicsGradient).toBeDefined()
        expect(defs[0].dynamicsGradient!['transition.to']).toBe(0)
    })
})
