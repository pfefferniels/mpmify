// @vitest-environment jsdom

import { expect, test } from "vitest"
import { MSM } from "../../src/msm"
import { MPM, Ornament, Tempo } from 'mpm-ts'
import { TranslatePhyiscalTimeToTicks } from "../../src/transformers/tempo/TranslatePhysicalTimeToTicks"

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

test('it translates existing physical modifiers into tick modifiers', () => {
    // Arrange
    const mpm = new MPM()
    const tempos: Tempo[] = [
        {
            type: 'tempo',
            date: 0,
            'xml:id': 'tempo_1',
            beatLength: 0.25,
            bpm: 60,
            meanTempoAt: 0.3,
            "transition.to": 120
        },
        {
            type: 'tempo', 
            date: 2880,
            'xml:id': 'tempo_2',
            beatLength: 0.25,
            bpm: 120
        }
    ]
    mpm.insertInstructions(tempos, 'global')

    const physicalArpeggios: Ornament[] = [
        {
            type: 'ornament',
            date: 720,
            'xml:id': 'ornament_2',
            "frame.start": -28.492,
            frameLength: 56.984,
            'time.unit': 'milliseconds',
            'note.order': 'ascending pitch',
            'scale': 1,
            'name.ref': 'arpeggio'
        },
        {
            type: 'ornament',
            date: 1440,
            'xml:id': 'ornament_3',
            "frame.start": -25,
            frameLength: 50,
            'time.unit': 'milliseconds',
            'note.order': 'ascending pitch',
            'scale': 1,
            'name.ref': 'arpeggio'
        },
        {
            type: 'ornament',
            date: 2160,
            'xml:id': 'ornament_4',
            "frame.start": -22.505,
            frameLength: 45.011,
            'time.unit': 'milliseconds',
            'note.order': 'ascending pitch',
            'scale': 1,
            'name.ref': 'arpeggio'
        },
        {
            type: 'ornament',
            date: 2880,
            'xml:id': 'ornament_5',
            "frame.start": -20.498,
            frameLength: 40.997,
            'time.unit': 'milliseconds',
            'note.order': 'ascending pitch',
            'scale': 1,
            'name.ref': 'arpeggio'
        }
    ]
    mpm.insertInstructions(physicalArpeggios, 'global')

    // Act
    const translate = new TranslatePhyiscalTimeToTicks({
        translatePhysicalModifiers: true
    })

    translate.transform(new MSM([], { numerator: 4, denominator: 4 }), mpm)

    // Assert
    const transformedArpeggios = mpm.getInstructions<Ornament>('ornament', 'global')
    expect(transformedArpeggios.every(arpeggio => arpeggio["time.unit"] === 'ticks')).toBeTruthy()
    expect(transformedArpeggios.every(arpeggio => arpeggio["frame.start"] === -31)).toBeTruthy()
    // TODO: frame.start should be -31, frameLength should be 60
})
