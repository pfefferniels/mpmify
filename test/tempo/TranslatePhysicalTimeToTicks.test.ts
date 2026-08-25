// @vitest-environment jsdom

import { expect, test } from "vitest"
import { FrameDomain } from "espressivo"
import { MSM } from "../../src/msm"
import { InstructionOptions, MPM, OrnamentDraft, ornamentDraftOf, setOrnamentDraft } from "../../src/mpm"
import { TranslatePhysicalTimeToTicks } from "../../src/transformers/tempo/TranslatePhysicalTimeToTicks"
import { deriveResidual } from "../../src/residual"

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

/**
 * Call the protected `transform` method for testing, the way the other transformer tests do.
 * Calling it directly type-checks only as long as nobody type-checks the tests.
 */
const callTransform = (transformer: TranslatePhysicalTimeToTicks, msm: MSM, mpm: MPM) => {
    type Transformable = { transform(msm: MSM, mpm: MPM): void }
    ;(transformer as unknown as Transformable).transform(msm, mpm)
}

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


// The claim this file used to make here — that a 60bpm tempo puts these recorded onsets at
// these ticks — is now `deriveResidual`'s to answer, and it is asserted where the conversion
// lives. This transformer no longer touches the score at all.
test('at 60bpm a recorded onset lands on the tick the beat length implies', () => {
    const mpm = new MPM()
    mpm.insertInstructions('tempo', [{
        id: 'tempo_el',
        bpm: 60,
        beatLength: 0.25,
        date: 0
    }], 'global')

    const residual = deriveResidual(msmFixture, mpm)

    expect(residual.notes.map(n => n.tickDate)).toEqual([0, 1440, 2160])
})

test('it translates existing physical modifiers into tick modifiers', () => {
    // Arrange: a piece under a single constant tempo, so the tick/ms ratio is known exactly.
    // At 60 bpm with beatLength 0.25 a quarter note (720 ticks) lasts 1000 ms, i.e. 0.72
    // ticks per millisecond.
    const msm = new MSM([
        { ...generateNote(0, 0.25), 'midi.onset': 0, 'midi.duration': 1, 'midi.velocity': 100 },
        { ...generateNote(0.25, 0.25), 'midi.onset': 1, 'midi.duration': 1, 'midi.velocity': 100 },
        { ...generateNote(0.5, 0.25), 'midi.onset': 2, 'midi.duration': 1, 'midi.velocity': 100 },
    ], { numerator: 4, denominator: 4 })

    const mpm = new MPM()
    mpm.insertInstructions('tempo', [{
        date: 0,
        id: 'tempo_1',
        beatLength: 0.25,
        bpm: 60,
    }], 'global')

    // The frame is not an `<ornament>` attribute — it describes the `<temporalSpread>` of the def
    // the `@name.ref` points at, and until `StylizeOrnamentation` builds that def it is parked on
    // the element as a draft. So the fixture is written in two halves, the instruction and the
    // draft, which is exactly how `InsertTemporalSpread` writes one.
    const physicalArpeggios: [InstructionOptions<'ornament'>, OrnamentDraft][] = [
        [
            { date: 720, id: 'ornament_720', noteOrder: 'ascending pitch', nameRef: 'arpeggio' },
            { frameStart: -50, frameLength: 100, frameDomain: FrameDomain.Milliseconds },
        ],
        [
            { date: 1440, id: 'ornament_1440', noteOrder: 'ascending pitch', nameRef: 'arpeggio' },
            { frameStart: -25, frameLength: 50, frameDomain: FrameDomain.Milliseconds },
        ]
    ]
    for (const [options, draft] of physicalArpeggios) {
        setOrnamentDraft(mpm.insertInstruction('ornament', options, 'global').element, draft)
    }

    // Act
    const translate = new TranslatePhysicalTimeToTicks({
        translatePhysicalModifiers: true
    })
    callTransform(translate, msm, mpm)

    // Assert
    const drafts = mpm.getInstructions('ornament', 'global')
        .map(arpeggio => ornamentDraftOf(arpeggio.element))
    expect(drafts.every(draft => draft.frameDomain === FrameDomain.Ticks)).toBeTruthy()
    expect(drafts.map(d => d.frameStart)).toEqual([-36, -18])
    expect(drafts.map(d => d.frameLength)).toEqual([72, 36])
})
