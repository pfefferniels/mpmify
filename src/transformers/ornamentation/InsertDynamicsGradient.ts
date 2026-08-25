import { InstructionOptions, Mpm, fillInAt, requireMap, setOrnamentDraft } from "../../mpm"
import { MSM, MsmNote } from "../../msm"
import { isDefined } from "../../utils/utils"
import { AbstractTransformer, generateId, ScopedTransformationOptions } from "../Transformer"

/**
 * The velocity ramp across an arpeggio, in the normalized units a `<dynamicsGradient>`'s
 * `transition.from`/`transition.to` use. Named apart from espressivo's `DynamicsGradient`, the
 * `<ornamentDef>` child it is fitted into but is not.
 */
export type GradientRange = { from: number, to: number }
export type DatedGradientRange = Map<number, GradientRange>

type SingleGradient = {
    date: number
    gradient: GradientRange
}

type DefaultGradients = {
    crescendo: GradientRange
    decrescendo: GradientRange
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
        super(options || {
            scope: 'global',
            crescendo: { from: -1, to: 0 },
            decrescendo: { from: 0, to: -1 },
            sortVelocities: false
        })
    }

    /**
     * @note If gradient is undefined, it will be estimated.
     *
     * @note The chord is passed in rather than looked up. This used to open with
     * `msm.asChords(scope).get(date)` — a full walk-and-group of every note in the score — while
     * its only bulk caller was already iterating exactly that map, so the whole score was
     * regrouped once per chord in it.
     */
    private applyGradient = (mpm: Mpm, date: number, chord: MsmNote[], gradient?: GradientRange) => {
        let arpeggioNotes = chord
        if (arpeggioNotes.length === 0) return

        // Which of the two default gradients the chord calls for is a property of the chord,
        // not of whether the velocities are also being rewritten. Reading it inside the
        // `sortVelocities` branch left `gradient` undefined — and the arithmetic below
        // throwing — for the whole `sortVelocities: false` configuration, which is the
        // constructor's own default. See old-bugs.md.
        if (!gradient && !isSingleGradient(this.options)) {
            gradient = directionOf(arpeggioNotes) === 'crescendo'
                ? this.options.crescendo
                : this.options.decrescendo
        }

        if (this.options.sortVelocities) {
            this.sortVelocities(arpeggioNotes)
        }

        if (!gradient) return

        // only consider notes with a defined onset time
        arpeggioNotes = arpeggioNotes
            .filter(note => isDefined(note['midi.onset']))
            .sort((a, b) => a['midi.onset'] - b['midi.onset'])

        // The dynamics gradient is the transition
        // between first and last arpeggio note
        const firstVel = arpeggioNotes[0]["midi.velocity"]
        const lastVel = arpeggioNotes[arpeggioNotes.length - 1]["midi.velocity"]

        const diffVel = lastVel - firstVel
        if (diffVel === 0) return

        const diffGradient = gradient.to - gradient.from
        const scale = diffVel / diffGradient
        const standard = firstVel - gradient.from * scale

        if (scale === 0) return

        // `fillInAt`, not `addOrnamentV3`: `InsertTemporalSpread` describes the other half of
        // this same `<ornament>`, and whichever runs second has to find the first's element.
        const map = requireMap(mpm, 'ornament', this.options.scope)
        const options: InstructionOptions<'ornament'> = {
            id: generateId('ornament', date, mpm),
            date,
            nameRef: 'neutralArpeggio',
            scale
        }
        const element = fillInAt(map, options, {
            localName: 'ornament',
            add: o => map.addOrnamentV3(o),
            read: i => map.getOrnamentOptionsOf(i),
            update: (i, patch) => map.updateOrnamentAt(i, patch),
        })

        // The ramp's two ends belong on the `<dynamicsGradient>` of the def this ornament will
        // come to name, and MPM has no place for them on the instruction. They travel parked on
        // the element until `StylizeOrnamentation` decides which ornaments share a definition.
        setOrnamentDraft(element, {
            transitionFrom: gradient.from,
            transitionTo: gradient.to
        })

        arpeggioNotes.forEach(note => {
            note['midi.velocity'] = standard
        })
    }

    protected transform(msm: MSM, mpm: Mpm) {
        const chords = msm.asChords(this.options?.scope)

        if (isSingleGradient(this.options)) {
            const chord = chords.get(this.options.date)
            if (!chord) return
            this.applyGradient(mpm, this.options.date, chord, this.options.gradient)
        }
        else {
            for (const [date, arpeggioNotes] of chords) {
                if (arpeggioNotes.length === 1) continue

                this.applyGradient(mpm, date, arpeggioNotes)
            }
        }
    }

    /**
     * Rewrite the chord's velocities so they rise or fall monotonically in onset order, in
     * whichever direction the chord already leans.
     */
    private sortVelocities(chord: MsmNote[]): ArpeggioDirection {
        const direction = directionOf(chord)

        const velocities = [...chord.map(note => note['midi.velocity'])];
        velocities.sort((a, b) => direction === 'crescendo' ? a - b : b - a);
        chord
            .sort((a, b) => a["midi.onset"] - b["midi.onset"])
            .forEach((note, i) => {
                note["midi.velocity"] = velocities[i];
            })

        return direction;
    }
}

export type ArpeggioDirection = 'crescendo' | 'descrescendo'

/**
 * Whether a chord's velocities lean up or down across the arpeggio: up if its loudest note
 * comes after its quietest in onset order.
 *
 * Sorts the chord by onset, which the callers rely on.
 */
const directionOf = (chord: MsmNote[]): ArpeggioDirection => {
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

    return loudestPos > quietestPos ? 'crescendo' : 'descrescendo';
}
