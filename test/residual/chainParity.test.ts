import { expect, test } from "vitest"
import { MSM, MsmNote } from "../../src/msm"
import { MPM, Tempo } from "../../src/mpm"
import { deriveResidual } from "../../src/residual"
import { TranslatePhysicalTimeToTicks } from "../../src/transformers/tempo/TranslatePhysicalTimeToTicks"
import { InsertRubato } from "../../src/transformers/rubato/InsertRubato"
import { removeRubatoDistortion } from "../../src/transformers/rubato/rubatoMath"
import { addTickDurations, addTickOnsets } from "../../src/transformers/tempo/tickTimes"

const QUARTER = 720

/** Eight quarter notes at a nominal 60bpm, played with a push and pull inside each bar. */
const OFFSETS = [0, -0.06, 0.09, 0.02, 0, -0.05, 0.08, 0.03]

const fixture = () => new MSM(
    OFFSETS.map((offset, beat) => ({
        'xml:id': `n${beat}`,
        date: beat * QUARTER,
        part: 1,
        pitchname: 'g',
        octave: 4,
        accidentals: 0,
        duration: QUARTER,
        'midi.pitch': 67,
        'midi.onset': beat + offset,
        'midi.duration': 1,
        'midi.velocity': 100,
    } as MsmNote)),
    { numerator: 4, denominator: 4 }
)

const withTempo = () => {
    const mpm = new MPM()
    mpm.insertInstruction<Tempo>({
        type: 'tempo', 'xml:id': 't1', date: 0, bpm: 60, beatLength: 0.25,
    }, 'global')
    return mpm
}

/**
 * `deriveResidual` wires the tick domain together in the right order.
 *
 * The two halves are the tempo walk and the rubato compensation, and both live in modules of
 * their own so the transformers and the residual share one implementation. What is left to get
 * wrong is the wiring: running them in the wrong order, or forgetting the rubato step, would
 * still typecheck and would still produce plausible numbers. This pins that.
 *
 * It used to compare against what the chain left on the notes. The chain leaves nothing now.
 */
test('deriveResidual applies the tempo walk and then the rubato compensation', () => {
    const expected = fixture()
    const mpm = withTempo()

    new TranslatePhysicalTimeToTicks({ translatePhysicalModifiers: false }).run(expected, mpm)
    new InsertRubato({ date: 0, length: 4 * QUARTER, scope: 'global' }).run(expected, mpm)
    expect(mpm.getInstructions('rubato')).toHaveLength(1)

    addTickOnsets(expected, mpm)
    addTickDurations(expected, mpm)
    removeRubatoDistortion(expected, mpm, 'global', () => true)

    const derived = deriveResidual(fixture(), mpm)

    expect(derived.notes.map(n => n.tickDate))
        .toEqual(expected.allNotes.map(n => n.tickDate))
    expect(derived.notes.map(n => n.tickDuration))
        .toEqual(expected.allNotes.map(n => n.tickDuration))
})

/**
 * Why the two paths can part, isolated.
 *
 * `removeRubatoDistortion`'s second correction walks from `note.date + note.tickDuration` and
 * asks which rubato is in force *there*. A note whose sounding offset reaches past its own frame
 * therefore depends on whether the next frame is in the document yet — and during the chain it is
 * not, because `InsertRubato` fits one frame per call and compensates as it goes. A residual
 * derived afterwards sees every frame at once and corrects what the chain skipped.
 */
test('the second duration correction depends on which frames are present', () => {
    const FRAME = 4 * QUARTER

    const held = () => {
        const msm = fixture()
        // as the tempo walk would have left them
        msm.allNotes.forEach((note, beat) => {
            note.tickDate = beat * QUARTER
            note.tickDuration = QUARTER * 2      // sounds into the following beat
        })
        return msm
    }

    const rubatoAt = (mpm: MPM, date: number) => mpm.insertInstruction({
        type: 'rubato', 'xml:id': `r${date}`, date, frameLength: FRAME, intensity: 0.65,
    }, 'global')

    const oneFrame = new MPM()
    rubatoAt(oneFrame, 0)

    const twoFrames = new MPM()
    rubatoAt(twoFrames, 0)
    rubatoAt(twoFrames, FRAME)

    const a = held(); removeRubatoDistortion(a, oneFrame, 'global', () => true)
    const b = held(); removeRubatoDistortion(b, twoFrames, 'global', () => true)

    // The note whose offset crosses out of frame 1 is corrected in one and not the other.
    const crossing = 3
    expect(a.allNotes[crossing].tickDuration).not.toEqual(b.allNotes[crossing].tickDuration)

    // ... while a note sitting wholly inside frame 1 is untouched by the difference.
    expect(a.allNotes[0].tickDuration).toEqual(b.allNotes[0].tickDuration)
})
