import { Scope } from "../mpm";
import { parse } from "js2xmlparser";
import { isDefined } from "../utils/utils";
import { PULSES_PER_QUARTER } from "../ppq";

type PhysicalAttributes = {
    'midi.onset': number
    'midi.duration': number
}

/**
 * What the score carries beyond the score.
 *
 * This used to hold the reduction as it ran — `tickDate`, `tickDuration` and
 * `absoluteVelocityChange`, each transformer subtracting its share and writing the rest back for
 * the next one. All three are gone: what a fitter has left to explain is derived from the score,
 * the recording and the MPM by `deriveResidual`, so an MSM comes out of a chain the way it went
 * in. `source` is not part of that — it records which reading of a passage a note came from, and
 * `MakeChoice` selects on it.
 */
type TemporaryAttributes = Partial<{
    source: string
}>

export type MsmPedal = {
    'xml:id': string
    type: 'sustain' | 'soft'
} & PhysicalAttributes & TemporaryAttributes


/**
 * Represents a score note as part of an MSM encoding. 
 * During the process of MPM generation several temporary 
 * attributes will be attached to it.
 */
export type MsmNote = {
    readonly 'xml:id': string,
    readonly 'part': number,
    readonly 'date': number,
    'duration': number
    readonly pitchname: string
    readonly accidentals: number
    readonly octave: number
} & PhysicalAttributes & {
    'midi.pitch': number
    'midi.velocity': number
} & TemporaryAttributes

/**
 * Used to represent a homophonized version of the score.
 */
export type ChordMap = Map<number, MsmNote[]>

export type TimeSignature = {
    numerator: number
    denominator: number
}

/**
 * This class represents an MSM encoding.
 */
export class MSM {
    allNotes: MsmNote[]
    pedals: MsmPedal[]
    timeSignature?: TimeSignature

    /**
     * Constructs an MSM representation from a done
     * score-to-performance alignment. 
     * 
     * @param notes (usually constructed from an alignment)
     * containing information about symbolic time and the
     * real (physical) time.
     */
    constructor(notes?: MsmNote[], timeSignature?: TimeSignature) {
        this.pedals = []
        // Sorted into a copy, not in place. `sort` mutates its receiver, so sorting the array
        // the caller passed reordered *their* array as a side effect of construction — which is
        // how `clone()` used to reorder the very score it claimed to be copying.
        this.allNotes = notes ? [...notes].sort((a, b) => a['date'] - b['date']) : []

        if (timeSignature) {
            this.timeSignature = timeSignature
        }
    }

    /**
     * An independent copy of this score.
     *
     * This used to be the shallow one: it handed `this.allNotes` to the constructor and assigned
     * `this.pedals` across, so the "copy" shared both arrays *and* every note object with the
     * original. Writing a velocity through it wrote through to the original, and constructing it
     * re-sorted the original in place. Nothing wanted that, so there is only one kind of copy
     * now and both names give it.
     */
    public clone() {
        return this.deepClone()
    }

    public deepClone() {
        const clone = new MSM()
        clone.allNotes = this.allNotes.map(note => ({ ...note }))
        clone.pedals = this.pedals.map(pedal => ({ ...pedal }))
        // Spreading an absent time signature yields `{}`, which is not a TimeSignature but
        // typechecked as one: the copy then reported `numerator` and `denominator` as undefined
        // where the original had honestly reported having no time signature at all.
        clone.timeSignature = this.timeSignature ? { ...this.timeSignature } : undefined
        return clone
    }

    /**
     * Attach arbitrary extra keys to one note.
     *
     * The keys are by definition not in `MsmNote`, so the write goes through an index signature
     * the type does not have. That cast is the whole of the untypedness and it stays here.
     */
    public addCustomInfo(scoreId: string, info: Record<string, unknown>) {
        const target = this.allNotes.find(note => note["xml:id"] === scoreId)
        if (!target) return

        const bag = target as unknown as Record<string, unknown>
        for (const [key, value] of Object.entries(info)) {
            bag[key] = value
        }
    }

    /**
     * Deletes the silence before the first note is being played 
     */
    public shiftToFirstOnset() {
        const notesWithOnset = this.allNotes.filter(n => isDefined(n['midi.onset']))
        const min = Math.min(...notesWithOnset.map(n => n['midi.onset']))

        this.pedals.forEach(p => {
            if (p["midi.onset"] < min) {
                p["midi.duration"] -= (min - p["midi.onset"])
                p['midi.onset'] = 0
            }
            else p['midi.onset'] -= min
        })

        if (min) notesWithOnset.forEach(n => n['midi.onset'] -= min)
    }

    /**
     * The MSM as a document, with the recording in it unless asked to leave it out.
     *
     * Kept as-is for existing callers; `serializeScore` is what a renderer should be given.
     */
    public serialize(filterIntermediateAttributes = true) {
        return this.build(filterIntermediateAttributes ? 'none' : 'all')
    }

    /**
     * The MSM as a *score*: symbolic dates and durations plus `midi.pitch`, and nothing the
     * performance put there.
     *
     * This is what goes to espressivo when a residual is derived. Handing the renderer the
     * recorded `midi.onset` as well would be harmless — it reads `date`/`duration` — but it
     * makes the document ambiguous about which timing it is stating, and the whole point of
     * the residual is to keep the recording and the rendering apart.
     */
    public serializeScore() {
        return this.build('pitch')
    }

    /**
     * Serialize the MSM as an XML document.
     *
     * @param midi which of a note's MIDI attributes to carry into the document. `'none'` is
     * symbolic only; `'pitch'` adds `midi.pitch`, which is the least a renderer needs to sound
     * the note and the most a *score* should say; `'all'` adds the recorded `midi.onset`,
     * `midi.duration` and `midi.velocity` as well.
     */
    private build(midi: 'none' | 'pitch' | 'all') {
        if (this.allNotes.length === 0) {
            console.log('no notes to serialize')
            return
        }

        const msm = {
            '@': {
                title: 'aligned performance',
                pulsesPerQuarter: PULSES_PER_QUARTER,
            },
            'global': {
                'header': {},
                'dated': {
                    'timeSignatureMap': {
                        'timeSignature': {
                            '@': {
                                'date': 0.0,
                                'numerator': this.timeSignature?.numerator || 4,
                                'denominator': this.timeSignature?.denominator || 4,
                            }
                        }
                    },
                    'sectionMap': {
                        // TODO: derive from FormalAlterations
                        'section': {
                            '@': {
                                date: 0.0,
                                'date.end': this.allNotes[this.allNotes.length - 1].date
                            }
                        }
                    },
                    // Inside `<dated>`, not beside it. espressivo reads the pedals from the
                    // global `<dated>` (`Performance.addMsmMapToList('pedalMap', globalDated)`)
                    // and its own `Msm.createMsm` nests it there, so a `<pedalMap>` one level up
                    // was simply never found — every serialized pedal was invisible to the
                    // renderer, silently.
                    'pedalMap': {
                        'pedal': this.pedals.map(pedal => {
                            return {
                                '@': pedal
                            }
                        })
                    }
                }
            },
            // One `<part>` per part the notes actually use, ascending. This was
            // `Array.from(Array(2).keys())` — exactly two, always — so every note in part 3 or
            // higher was dropped from the serialized score without a word, and a single-part
            // piece still emitted an empty second `<part>`. `parts()` is the same 0-based
            // numbering `notesInPart` uses. See issue #34.
            'part': [...this.parts()].sort((a, b) => a - b).map(part => {
                return {
                    '@': {
                        name: `part${part}`,
                        number: `${part + 1}`,
                        'midi.channel': part,
                        'midi.port': 0
                    },
                    header: {},
                    dated: {
                        'programChangeMap': {
                            'programChange': {
                                '@': {
                                    date: 0,
                                    value: 0
                                }
                            }
                        },
                        score: {
                            'note': this.allNotes
                                .filter(note => note.part === part + 1)
                                .map(note => {
                                    const result = {
                                        'xml:id': note['xml:id'],
                                        'date': note['date'],
                                        'pitchname': note['pitchname'],
                                        'octave': note['octave'],
                                        'accidentals': note['accidentals'],
                                        'duration': note['duration']
                                    } as Record<string, unknown>

                                    if (midi !== 'none' && note['midi.pitch']) {
                                        result['midi.pitch'] = note['midi.pitch']
                                    }
                                    if (midi === 'all') {
                                        if (note['midi.onset']) {
                                            result['midi.onset'] = note['midi.onset']
                                        }
                                        if (note['midi.duration']) {
                                            result['midi.duration'] = note['midi.duration']
                                        }
                                        if (note['midi.velocity']) {
                                            result['midi.velocity'] = note['midi.velocity']
                                        }
                                    }

                                    return {
                                        '@': result
                                    }
                                })
                        }
                    }
                }
            })
        }

        return parse('msm', msm)
    }

    /**
     * Returns all notes present at a given score date in a given
     * part.
     * @param tstamp score date
     * @param part if "global", all parts will be considered
     * @returns array of MSM notes
     */
    public notesAtDate(tstamp: number, part: Scope): MsmNote[] {
        return this.allNotes.filter(note => {
            return (typeof part === 'number') ?
                (note.date === tstamp && note.part === part + 1) // a specific part
                : (note.date === tstamp) // consider all parts
        })
    }

    /** The note with this `xml:id`, or `undefined`. */
    public getByID(id: string): MsmNote | undefined {
        return this.allNotes.find(note => {
            return note["xml:id"] === id
        })
    }

    /**
     * Generates a homophonized version of the MSM score.
     *
     * The sort runs on a copy. Asking a score to describe itself as chords used to reorder it:
     * for `'global'` the local was `this.allNotes` itself, so a read-only-looking query left the
     * score permanently sorted by date.
     */
    public asChords(part: Scope = 'global'): ChordMap {
        const notes = (part === 'global'
            ? [...this.allNotes]
            : this.allNotes.filter(n => n.part - 1 === part))
            .sort((a, b) => a.date - b.date)

        return notes.reduce((prev, curr) => {
            const chord = prev.get(curr.date)
            if (chord) chord.push(curr)
            else prev.set(curr.date, [curr])
            return prev
        }, new Map() as ChordMap)
    }

    /**
     * Returns the last date, at which a note is present.
     * @returns score date in ticks
     */
    public lastDate(): number {
        // `Math.max()` of nothing is -Infinity, which every comparison downstream reads as a
        // date before the start of the piece. An empty score ends where it begins.
        if (this.allNotes.length === 0) return 0
        return Math.max(...this.allNotes.map(note => note.date))
    }

    public get end(): number {
        if (this.allNotes.length === 0) return 0
        return Math.max(...this.allNotes.map(note => note.date + note.duration))
    }

    /**
     * Returns the last note
     * @returns MSM note
     */
    public lastNote(): MsmNote | undefined {
        return this.allNotes.find(n => n.date === this.lastDate())
    }

    public parts() {
        return new Set(this.allNotes.map(note => note.part - 1))
    }

    /**
     * The notes of one part, or of the whole score.
     *
     * Both branches answer with a fresh array. The `'global'` branch used to answer with
     * `this.allNotes` itself, so a caller that sorted or spliced what it got back was editing
     * the score through what reads as a query.
     */
    public notesInPart(part: Scope): MsmNote[] {
        return part === 'global'
            ? [...this.allNotes]
            : this.allNotes.filter(n => n.part - 1 === part)
    }

    public notesInRange(from: number, to: number, scope: Scope) {
        return this.notesInPart(scope).filter(note => {
            return note.date >= from && note.date <= to
        })
    }
}

