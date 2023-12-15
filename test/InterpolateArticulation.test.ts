// @vitest-environment jsdom

import { expect, test } from "vitest"
import { parseMSM } from "../src/msm"
import { readFileSync } from "fs"
import { Articulation, MPM } from "mpm-ts"
import { SimplifyTempo } from "../src/transformers/tempo/SimplifyTempo"
import { InterpolateRubato } from "../src/transformers/InterpolateRubato"
import { InterpolateArticulation } from "../src/transformers/InterpolateArticulation"

test('correctly interpolates articulation with a rubato map present', () => {
    // Arrange
    const msm = parseMSM(readFileSync('test/fixtures/articulation/with-rubato.msm', 'utf-8'))
    const mpm = new MPM()

    const tempo = new SimplifyTempo({ beatLength: 'halfbar', epsilon: 8, precision: 2, translatePhysicalModifiers: false })
    const rubato = new InterpolateRubato({ beatLength: 'halfbar', part: 0, tolerance: 0 })
    const articulation = new InterpolateArticulation({ part: 0, relativeDurationPrecision: 2, relativeDurationTolerance: 0 })
    tempo.setNext(rubato)
    rubato.setNext(articulation)

    // Act
    tempo.transform(msm, mpm)

    // Assert
    const articulations = mpm.getInstructions<Articulation>('articulation', 0)

    expect(articulations.map(articulation => articulation.relativeDuration)).toEqual([1.5, 0.5, 1.5])
})

test('correctly interpolates articulation after a complex-world rubato', () => {
    // Arrange
    const msm = parseMSM(readFileSync('test/fixtures/articulation/with-complex-rubato.msm', 'utf-8'))
    const mpm = new MPM()

    const tempo = new CurvedTempoTransformer({ beatLength: 'denominator', epsilon: 0, precision: 2, translatePhysicalModifiers: false })
    const rubato = new InterpolateRubato({ part: 'global', beatLength: 'everything', tolerance: 0 })
    const articulationRight = new InterpolateArticulation({ part: 0, relativeDurationPrecision: 2, relativeDurationTolerance: 0 })
    const articulationLeft = new InterpolateArticulation({ part: 1, relativeDurationPrecision: 2, relativeDurationTolerance: 0 })
    tempo.setNext(rubato)
    rubato.setNext(articulationRight)
    articulationRight.setNext(articulationLeft)

    // Act
    tempo.transform(msm, mpm)

    // Assert
    const rightHandArticulations = mpm.getInstructions<Articulation>('articulation', 0)
    const leftHandArticulations = mpm.getInstructions<Articulation>('articulation', 1)

    console.log(mpm.serialize())
})
