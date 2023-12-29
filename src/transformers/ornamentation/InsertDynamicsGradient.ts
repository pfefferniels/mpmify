import { DynamicsGradient, MPM, Ornament, Part } from "mpm-ts"
import { MSM } from "../../msm"
import { isDefined } from "../../utils/isDefined"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
import { v4 } from "uuid"

export type ArpeggioPlacement = 'on-beat' | 'before-beat' | 'estimate'

export interface InsertDynamicsGradientOptions extends TransformationOptions {
    /**
     * The part on which the transformer is to be applied to.
     */
    part: Part
}

/**
 * Interpolates arpeggiated chords as ornaments, inserts them as physical
 * values into the MPM and substracts accordingly from the MIDI onset, so
 * that after the transformation all notes of the chord will have the same
 * onset.
 */
export class InsertDynamicsGradient extends AbstractTransformer<InsertDynamicsGradientOptions> {
    constructor(options?: InsertDynamicsGradientOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            part: 'global'
        })
    }

    public name() { return 'InsertDynamicsGradient' }

    public transform(msm: MSM, mpm: MPM): string {
        const chords = msm.asChords(this.options?.part)
        for (let [date, arpeggioNotes] of Object.entries(chords)) {
            // only consider notes with a defined onset time
            arpeggioNotes = arpeggioNotes.filter(note => isDefined(note['midi.onset']))

            // The dynamics gradient is the transition
            // between first and last arpeggio note
            const firstVel = arpeggioNotes[0]["midi.velocity"]
            const lastVel = arpeggioNotes[arpeggioNotes.length - 1]["midi.velocity"]
            const dynamicDiff = lastVel - firstVel

            let gradient: DynamicsGradient
            if (dynamicDiff > 0) gradient = 'crescendo'
            else if (dynamicDiff < 0) gradient = 'decrescendo'
            else gradient = 'no-gradient'

            const avarageVelocity = (lastVel + firstVel) / 2
            const scale = Math.max(lastVel, firstVel) - avarageVelocity

            const ornament: Ornament = {
                'type': 'ornament',
                'xml:id': 'ornament_' + v4(),
                'date': +date,
                'name.ref': 'neutralArpeggio',
                gradient,
                scale
            }
            mpm.insertInstruction(ornament, this.options.part || 'global')

            arpeggioNotes.forEach(note => {
                note['midi.velocity'] = avarageVelocity
            })
        }

        // hand it over to the next transformer
        return super.transform(msm, mpm)
    }
}
