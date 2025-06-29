import { Scope } from "mpm-ts";
import { parse } from "js2xmlparser";
import { isDefined } from "../utils/utils";

type PhysicalAttributes = {
    'midi.onset': number
    'midi.duration': number
}

/**
 * Temporary attributes used and manipulated in the process of approximation.
 */
type TemporaryAttributes = Partial<{
    tickDate: number
    tickDuration: number
    absoluteVelocityChange: number
    source: string
}>

export type MsmPedal = {
    'xml:id': string
    date?: number
    'date.end'?: number
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
        this.allNotes = notes ? notes.sort((a, b) => a['date'] - b['date']) : []

        if (timeSignature) {
            this.timeSignature = timeSignature
        }
    }

    public clone() {
        const clone = new MSM(this.allNotes, this.timeSignature)
        clone.pedals = this.pedals
        return clone
    }

    public deepClone() {
        const clone = new MSM()
        clone.allNotes = this.allNotes.map(note => ({ ...note }))
        clone.pedals = this.pedals.map(pedal => ({ ...pedal }))
        clone.timeSignature = { ...this.timeSignature }
        return clone
    }

    public addCustomInfo(scoreId: string, info: any) {
        const target = this.allNotes.find(note => note["xml:id"] === scoreId)
        if (!target) return

        for (const [key, value] of Object.entries(info)) {
            target[key] = value
        }
    }

    /**
     * Deletes the silence before the first note is being played 
     */
    public shiftToFirstOnset() {
        const notesWithOnset = this.allNotes.filter(n => isDefined(n['midi.onset']))
        const min = Math.min(...notesWithOnset.map(n => n['midi.onset']))

        const pedals = this.pedals.forEach(p => {
            if (p["midi.onset"] < min) {
                p["midi.duration"] -= (min - p["midi.onset"])
                p['midi.onset'] = 0
            }
            else p['midi.onset'] -= min
        })

        if (min) notesWithOnset.forEach(n => n['midi.onset'] -= min)
    }

    public serialize(filterIntermediateAttributes = true) {
        if (this.allNotes.length === 0) {
            console.log('no notes to serialize')
            return
        }

        const msm = {
            '@': {
                title: 'aligned performance',
                pulsesPerQuarter: 720,
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
                },
                'pedalMap': {
                    'pedal': this.pedals.map(pedal => {
                        return {
                            '@': pedal
                        }
                    })
                }
            },
            'part': Array.from(Array(2).keys()).map(part => {
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
                                    } as any

                                    if (!filterIntermediateAttributes) {
                                        if (note['midi.pitch']) {
                                            result['midi.pitch'] = note['midi.pitch']
                                        }
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

    public getByID(id: string): MsmNote | null {
        return this.allNotes.find(note => {
            return note["xml:id"] === id
        })
    }

    /**
     * Generates a homophonized version of the MSM score.
     * @returns 
     */
    public asChords(part: Scope = 'global'): ChordMap {
        const notes = part === 'global'
            ? this.allNotes
            : this.allNotes.filter(n => n.part - 1 === part)

        notes.sort((a, b) => a.date - b.date)

        return notes.reduce((prev, curr) => {
            // console.log('curr=', curr)
            if (prev.has(curr.date)) {
                prev.set(curr.date, [...prev.get(curr.date), curr])
            }
            else {
                prev.set(curr.date, [curr])
            }
            return prev
        }, new Map() as ChordMap)
    }

    /**
     * Returns the last date, at which a note is present.
     * @returns score date in ticks
     */
    public lastDate(): number {
        return Math.max(...this.allNotes.map(note => note.date))
    }

    public get end(): number {
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

    public notesInPart(part: Scope) {
        return part === 'global'
            ? this.allNotes
            : this.allNotes.filter(n => n.part - 1 === part)
    }
}

export const parseMSM = (msm: string) => {
    const domParser = new DOMParser()
    const dom = domParser.parseFromString(msm, 'application/xml')
    const notes = [...dom.querySelectorAll('note')].map(el => {
        return {
            'accidentals': +(el.getAttribute('accidentals') || ''),
            'date': +(el.getAttribute('date') || ''),
            'duration': +(el.getAttribute('duration') || ''),
            'midi.duration': +(el.getAttribute('midi.duration') || ''),
            'midi.onset': +(el.getAttribute('midi.onset') || ''),
            'midi.pitch': +(el.getAttribute('midi.pitch') || ''),
            'midi.velocity': +(el.getAttribute('midi.pitch') || ''),
            'octave': +(el.getAttribute('octave') || ''),
            'part': +(el.closest('part')?.getAttribute('number') || ''),
            'pitchname': el.getAttribute('pitchname') || '',
            'xml:id': el.getAttribute('pitchname') || ''
        } as MsmNote
    })
    const timeSignature = dom.querySelector('timeSignature')
    return new MSM(notes, {
        numerator: +(timeSignature?.getAttribute('numerator') || ''),
        denominator: +(timeSignature?.getAttribute('denominator') || '')
    })
}
