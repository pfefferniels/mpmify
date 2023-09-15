// @vitest-environment jsdom

import { expect, test } from 'vitest'
import { readFileSync } from "fs"
import { parseMSM } from '../src/msm'
import { MPM, Ornament } from '../src/mpm'
import { InterpolatePhysicalOrnamentation } from '../src/transformers/InterpolatePhysicalOrnamentation'

test('does not interpolate anything when no arpeggiation is given', () => {
    // Arrange
    const msm = parseMSM(
        readFileSync('test/fixtures/arpeggiation/neutral.msm', 'utf-8'))
    const mpm = new MPM()

    // Act
    const transformer = new InterpolatePhysicalOrnamentation()
    transformer.transform(msm, mpm)

    // Assert
    const ornamentInstruction = mpm.getInstructions<Ornament>('ornament', 'global')
    expect(ornamentInstruction.length).toEqual(0)
})

test('correctly interpolates real-world arpeggiations (WM 79)', () => {
    // Arrange
    const msm = parseMSM(
        readFileSync('test/fixtures/arpeggiation/arpeggiated.msm', 'utf-8'))
    const mpm = new MPM()

    // Act
    const transformer = new InterpolatePhysicalOrnamentation()
    transformer.transform(msm, mpm)

    // Assert
    // In all the three bars, every chord is arpeggiated, which should result
    // in 9 arpeggio instructions. Their lengthes are measured in Sonic Visualiser.
    // The last two, however, are being played so quickly, that they fall
    // under the default threshold.
    const arpeggios = mpm.getInstructions<Ornament>('ornament', 'global')
    expect(arpeggios).toHaveLength(7)
    expect(arpeggios.map(a => a.frameLength)).toEqual([130, 35, 99, 310, 136, 188, 172 /* 12, 3 */])
})

test('calculates the noteoff.shift attribute', () => {
    // Arrange
    const msm = parseMSM(
        readFileSync('test/fixtures/arpeggiation/noteoff.shift.msm', 'utf-8'))
    const mpm = new MPM()

    // Act
    const transformer = new InterpolatePhysicalOrnamentation()
    transformer.transform(msm, mpm)

    // Assert
    const ornamentInstructions = mpm.getInstructions<Ornament>('ornament', 'global')
    expect(ornamentInstructions.map(o => o["noteoff.shift"])).toEqual(['true', 'false', 'monophonic'])
})

