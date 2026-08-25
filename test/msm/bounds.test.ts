import { describe, expect, test } from "vitest"
import { MSM, MsmNote, MsmPedal } from "../../src/msm"

/**
 * The three places an `MSM` reports a bound — `lastDate`, `end` and the minimum
 * `shiftToFirstOnset` shifts by — used to be `Math.max`/`Math.min` over a spread.
 *
 * Spreading has two costs. Past roughly 100k arguments it is a `RangeError` rather than a
 * slowdown, which the 450-note corpus does not reach; and `Math.min()` of *nothing* is
 * `Infinity`, which `shiftToFirstOnset` did reach — the note shift was guarded against it, the
 * pedal shift above it was not. These pin the degenerate ends of all three.
 *
 * See issue #49.
 */

const note = (id: string, date: number, duration = 720, onset?: number): MsmNote => ({
    'xml:id': id,
    part: 1,
    date,
    duration,
    pitchname: 'c',
    accidentals: 0,
    octave: 4,
    'midi.onset': onset as number,
    'midi.duration': 1,
    'midi.pitch': 60,
    'midi.velocity': 100,
})

const pedal = (id: string, onset: number, duration = 1): MsmPedal => ({
    'xml:id': id,
    type: 'sustain',
    'midi.onset': onset,
    'midi.duration': duration,
})

describe('the bounds of a score', () => {
    test('an empty score ends where it begins', () => {
        const msm = new MSM()
        expect(msm.lastDate()).toBe(0)
        expect(msm.end).toBe(0)
        expect(msm.lastNote()).toBeUndefined()
    })

    test('lastDate is the latest date, end the latest date plus duration', () => {
        // The longest note does not start last, so `end` has to look past `lastDate`'s answer.
        const msm = new MSM([
            note('a', 0, 2880),
            note('b', 720, 360),
        ])
        expect(msm.lastDate()).toBe(720)
        expect(msm.end).toBe(2880)
    })

    test('lastNote is the first note on the last date', () => {
        const msm = new MSM([note('a', 0), note('b', 720), note('c', 720)])
        expect(msm.lastNote()?.['xml:id']).toBe('b')
    })
})

describe('shifting a score to its first onset', () => {
    test('subtracts the earliest onset from notes and pedals alike', () => {
        const msm = new MSM([note('a', 0, 720, 2), note('b', 720, 720, 3)])
        msm.pedals = [pedal('p', 2.5)]

        msm.shiftToFirstOnset()

        expect(msm.allNotes.map(n => n['midi.onset'])).toEqual([0, 1])
        expect(msm.pedals[0]['midi.onset']).toBe(0.5)
    })

    test('a pedal pressed before the first note keeps its release', () => {
        const msm = new MSM([note('a', 0, 720, 2)])
        msm.pedals = [pedal('p', 1.5, 2)]

        msm.shiftToFirstOnset()

        // Half the press is cut away with the silence, so the release stays where it was.
        expect(msm.pedals[0]['midi.onset']).toBe(0)
        expect(msm.pedals[0]['midi.duration']).toBe(1.5)
    })

    test('a score with no recorded onset is left alone', () => {
        // `Math.min()` of nothing is `Infinity`, and the pedal loop subtracted it unguarded.
        const msm = new MSM([note('a', 0), note('b', 720)])
        msm.pedals = [pedal('p', 4)]

        msm.shiftToFirstOnset()

        expect(msm.pedals[0]['midi.onset']).toBe(4)
        expect(msm.pedals[0]['midi.duration']).toBe(1)
    })
})
