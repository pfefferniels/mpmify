import { parse } from "js2xmlparser"
import { v4 } from "uuid"

interface WithXmlId {
    'xml:id': string
}

/**
 * A part can be specified as either a given
 * part number or global. This definition is 
 * used in both, MSM and MPM.
 */
export type Part = 0 | 1 | 'global'

type Definition<T extends string> = {
    readonly type: T
}

export interface OrnamentDef extends Definition<'ornament'> {
    'name'?: string
    'frameLength'?: number
    'frame.start'?: number
    'noteoff.shift'?: string,
    'transition.from'?: number
    'transition.to'?: number
    'time.unit'?: 'ticks' | 'milliseconds'
}

type AnyDefinition =
    | OrnamentDef

export const definitionTypes =
    [
        'ornamentDef'
    ] as const

type DefinitionType = typeof definitionTypes[number]

export type DatedInstruction<T extends string> = {
    readonly type: T
    date: number

    // optionally, a particular note can be specified
    noteid?: string
}

/**
 * Maps the <dynamics> element of MPM
 */
export interface Dynamics extends DatedInstruction<'dynamics'>, WithXmlId {
    'volume': number | string
    'transition.to'?: number
    'protraction'?: number
}

/**
 * Maps the <tempo> element of MPM
 */
export interface Tempo extends DatedInstruction<'tempo'>, WithXmlId {
    'bpm': number
    'beatLength': number
    'transition.to'?: number
    'meanTempoAt'?: number
}

/**
 * Maps the <asynchrony> element of MPM
 */
export interface Asynchrony extends DatedInstruction<'asynchrony'>, WithXmlId {
    'milliseconds.offset': number
}

/**
 * Maps the <articulation> element of MPM
 */
export interface Articulation extends DatedInstruction<'articulation'>, WithXmlId {
    relativeDuration: number
}

export type DynamicsGradient = 'crescendo' | 'decrescendo' | 'no-gradient'

/**
 * Maps the <ornament> element of MPM
 */
export interface Ornament extends DatedInstruction<'ornament'>, WithXmlId {
    'name.ref': string
    'note.order': string
    'frameLength'?: number
    'frame.start'?: number
    'noteoff.shift'?: string,
    'transition.from'?: number
    'transition.to'?: number
    'time.unit'?: 'ticks' | 'milliseconds'
    'scale': number
    'gradient'?: 'crescendo' | 'decrescendo' | 'no-gradient'
}

/**
 * Maps the <rubato> element of MPM
 */
export interface Rubato extends DatedInstruction<'rubato'>, WithXmlId {
    'frameLength': number,
    'loop': boolean
    'intensity': number
}

type AnyInstruction =
    | Tempo
    | Ornament
    | Dynamics
    | Asynchrony
    | Articulation
    | Rubato

export const instructionTypes =
    [
        'tempo',
        'ornament',
        'dynamics',
        'asynchrony',
        'articulation',
        'rubato'
    ] as const

type InstructionType = typeof instructionTypes[number]

type RelatedResource = {
    uri: string,
    type: string
}

type Metadata = {
    authors: string[],
    comments: string[],
    relatedResources: RelatedResource[]
}

/**
 * Represents an MPM encoding and exposes some methods for
 * easily working with it.
 */
export class MPM {
    rawMPM: any

    constructor(nParts = 2) {
        this.rawMPM = {
            "@": {
                xmlns: "http://www.cemfi.de/mpm/ns/1.0"
            },
            metadata: {},
            performance: {
                "@": {
                    name: 'unknown',
                    pulsesPerQuarter: 720
                },
                global: {
                    header: {
                        ornamentationStyles: {}
                    },
                    dated: {}
                },
                part: Array.from(Array(nParts).keys()).map(i => {
                    return {
                        "@": {
                            name: `part${i}`,
                            number: `${i + 1}`,
                            "midi.channel": `${i}`,
                            "midi.port": "0"
                        },
                        header: {},
                        dated: {}
                    }
                })
            }
        }
    }

    /**
     * Returns the instructions at a given date.
     * @param date 
     * @param part If not specified, all parts are considered
     * @todo
     */
    instructionsEffectiveAtDate<T>(date: number, type?: InstructionType, part?: Part): T[] {
        const parts: Part[] = part ? [part] : [0, 1, 'global']
        const instructionTypesToGet = type ? [type] : instructionTypes

        const result: T[] = []

        for (const instructionType of instructionTypesToGet) {
            for (part of parts) {
                const instructions = this.getInstructions<T>(type, part)

                const found = instructions.find(instruction => (instruction as any).date === date)
                if (found) {
                    result.push(found)
                }
                else {
                    const ongoingInstruction =
                        instructions.slice().reverse().find(instruction => (instruction as any).date <= date)

                    if (!ongoingInstruction) continue

                    if (instructionType === 'tempo') {
                        result.push(ongoingInstruction)
                    }
                    else if (instructionType === 'rubato') {
                        const rubato = ongoingInstruction as T as Rubato
                        if (rubato.loop) result.push(ongoingInstruction)
                        if (date < (rubato.date + rubato.frameLength)) {
                            result.push(ongoingInstruction)
                        }
                    }
                }
            }
        }
        return result
    }

    /**
     * Returns the instructions effective in a given range.
     * @param date 
     * @param part If not specified, all parts are considered
     * @todo
     */
    instructionEffectiveInRange<T>(from: number, to: number, type?: InstructionType, part?: Part): T[] {
        const parts: Part[] = part ? [part] : [0, 1, 'global']
        const instructionTypesToGet = type ? [type] : instructionTypes

        const result: T[] = []

        for (const instructionType of instructionTypesToGet) {
            for (part of parts) {
                const instructions = this.getInstructions<T>(type, part)

                const found = instructions.filter(instruction => {
                    const date = (instruction as any).date
                    return date >= from && date < to
                })
                if (found) {
                    result.push(...found)
                }

                const earlierInstruction =
                    instructions.slice().reverse().find((i: any) => i.date < from)

                if (!earlierInstruction) continue

                if (instructionType === 'tempo') {
                    const exactMatch = instructions.find((i: any) => i.date === from)
                    if (!exactMatch) result.push(earlierInstruction)
                }
                else if (instructionType === 'rubato') {
                    const rubato = earlierInstruction as T as Rubato
                    if (rubato.loop) result.push(earlierInstruction)
                    if (from < (rubato.date + rubato.frameLength)) {
                        result.push(earlierInstruction)
                    }
                }
            }
        }
        return result.sort((a: any, b: any) => a.date - b.date)
    }

    /**
     * Inserts a definion into its corresponding styles environment
     * in the header of the given part.
     * 
     * @param definition 
     * @param part 
     * @returns name of definition
     */
    insertDefinition(definition: AnyDefinition, part: Part): string {
        const type = definition.type
        const correspondingStylesName = {
            'ornament': 'ornamentationStyles'
        }[type]
        const styles = this.getStyles(correspondingStylesName)
        if (!styles) return ''

        // insert a style def if it doesn't exist yet
        if (!styles.styleDef) {
            styles.styleDef = {
                '@': {
                    'name': 'performance_style'
                },
            }
        }

        // insert a style switch in the map if it doesn't exist yet
        const correspondingMap = this.getMap(this.correspondingMapNameFor(type), part, true)
        if (!correspondingMap.get('style')) {
            const sortedMap = new Map(
                [['style', {
                    '@': {
                        'date': '0.0',
                        'name.ref': 'performance_style'
                    }
                }],
                ...correspondingMap]
            )
            this.setMap(this.correspondingMapNameFor(type), part, sortedMap)
        }

        const name = definition.name || `def_${v4()}`

        if (type === 'ornament') {
            if (!styles.styleDef.ornamentDef) {
                styles.styleDef.ornamentDef = []
            }

            const ornamentDef = styles.styleDef.ornamentDef
            let toPush: any = {
                '@': {
                    name
                }
            }
            if (definition["frame.start"] && definition['frameLength'] && definition['time.unit'] && definition['noteoff.shift']) {
                toPush['temporalSpread'] = {
                    '@': {
                        'frame.start': definition['frame.start'],
                        'frameLength': definition['frameLength'],
                        'time.unit': definition['time.unit'],
                        'noteoff.shift': definition['noteoff.shift']
                    }
                }
            }
            if (definition['transition.from'] && definition['transition.to']) {
                toPush['dynamicsGradient'] = {
                    '@': {
                        'transition.to': definition['transition.to'],
                        'transition.from': definition['transition.from']
                    }
                }
            }
            ornamentDef.push(toPush)
        }

        return name;
    }

    /**
     * Calls `insertDefinition` for each element in the given array.
     * @param definitions 
     * @param part 
     */
    insertDefinitions(definitions: AnyDefinition[], part: Part) {
        definitions.forEach(definition => {
            this.insertDefinition(definition, part)
        })
    }

    getDefinition(definitionType: DefinitionType, name: string): AnyDefinition | null {
        const styles = this.getStyles(this.correspondingStyleNameFor(definitionType))
        const defs = styles.styleDef[definitionType]
        if (!Array.isArray(defs)) return null

        const definition = defs.find(def => def['name'] === name)
        if (definitionType === 'ornamentDef') {
            const dynamicsGradient = definition.dynamicsGradient
            const temporalSpread = definition.temporalSpread
            return {
                'frame.start': temporalSpread['frame.start'] || 0,
                'frameLength': temporalSpread['frameLength'] || 0,
                'name': definition['@'].name || '',
                'noteoff.shift': temporalSpread['noteoff.shift'] || 0,
                'time.unit': temporalSpread['time.unit'] || 0,
                'transition.from': dynamicsGradient['transition.from'] || 0,
                'transition.to': dynamicsGradient['transition.to'] || 0,
                'type': 'ornament'
            } as OrnamentDef
        }
        return definition
    }

    /**
     * Based on the given instructions type, this method will
     * insert them into their corresponding map, e.g. <dynamics>
     * elements will be inserted to <dynamicsMap>. After inserting
     * the map will sorted by `date`.
     * 
     * @param instruction 
     * @param part a part number or 'global'
     */
    insertInstructions(instructions: AnyInstruction[], part: Part) {
        if (!instructions.length) return

        const instructionType = instructions[0].type
        const correspondingMapName = this.correspondingMapNameFor(instructionType)
        if (!correspondingMapName) return

        const map = this.getMap(correspondingMapName, part, true)

        if (!map) {
            console.log('cannot find part', part, 'in the MPM')
            return
        }

        if (Array.isArray(map.get(instructionType))) {
            map.set(instructionType,
                [...map.get(instructionType), // old instructions
                ...instructions.map(i => ({ '@': i }))] // new instructions
                    .sort((a, b) => (a['@']['date'] || 0) - (b['@']['date'] || 0)) // sort everything by date
            )
        }
        else {
            map.set(instructionType, instructions.map(i => ({ '@': i })))
        }
    }

    /**
     * Will remove the contents of a given map type.
     */
    removeInstructions(instructionType: InstructionType, part: Part) {
        const correspondingMapName = this.correspondingMapNameFor(instructionType)
        const map = this.getMap(correspondingMapName, part, false)

        if (!map) {
            console.log('cannot find part', part, 'in the MPM')
            return
        }

        if (Array.isArray(map.get(instructionType))) {
            map.delete(instructionType)
        }
    }

    /**
     * Gets all instructions inside a given map type.
     * @param part If not specified, both, global as well as all local maps will be considered.
     * @param instructionType The instruction type to filter for. If not specified, 
     * all instruction types will be considered.
     * @returns 
     */
    getInstructions<T>(instructionType?: InstructionType, part?: Part): T[] {
        const result = []
        const parts: Part[] = part ? [part] : ['global', 0, 1]
        const instructionTypesToGet = instructionType ? [instructionType] : instructionTypes

        for (const part of parts) {
            for (const instructionType of instructionTypesToGet) {
                const correspondingMapName = this.correspondingMapNameFor(instructionType)
                const map = this.getMap(correspondingMapName, part, false)
                if (!map) {
                    console.log('map', correspondingMapName, 'not found in MPM')
                    continue
                }

                if (!map.get(instructionType)) continue
                result.push(...map.get(instructionType).map((i: any) => i['@'] as T))
            }
        }

        return result
    }

    setPerformanceName(performanceName: string) {
        this.rawMPM.performance["@"].name = performanceName
    }

    setMetadata(metadata: Metadata) {
        this.rawMPM.metadata = {
            'author': metadata.authors.map((author, i) => {
                return {
                    '@': {
                        number: i
                    },
                    '#': author
                }
            }),
            'comment': metadata.comments,
            'relatedResources': {
                'resource': metadata.relatedResources.map(r => ({ '@': r }))
            }
        }
    }

    serialize() {
        return parse('mpm', this.rawMPM)
    }

    /**
     * Get a map of a certain part. Given e.g. 
     * the map name 'ornamentationMap' and the part 'global',
     * it returns the <ornamentationMap> inside the <global> environment.
     * 
     * @param mapName 
     * @param part 
     * @param create when true it creates a new map in the given part if it does not exist yet
     * @returns 
     */
    getMap(mapName: string, part: Part, create: boolean): Map<string, any> {
        const globalDated = this.rawMPM.performance.global.dated
        let map
        if (part === 'global') {
            // if the map does not exist yet, create it
            if (create && !globalDated[mapName]) {
                console.log('creating new', mapName, 'in the global dated environment.')
                globalDated[mapName] = new Map<string, any>()
            }

            map = this.rawMPM.performance.global.dated[mapName]
        }
        else if (typeof part === 'number') {
            const dated = this.rawMPM.performance.part.find((p: any) => +p['@'].number === (part + 1)).dated

            if (create && !dated[mapName]) {
                console.log('creating new', mapName, 'in the dated environment of part', part)
                dated[mapName] = new Map<string, any>()

                if (globalDated[mapName]) {
                    console.log('new local', mapName, 'will override an existing global map.')
                }
            }
            map = dated[mapName]
        }
        return map
    }

    setMap(mapName: string, part: Part, newContents: Map<string, any>) {
        const dated = part === 'global' ?
            this.rawMPM.performance.global.dated :
            this.rawMPM.performance.part.find((p: any) => +p['@'].number === (part + 1)).dated

        dated[mapName] = newContents;
    }

    /**
     * Returns the total amount of maps present in all the different parts.
     * @returns 
     */
    countMaps() {
        let counter = 0;
        ['global', 0, 1].forEach(part => {
            counter += instructionTypes.filter(instructionType =>
                this.getMap(this.correspondingMapNameFor(instructionType), part as Part, false) !== undefined).length
        })
        return counter
    }

    /**
     * Get a style. We assume all styles do be part of 
     * the global environment, since defining local styles
     * for a piano performance doesn't seem reasonable.
     * 
     * @param stylesName 
     * @returns 
     */
    getStyles(stylesName: string): any {
        return this.rawMPM.performance.global.header[stylesName]
    }

    private correspondingMapNameFor(instructionType: InstructionType) {
        return {
            dynamics: 'dynamicsMap',
            ornament: 'ornamentationMap',
            tempo: 'tempoMap',
            asynchrony: 'asynchronyMap',
            articulation: 'articulationMap',
            rubato: 'rubatoMap'
        }[instructionType]
    }

    private correspondingStyleNameFor(definitionType: DefinitionType) {
        return {
            ornamentDef: 'ornamentationStyles'
        }[definitionType]
    }
}

export const parseMPM = (xml: string) => {
    const dom = new DOMParser().parseFromString(xml, 'application/xml')
    const nParts = dom.querySelectorAll('performance part').length
    const mpm = new MPM(nParts)

    const parts = new Map<Part, Element | null>([
        [0, dom.querySelector('part[number="1"]')],
        [1, dom.querySelector('part[number="2"]')],
        ['global', dom.querySelector('global')]
    ])

    for (const [part, domPart] of parts) {
        if (!domPart) continue

        const ornamentDefs = [...domPart.querySelectorAll('ornamentDef')].map(el => {
            const name = el.getAttribute('name')
            const temporalSpread = el.querySelector('temporalSpread')
            const dynamicsGradient = el.querySelector('dynamicsGradient')
            return {
                'name': name,
                'frame.start': +temporalSpread?.getAttribute('frame.start'),
                'frameLength': +temporalSpread?.getAttribute('frameLength'),
                'noteoff.shift': temporalSpread?.getAttribute('noteoff.shift'),
                'time.unit': temporalSpread?.getAttribute('time.unit') as 'ticks' | 'milliseconds',
                'transition.from': +dynamicsGradient?.getAttribute('transition.from'),
                'transition.to': +dynamicsGradient?.getAttribute('transition.to'),
                'type': 'ornament'
            } as OrnamentDef
        })

        const dynamics = [...domPart.querySelectorAll('dynamics')].map(el => {
            const result: Dynamics = {
                type: 'dynamics' as 'dynamics',
                date: +(el.getAttribute('date') || 0),
                volume: +(el.getAttribute('volume') || 0),
                'xml:id': el.getAttribute('xml:id') || `ornament_${v4()}`
            }

            const trans = el.getAttribute('transition.to')
            if (trans) result['transition.to'] = +trans

            const protraction = el.getAttribute('protraction')
            if (protraction) result.protraction = +protraction

            const noteId = el.getAttribute('noteid')
            if (noteId) result.noteid = noteId
            return result
        })

        const ornaments = [...domPart.querySelectorAll('ornament')].map(el => {
            const result: Ornament = {
                type: 'ornament' as 'ornament',
                date: +(el.getAttribute('date') || 0),
                "name.ref": el.getAttribute('name.ref') || '',
                'note.order': el.getAttribute('name.ref') || '',
                scale: +(el.getAttribute('name.ref') || ''),
                'xml:id': el.getAttribute('xml:id') || `ornament_${v4()}`
            }

            const noteId = el.getAttribute('noteid')
            if (noteId) result.noteid = noteId
            return result
        })

        const tempos = [...domPart.querySelectorAll('tempo')].map(el => {
            const result: Tempo = {
                type: 'tempo' as 'tempo',
                date: +(el.getAttribute('date') || 0),
                bpm: +(el.getAttribute('bpm') || ''),
                beatLength: +(el.getAttribute('beatLength') || ''),
                'xml:id': el.getAttribute('xml:id') || `tempo_${v4()}`
            }

            const meanTempoAt = el.getAttribute('meanTempoAt')
            if (meanTempoAt) {
                result.meanTempoAt = +meanTempoAt
            }

            const transitionTo = el.getAttribute('transition.to')
            if (transitionTo) {
                result["transition.to"] = +transitionTo
            }


            const noteId = el.getAttribute('noteid')
            if (noteId) result.noteid = noteId
            return result
        })

        const articulations = [...domPart.querySelectorAll('articulation')].map(el => {
            const result: Articulation = {
                type: 'articulation' as 'articulation',
                date: +(el.getAttribute('date') || 0),
                relativeDuration: +(el.getAttribute('relativeDuration') || ''),
                'xml:id': el.getAttribute('xml:id') || `articulation_${v4()}`
            }

            const noteId = el.getAttribute('noteid')
            if (noteId) result.noteid = noteId
            return result
        })

        const asynchronies = [...domPart.querySelectorAll('asynchrony')].map(el => {
            const result: Asynchrony = {
                type: 'asynchrony' as 'asynchrony',
                date: +(el.getAttribute('date') || 0),
                'milliseconds.offset': +(el.getAttribute('milliseconds.offset') || ''),
                'xml:id': el.getAttribute('xml:id') || `asynchrony_${v4()}`
            }

            const noteId = el.getAttribute('noteid')
            if (noteId) result.noteid = noteId
            return result
        })

        mpm.insertInstructions(dynamics, part)
        mpm.insertInstructions(ornaments, part)
        mpm.insertInstructions(tempos, part)
        mpm.insertInstructions(asynchronies, part)
        mpm.insertInstructions(articulations, part)
        mpm.insertDefinitions(ornamentDefs, part)
    }

    return mpm
} 
