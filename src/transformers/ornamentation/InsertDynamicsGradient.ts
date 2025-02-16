import { MPM, Ornament, Scope } from "mpm-ts"
import { MSM, MsmNote } from "../../msm"
import { isDefined } from "../../utils/utils"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
import { v4 } from "uuid"

export type DynamicsGradient = { from: number, to: number }
export type DatedDynamicsGradient = Map<number, DynamicsGradient>

export interface InsertDynamicsGradientOptions extends TransformationOptions {
    /**
     * The part on which the transformer is to be applied to.
     */
    part: Scope

    /**
     * Allows to define a custom dynamics gradient for each chord.
     * If no gradient is defined, the transformer will use [-1, 0] 
     * as default for crescendo and [0, -1] for decrescendo.
     */
    gradients: DatedDynamicsGradient

    /**
     * Whether to sort the velocities of the notes in the chord.
     * @note This will also change the order of notes in the chord.
     */
    sortVelocities: boolean
}

/**
 * Interpolates arpeggiated chords as ornaments, inserts them as physical
 * values into the MPM and substracts accordingly from the MIDI onset, so
 * that after the transformation all notes of the chord will have the same
 * onset.
 * 
 * @note Inserting the dynamics gradient should always take place before 
 * inserting temporal spread, since temporal spread will destroy the original
 * order of MIDI onsets.
 */
export class InsertDynamicsGradient extends AbstractTransformer<InsertDynamicsGradientOptions> {
    name = 'InsertDynamicsGradient'

    constructor(options?: InsertDynamicsGradientOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            part: 'global',
            gradients: new Map(),
            sortVelocities: false
        })
    }

    public transform(msm: MSM, mpm: MPM) {
        const chords = msm.asChords(this.options?.part)
        for (let [date, arpeggioNotes] of chords) {
            if (this.options.sortVelocities) {
                this.sortVelocities(arpeggioNotes)
            }

            // only consider notes with a defined onset time
            arpeggioNotes = arpeggioNotes
                .filter(note => isDefined(note['midi.onset']))
                .sort((a, b) => a['midi.onset'] - b['midi.onset'])

            // The dynamics gradient is the transition
            // between first and last arpeggio note
            const firstVel = arpeggioNotes[0]["midi.velocity"]
            const lastVel = arpeggioNotes[arpeggioNotes.length - 1]["midi.velocity"]

            let gradient: DynamicsGradient = this.options.gradients.get(date)
            if (!gradient) {
                const dynamicDiff = lastVel - firstVel
                if (dynamicDiff === 0) continue
                else if (dynamicDiff > 0) gradient = { from: -1, to: 0 }
                else if (dynamicDiff < 0) gradient = { from: 0, to: -1 }
            }

            const diffVel = lastVel - firstVel
            const diffGradient = gradient.to - gradient.from
            const scale = diffVel / diffGradient
            const standard = firstVel - gradient.from * scale

            if (scale === 0) continue

            const ornament: Ornament = {
                'type': 'ornament',
                'xml:id': 'ornament_' + v4(),
                date,
                'name.ref': 'neutralArpeggio',
                'transition.from': gradient.from,
                'transition.to': gradient.to,
                scale
            }
            mpm.insertInstruction(ornament, this.options.part)

            arpeggioNotes.forEach(note => {
                note['midi.velocity'] = standard
            })
        }
    }

    private sortVelocities(chord: MsmNote[]) {
        chord.sort((a, b) => a["midi.onset"] - b["midi.onset"])

        let loudestPos = 0;
        let quietestPos = 0;
        chord.forEach((note, index) => {
            if (note['midi.velocity'] > chord[loudestPos]['midi.velocity']) {
                loudestPos = index;
            }
            if (note['midi.velocity'] < chord[quietestPos]['midi.velocity']) {
                quietestPos = index;
            }
        });

        const velocities = [...chord.map(note => note['midi.velocity'])];
        velocities.sort((a, b) => loudestPos > quietestPos ? a - b : b - a);
        chord
            .sort((a, b) => a["midi.onset"] - b["midi.onset"])
            .forEach((note, i) => {
                note["midi.velocity"] = velocities[i];
            })
    }
}
