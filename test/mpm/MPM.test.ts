// @vitest-environment jsdom

import { describe, expect, test } from "vitest"
import {
    AccentuationPatternDef,
    ArticulationDef,
    MPM,
    Ornament,
    OrnamentDef,
    parseMPM,
    Tempo,
} from "../../src/mpm"

const tempo = (date: number, bpm: number, id = `tempo_${date}`): Tempo => ({
    type: 'tempo', 'xml:id': id, date, bpm, beatLength: 0.25,
})

describe("instructions", () => {
    test("go into the map their type names, sorted by date", () => {
        const mpm = new MPM()
        mpm.insertInstruction(tempo(1440, 90), 'global')
        mpm.insertInstruction(tempo(0, 60), 'global')

        expect(mpm.getInstructions('tempo', 'global').map(t => t.date)).toEqual([0, 1440])
        expect(mpm.toXML()).toContain('<tempoMap>')
    })

    test("are views on the document: a write reaches the XML", () => {
        const mpm = new MPM()
        const inserted = mpm.insertInstruction(tempo(0, 60), 'global')

        inserted.bpm = 72
        inserted['transition.to'] = 90

        expect(mpm.toXML()).toContain('bpm="72"')
        expect(mpm.toXML()).toContain('transition.to="90"')
        expect(mpm.getInstructions('tempo', 'global')[0].bpm).toBe(72)
    })

    test("assigning undefined removes the attribute, as deleting does", () => {
        const mpm = new MPM()
        // Annotated, because `insertInstruction` gives back the literal type it was handed:
        // inferred from this object, `meanTempoAt` and `transition.to` are *required* `number`s,
        // and the point of the test is that they are the optional ones `Tempo` declares.
        const inserted: Tempo = mpm.insertInstruction(
            { ...tempo(0, 60), meanTempoAt: 0.5, 'transition.to': 90 },
            'global'
        )

        inserted.meanTempoAt = undefined
        delete inserted['transition.to']

        expect(mpm.toXML()).not.toContain('meanTempoAt')
        expect(mpm.toXML()).not.toContain('transition.to')
    })

    test("give the same object for the same element, so identity holds across reads", () => {
        const mpm = new MPM()
        const inserted = mpm.insertInstruction(tempo(0, 60), 'global')

        expect(mpm.getInstructions('tempo', 'global')[0]).toBe(inserted)
    })

    test("spread into a plain record carrying every present attribute", () => {
        const mpm = new MPM()
        const inserted = mpm.insertInstruction(tempo(0, 60), 'global')

        expect({ ...inserted }).toEqual({
            type: 'tempo', date: 0, bpm: 60, beatLength: 0.25, 'xml:id': 'tempo_0',
        })
    })

    test("keep working fields the MPM schema does not know out of the document", () => {
        const mpm = new MPM()
        mpm.insertInstruction(
            { ...tempo(0, 60), endDate: 720 } as Tempo & { endDate: number },
            'global'
        )

        expect(mpm.toXML()).not.toContain('endDate')
    })

    test("removing takes the element out of the map", () => {
        const mpm = new MPM()
        const first = mpm.insertInstruction(tempo(0, 60), 'global')
        mpm.insertInstruction(tempo(720, 90), 'global')

        mpm.removeInstruction(first)

        expect(mpm.getInstructions('tempo', 'global').map(t => t.date)).toEqual([720])
        expect(mpm.toXML()).not.toContain('bpm="60"')
    })
})

describe("merging at a date", () => {
    // The mechanism InsertDynamicsGradient and InsertTemporalSpread describe one <ornament>
    // between them: the second insert lands in the first's element rather than beside it.
    const ornament = (over: Partial<Ornament>): Ornament => ({
        type: 'ornament', 'xml:id': 'ornament_0', date: 0, 'name.ref': 'neutralArpeggio', ...over,
    })

    test("a second instruction at the same date and noteid fills the first in", () => {
        const mpm = new MPM()
        mpm.insertInstruction(ornament({ 'transition.from': -1, 'transition.to': 0, scale: 5 }), 'global')
        mpm.insertInstruction(ornament({ 'frame.start': -100, frameLength: 200 }), 'global')

        const ornaments = mpm.getInstructions('ornament', 'global')
        expect(ornaments).toHaveLength(1)
        expect(ornaments[0].scale).toBe(5)
        expect(ornaments[0]['frame.start']).toBe(-100)
    })

    test("without overwrite, a value already there wins", () => {
        const mpm = new MPM()
        mpm.insertInstruction(tempo(0, 60), 'global')
        mpm.insertInstruction(tempo(0, 90), 'global')

        expect(mpm.getInstructions('tempo', 'global')[0].bpm).toBe(60)
    })

    test("with overwrite, the incoming value wins", () => {
        const mpm = new MPM()
        mpm.insertInstruction(tempo(0, 60), 'global')
        mpm.insertInstruction(tempo(0, 90), 'global', true)

        const tempos = mpm.getInstructions('tempo', 'global')
        expect(tempos).toHaveLength(1)
        expect(tempos[0].bpm).toBe(90)
    })

    test("different noteids at one date stay separate instructions", () => {
        const mpm = new MPM()
        mpm.insertInstruction({ ...tempo(0, 60), noteid: '#a' }, 'global')
        mpm.insertInstruction({ ...tempo(0, 90, 'tempo_0_1'), noteid: '#b' }, 'global')

        expect(mpm.getInstructions('tempo', 'global')).toHaveLength(2)
    })

    test("a date the map does not hold does not merge into the next instruction", () => {
        const mpm = new MPM()
        mpm.insertInstruction(tempo(720, 90), 'global')
        mpm.insertInstruction(tempo(0, 60), 'global')

        expect(mpm.getInstructions('tempo', 'global').map(t => t.bpm)).toEqual([60, 90])
    })

    test("a <style> switch sharing the date is not merged into", () => {
        const mpm = new MPM()
        mpm.insertStyle(
            { type: 'style', 'xml:id': 'style_0', date: 0, 'name.ref': 'performance_style' },
            'tempo',
            'global'
        )
        mpm.insertInstruction(tempo(0, 60), 'global')

        expect(mpm.getInstructions('tempo', 'global')).toHaveLength(1)
        expect(mpm.getStyles('tempo', 'global')).toHaveLength(1)
    })
})

describe("style switches", () => {
    test("go before the instructions sharing their date, so the style is in force", () => {
        const mpm = new MPM()
        mpm.insertInstruction(tempo(0, 60), 'global')
        mpm.insertInstruction(tempo(720, 90), 'global')
        mpm.insertStyle(
            { type: 'style', 'xml:id': 'style_0', date: 0, 'name.ref': 'performance_style' },
            'tempo',
            'global'
        )

        const map = mpm.toXML().match(/<tempoMap>(.*?)<\/tempoMap>/s)![1]
        expect(map.indexOf('<style')).toBeLessThan(map.indexOf('<tempo '))
    })

    test("carry defaultArticulation when given one", () => {
        const mpm = new MPM()
        mpm.insertStyle(
            {
                type: 'style', 'xml:id': 'style_0', date: 0,
                'name.ref': 'performance_style', defaultArticulation: 'legato',
            },
            'articulation',
            'global'
        )

        expect(mpm.getStyles('articulation', 'global')[0].defaultArticulation).toBe('legato')
    })
})

describe("definitions", () => {
    test("go into the styleDef of their collection and read back as views", () => {
        const mpm = new MPM()
        mpm.insertDefinition(
            { type: 'articulationDef', name: 'legato', relativeDuration: 1.05 } as ArticulationDef,
            'global'
        )

        const defs = mpm.getDefinitions<ArticulationDef>('articulationDef', 'global')
        expect(defs).toHaveLength(1)
        expect(defs[0].relativeDuration).toBe(1.05)
        expect(mpm.toXML()).toContain('<articulationStyles>')
    })

    test("carry their child elements", () => {
        const mpm = new MPM()
        mpm.insertDefinition({
            type: 'accentuationPatternDef',
            name: 'downbeat',
            length: 1,
            children: [
                { type: 'accentuation', beat: 1, value: 1, 'transition.from': 1, 'transition.to': 0 },
                { type: 'accentuation', beat: 3, value: 0.5, 'transition.from': 0.5, 'transition.to': 0 },
            ],
        } as AccentuationPatternDef, 'global')

        const def = mpm.getDefinition('accentuationPatternDef', 'downbeat') as AccentuationPatternDef
        expect(def.children.map(a => a.beat)).toEqual([1, 3])

        def.children[0].value = 0.75
        expect(mpm.toXML()).toContain('value="0.75"')
    })

    test("nest single children, as an ornamentDef's temporalSpread does", () => {
        const mpm = new MPM()
        mpm.insertDefinition({
            type: 'ornamentDef',
            name: 'roll',
            temporalSpread: {
                type: 'temporalSpread',
                'frame.start': -100,
                frameLength: 200,
                'time.unit': 'milliseconds',
                'noteoff.shift': 'monophonic',
            },
        } as OrnamentDef, 'global')

        const def = mpm.getDefinition('ornamentDef', 'roll') as OrnamentDef
        expect(def.temporalSpread!['noteoff.shift']).toBe('monophonic')
        expect(def.temporalSpread!.frameLength).toBe(200)
        expect(def.dynamicsGradient).toBeUndefined()
    })

    test("can be removed after being renamed through their view", () => {
        const mpm = new MPM()
        mpm.insertDefinition({ type: 'articulationDef', name: 'a' } as ArticulationDef, 'global')
        const def = mpm.getDefinitions<ArticulationDef>('articulationDef', 'global')[0]

        def.name = 'renamed'
        mpm.removeDefinition(def)

        expect(mpm.getDefinitions('articulationDef', 'global')).toHaveLength(0)
        expect(mpm.toXML()).not.toContain('articulationDef')
    })
})

describe("scopes", () => {
    test("a part is created on demand and numbered as MSM expects", () => {
        const mpm = new MPM()
        mpm.insertInstruction(tempo(0, 60), 1)

        expect(mpm.scopes()).toEqual(['global', 1])
        expect(mpm.toXML()).toContain('number="2"')
        expect(mpm.toXML()).toContain('midi.channel="1"')
    })

    test("reading without a scope reaches every part", () => {
        const mpm = new MPM()
        mpm.insertInstruction(tempo(0, 60), 'global')
        mpm.insertInstruction(tempo(720, 90), 0)

        expect(mpm.getInstructions('tempo').map(t => t.date)).toEqual([0, 720])
    })
})

describe("round trip", () => {
    const source = `<?xml version="1.0"?>
<mpm xmlns="http://www.cemfi.de/mpm/ns/1.0">
  <performance name="test" pulsesPerQuarter="720">
    <global>
      <header>
        <metricalAccentuationStyles>
          <styleDef name="performance_style">
            <accentuationPatternDef name="downbeat" length="1">
              <accentuation beat="1" value="1" transition.from="1" transition.to="0"/>
            </accentuationPatternDef>
          </styleDef>
        </metricalAccentuationStyles>
      </header>
      <dated>
        <metricalAccentuationMap>
          <style date="0" name.ref="performance_style"/>
          <accentuationPattern date="0" name.ref="downbeat" scale="3" loop="true"/>
          <accentuationPattern date="2880" name.ref="downbeat" scale="1.5"/>
        </metricalAccentuationMap>
        <dynamicsMap>
          <dynamics date="0" volume="60" transition.to="90" curvature="0.5"/>
        </dynamicsMap>
        <rubatoMap>
          <rubato date="0" frameLength="720" intensity="1.4" loop="true"/>
        </rubatoMap>
      </dated>
    </global>
  </performance>
</mpm>`

    test("reads <accentuationPattern>, which mpm-ts's reader dropped", () => {
        const mpm = parseMPM(source)

        const patterns = mpm.getInstructions('accentuationPattern', 'global')
        expect(patterns).toHaveLength(2)
        expect(patterns[0].scale).toBe(3)
        expect(patterns[0].loop).toBe(true)
        expect(patterns[1].loop).toBeUndefined()
        expect(patterns[1]['name.ref']).toBe('downbeat')
    })

    test("reads the definitions the patterns refer to", () => {
        const mpm = parseMPM(source)

        const def = mpm.getDefinition('accentuationPatternDef', 'downbeat') as AccentuationPatternDef
        expect(def.length).toBe(1)
        expect(def.children).toHaveLength(1)
        expect(def.children[0]['transition.from']).toBe(1)
    })

    test("reads the other maps and their numbers", () => {
        const mpm = parseMPM(source)

        expect(mpm.getInstructions('dynamics', 'global')[0].volume).toBe(60)
        expect(mpm.getInstructions('rubato', 'global')[0].intensity).toBe(1.4)
        expect(mpm.getStyles('accentuationPattern', 'global')).toHaveLength(1)
    })

    test("a symbolic level stays the name it was written as", () => {
        const mpm = parseMPM(source.replace('volume="60"', 'volume="forte"'))

        expect(mpm.getInstructions('dynamics', 'global')[0].volume).toBe('forte')
    })

    test("what was read can be written back", () => {
        const mpm = parseMPM(source)

        const again = parseMPM(mpm.toXML())
        expect(again.getInstructions('accentuationPattern', 'global')).toHaveLength(2)
        expect(again.toXML()).toContain('xmlns="http://www.cemfi.de/mpm/ns/1.0"')
    })
})

describe("metadata", () => {
    test("is written before the performance", () => {
        const mpm = new MPM()
        mpm.setMetadata([
            { type: 'author', number: 0, text: 'Niels Pfeffer' },
            { type: 'comment', text: 'a reconstruction' },
        ])

        const xml = mpm.toXML()
        expect(xml).toContain('<author number="0">Niels Pfeffer</author>')
        expect(xml).toContain('<comment>a reconstruction</comment>')
        expect(xml.indexOf('<metadata>')).toBeLessThan(xml.indexOf('<performance'))
    })

    test("replaces what was there rather than appending to it", () => {
        const mpm = new MPM()
        mpm.setMetadata([{ type: 'comment', text: 'first' }])
        mpm.setMetadata([{ type: 'comment', text: 'second' }])

        const xml = mpm.toXML()
        expect(xml).not.toContain('first')
        expect(xml.match(/<metadata>/g)).toHaveLength(1)
    })

    test("writes a related resource as <resource>, not as its media type", () => {
        const mpm = new MPM()
        mpm.setMetadata([{ uri: 'roll.mei', type: 'mei' }])

        expect(mpm.toXML()).toContain('<relatedResources><resource uri="roll.mei" type="mei" /></relatedResources>')
    })
})
