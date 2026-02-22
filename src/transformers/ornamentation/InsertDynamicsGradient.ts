import { MPM, Ornament } from "mpm-ts"
import { MSM, MsmNote } from "../../msm"
import { isDefined } from "../../utils/utils"
import { AbstractTransformer, generateId, ScopedTransformationOptions } from "../Transformer"

export type DynamicsGradient = { from: number, to: number }
export type DatedDynamicsGradient = Map<number, DynamicsGradient>

type SingleGradient = {
    date: number
    gradient: DynamicsGradient
}

type DefaultGradients = {
    crescendo: DynamicsGradient
    decrescendo: DynamicsGradient
}

const isSingleGradient = (gradient: SingleGradient | DefaultGradients): gradient is SingleGradient => {
    return (gradient as SingleGradient).date !== undefined && (gradient as SingleGradient).gradient !== undefined;
}


export type InsertDynamicsGradientOptions = ScopedTransformationOptions
    & (SingleGradient | DefaultGradients)
    & {
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
    requires = []

    constructor(options?: InsertDynamicsGradientOptions) {
        super()

        // set the default options
        this.options = options || {
            scope: 'global',
            crescendo: { from: -1, to: 0 },
            decrescendo: { from: 0, to: -1 },
            sortVelocities: false
        }
    }

    /**
     * @note If gradient is undefined, it will be estimated.
     */
    private applyGradient = (msm: MSM, mpm: MPM, date: number, gradient?: DynamicsGradient) => {
        let arpeggioNotes = msm.asChords(this.options.scope).get(date)

        if (this.options.sortVelocities) {
            const defaultDirection = this.sortVelocities(arpeggioNotes)
            if (!gradient && !isSingleGradient(this.options)) {
                gradient = defaultDirection === 'crescendo' ? this.options.crescendo : this.options.decrescendo
            }
        }

        // only consider notes with a defined onset time
        arpeggioNotes = arpeggioNotes
            .filter(note => isDefined(note['midi.onset']))
            .sort((a, b) => a['midi.onset'] - b['midi.onset'])

        // The dynamics gradient is the transition
        // between first and last arpeggio note
        const firstVel = arpeggioNotes[0]["midi.velocity"]
        const lastVel = arpeggioNotes[arpeggioNotes.length - 1]["midi.velocity"]

        const dynamicDiff = lastVel - firstVel
        if (dynamicDiff === 0) return

        const diffVel = lastVel - firstVel
        const diffGradient = gradient.to - gradient.from
        const scale = diffVel / diffGradient
        const standard = firstVel - gradient.from * scale

        if (scale === 0) return

        const ornament: Ornament = {
            'type': 'ornament',
            'xml:id': generateId('ornament', date, mpm),
            date,
            'name.ref': 'neutralArpeggio',
            'transition.from': gradient.from,
            'transition.to': gradient.to,
            scale
        }
        mpm.insertInstruction(ornament, this.options.scope)

        arpeggioNotes.forEach(note => {
            note['midi.velocity'] = standard
        })
    }

    protected transform(msm: MSM, mpm: MPM) {
        if (isSingleGradient(this.options)) {
            this.applyGradient(msm, mpm, this.options.date, this.options.gradient)
        }
        else {
            const chords = msm.asChords(this.options?.scope)
            for (const [date, arpeggioNotes] of chords) {
                if (arpeggioNotes.length === 1) continue

                this.applyGradient(msm, mpm, date)
            }
        }
    }

    private sortVelocities(chord: MsmNote[]): 'crescendo' | 'descrescendo' {
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
        
        return loudestPos > quietestPos ? 'crescendo' : 'descrescendo';
    }
}
