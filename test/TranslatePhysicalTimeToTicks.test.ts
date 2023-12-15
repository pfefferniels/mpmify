// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM } from "../src/msm"
import { MPM, Tempo } from 'mpm-ts'
import { TranslatePhyiscalTimeToTicks } from "../src/transformers/TranslatePhysicalTimeToTicks"

/**
 * Quickly generates a simple MSM note
 * @note Example for duration and position: 0.25 = quarter note etc.
 */
const generateNote = (position: number, duration: number, part: number = 1) => ({
    'xml:id': `n_${part}_${position}`,
    date: position * 4 * 720,
    part: part,
    pitchname: 'g',
    octave: 4,
    duration: duration * 4 * 720,
    accidentals: 0,
    'midi.pitch': 67
})

const msmFixture = new MSM(
    [
        {
            ...generateNote(0, 0.5),    // half note ...
            'midi.onset': 0,            
            'midi.duration': 2,         // lasting 2 seconds (i.e. 60bpm)
            'midi.velocity': 100
        },
        {
            ...generateNote(0.5, 0.25), // quarter note ...
            'midi.onset': 2,           
            'midi.duration': 1,         // lasting 1 seconds (i.e. 60bpm too)
            'midi.velocity': 100
        },
        {
            ...generateNote(0.75, 0.25),
            'midi.onset': 3,
            'midi.duration': 1,
            'midi.velocity': 100
        }
    ],
    { numerator: 4, denominator: 4 }
)


test('It inserts the right tempo instructions using beat length = denominator', () => {
    // Arrange
    const msm = { ...msmFixture }

    const mpm = new MPM()
    const tempo = {
        'xml:id': 'tempo_el',
        type: 'tempo',
        bpm: 60,
        beatLength: 0.25,
        date: 0
    } as Tempo
    mpm.insertInstructions([tempo], 'global')

    // Act
    const translate = new TranslatePhyiscalTimeToTicks({
        translatePhysicalModifiers: false
    })
    translate.transform(msmFixture, mpm)

    // Assert
    expect(msm.allNotes.map(note => note.tickDate)).toEqual([0, 1440, 2160])
})

