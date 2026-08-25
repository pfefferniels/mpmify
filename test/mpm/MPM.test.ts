// @vitest-environment jsdom

import { describe, expect, test } from "vitest"
import {
    AccentuationPatternDef,
    ArticulationDef,
    clearOrnamentDraft,
    definitionOf,
    FrameDomain,
    InstructionOptions,
    MPM,
    NoteOffShift,
    ornamentDraftOf,
    OrnamentDef,
    parseMPM,
    setOrnamentDraft,
} from "../../src/mpm"

const tempo = (date: number, bpm: number, id = `tempo_${date}`): InstructionOptions<'tempo'> => ({
    id, date, bpm, beatLength: 0.25,
})

describe("instructions", () => {
    test("go into the map their type names, sorted by date", () => {
        const mpm = new MPM()
        mpm.insertInstruction('tempo', tempo(1440, 90), 'global')
        mpm.insertInstruction('tempo', tempo(0, 60), 'global')

        expect(mpm.getInstructions('tempo', 'global').map(t => t.date)).toEqual([0, 1440])
        expect(mpm.toXML()).toContain('<tempoMap>')
    })

    test("are snapshots: reading twice does not hand back the same object", () => {
        const mpm = new MPM()
        const inserted = mpm.insertInstruction('tempo', tempo(0, 60), 'global')

        // The old layer proxied every property onto the element and cached one view per
        // element, so this was `toBe`. Nothing relies on that any more, and a value that looks
        // like data and silently is not was the reason to stop.
        expect(mpm.getInstructions('tempo', 'global')[0]).not.toBe(inserted)
        expect(mpm.getInstructions('tempo', 'global')[0]).toEqual(inserted)
    })

    test("are changed through updateInstruction, which reaches the XML", () => {
        const mpm = new MPM()
        const inserted = mpm.insertInstruction('tempo', tempo(0, 60), 'global')

        const updated = mpm.updateInstruction(inserted, { bpm: 72, transitionTo: 90 })

        expect(mpm.toXML()).toContain('bpm="72"')
        expect(mpm.toXML()).toContain('transition.to="90"')
        expect(updated.bpm).toBe(72)
        expect(mpm.getInstructions('tempo', 'global')[0].bpm).toBe(72)
    })

    test("patching a field to undefined removes its attribute", () => {
        const mpm = new MPM()
        const inserted = mpm.insertInstruction(
            'tempo',
            { ...tempo(0, 60), meanTempoAt: 0.5, transitionTo: 90 },
            'global'
        )

        mpm.updateInstruction(inserted, { meanTempoAt: undefined, transitionTo: undefined })

        expect(mpm.toXML()).not.toContain('meanTempoAt')
        expect(mpm.toXML()).not.toContain('transition.to')
    })

    test("a field the patch omits is left alone", () => {
        const mpm = new MPM()
        const inserted = mpm.insertInstruction(
            'tempo',
            { ...tempo(0, 60), meanTempoAt: 0.5 },
            'global'
        )

        const updated = mpm.updateInstruction(inserted, { bpm: 72 })

        expect(updated.meanTempoAt).toBe(0.5)
    })

    test("carry the element they stand for, and their scope", () => {
        const mpm = new MPM()
        const inserted = mpm.insertInstruction('tempo', tempo(0, 60), 'global')

        expect(inserted.element.getLocalName()).toBe('tempo')
        expect(inserted.scope).toBe('global')
        expect(inserted.type).toBe('tempo')
    })

    test("keep a working field the format has no attribute for out of the document", () => {
        const mpm = new MPM()
        // `endDate` is `InsertDynamicsInstructions`'s fitting window, not an MPM attribute.
        // The old layer kept it out with a schema table; now it cannot get in at all, because
        // `AddDynamicsOptions` has no such field and espressivo writes nothing else.
        const fitted = { date: 0, volume: 60, endDate: 720 }
        const { endDate: _window, ...options } = fitted
        mpm.insertInstruction('dynamics', options, 'global')

        expect(mpm.toXML()).not.toContain('endDate')
    })

    test("removing takes the element out of the map", () => {
        const mpm = new MPM()
        const first = mpm.insertInstruction('tempo', tempo(0, 60), 'global')
        mpm.insertInstruction('tempo', tempo(720, 90), 'global')

        mpm.removeInstruction(first)

        expect(mpm.getInstructions('tempo', 'global').map(t => t.date)).toEqual([720])
        expect(mpm.toXML()).not.toContain('bpm="60"')
    })
})

describe("merging at a date", () => {
    // The mechanism InsertDynamicsGradient and InsertTemporalSpread describe one <ornament>
    // between them: the second insert lands in the first's element rather than beside it.
    const ornament = (
        over: Partial<InstructionOptions<'ornament'>> = {}
    ): InstructionOptions<'ornament'> => ({
        id: 'ornament_0', date: 0, nameRef: 'neutralArpeggio', ...over,
    })

    test("a second instruction at the same date and noteid fills the first in", () => {
        const mpm = new MPM()
        mpm.insertInstruction('ornament', ornament({ scale: 5 }), 'global')
        mpm.insertInstruction('ornament', ornament({ noteOrder: '#a #b' }), 'global')

        const ornaments = mpm.getInstructions('ornament', 'global')
        expect(ornaments).toHaveLength(1)
        expect(ornaments[0].scale).toBe(5)
        expect(ornaments[0].noteOrder).toBe('#a #b')
    })

    test("the draft half of an ornament merges onto the same element", () => {
        const mpm = new MPM()
        const gradient = mpm.insertInstruction('ornament', ornament(), 'global')
        setOrnamentDraft(gradient.element, { transitionFrom: -1, transitionTo: 0 })

        const spread = mpm.insertInstruction('ornament', ornament(), 'global')
        setOrnamentDraft(spread.element, { frameStart: -100, frameLength: 200 })

        expect(mpm.getInstructions('ornament', 'global')).toHaveLength(1)
        expect(ornamentDraftOf(spread.element)).toEqual({
            transitionFrom: -1, transitionTo: 0, frameStart: -100, frameLength: 200,
        })
    })

    test("without overwrite, a value already there wins", () => {
        const mpm = new MPM()
        mpm.insertInstruction('tempo', tempo(0, 60), 'global')
        mpm.insertInstruction('tempo', tempo(0, 90), 'global')

        expect(mpm.getInstructions('tempo', 'global')[0].bpm).toBe(60)
    })

    test("with overwrite, the incoming value wins", () => {
        const mpm = new MPM()
        mpm.insertInstruction('tempo', tempo(0, 60), 'global')
        mpm.insertInstruction('tempo', tempo(0, 90), 'global', true)

        const tempos = mpm.getInstructions('tempo', 'global')
        expect(tempos).toHaveLength(1)
        expect(tempos[0].bpm).toBe(90)
    })

    test("different noteids at one date stay separate instructions", () => {
        const mpm = new MPM()
        mpm.insertInstruction('articulation', { id: 'a', date: 0, nameRef: 'legato', noteid: '#a' }, 'global')
        mpm.insertInstruction('articulation', { id: 'b', date: 0, nameRef: 'legato', noteid: '#b' }, 'global')

        expect(mpm.getInstructions('articulation', 'global')).toHaveLength(2)
    })

    test("a date the map does not hold does not merge into the next instruction", () => {
        const mpm = new MPM()
        mpm.insertInstruction('tempo', tempo(720, 90), 'global')
        mpm.insertInstruction('tempo', tempo(0, 60), 'global')

        expect(mpm.getInstructions('tempo', 'global').map(t => t.bpm)).toEqual([60, 90])
    })

    test("a <style> switch sharing the date is not merged into", () => {
        const mpm = new MPM()
        mpm.insertStyle(
            { 'xml:id': 'style_0', date: 0, 'name.ref': 'performance_style' },
            'tempo',
            'global'
        )
        mpm.insertInstruction('tempo', tempo(0, 60), 'global')

        expect(mpm.getInstructions('tempo', 'global')).toHaveLength(1)
        expect(mpm.getStyles('tempo', 'global')).toHaveLength(1)
    })
})

describe("style switches", () => {
    test("go before the instructions sharing their date, so the style is in force", () => {
        const mpm = new MPM()
        mpm.insertInstruction('tempo', tempo(0, 60), 'global')
        mpm.insertInstruction('tempo', tempo(720, 90), 'global')
        mpm.insertStyle(
            { 'xml:id': 'style_0', date: 0, 'name.ref': 'performance_style' },
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
                'xml:id': 'style_0', date: 0,
                'name.ref': 'performance_style', defaultArticulation: 'legato',
            },
            'articulation',
            'global'
        )

        expect(mpm.getStyles('articulation', 'global')[0].defaultArticulation).toBe('legato')
    })

    test("ensureDefaultStyle writes one switch however often it is asked", () => {
        const mpm = new MPM()
        mpm.ensureDefaultStyle('articulation', 'global')
        mpm.ensureDefaultStyle('articulation', 'global', { defaultArticulation: 'legato' })

        const styles = mpm.getStyles('articulation', 'global')
        expect(styles).toHaveLength(1)
        expect(styles[0].defaultArticulation).toBe('legato')
    })
})

describe("definitions", () => {
    test("go into the styleDef of their collection and read back as espressivo defs", () => {
        const mpm = new MPM()
        const def = definitionOf(ArticulationDef.createArticulationDef('legato'))
        def.setRelativeDuration(1.05)
        mpm.insertDefinition('articulationDef', def, 'global')

        const defs = mpm.getDefinitions('articulationDef', 'global')
        expect(defs).toHaveLength(1)
        expect(defs[0].getRelativeDuration()).toBe(1.05)
        expect(mpm.toXML()).toContain('<articulationStyles>')
    })

    test("carry their child elements", () => {
        const mpm = new MPM()
        const def = definitionOf(AccentuationPatternDef.fromNameLength('downbeat', 1))
        def.addAccentuation(1, 1, 1, 0)
        def.addAccentuation(3, 0.5, 0.5, 0)
        mpm.insertDefinition('accentuationPatternDef', def, 'global')

        const found = mpm.getDefinition('accentuationPatternDef', 'downbeat')!
        expect(found.getAllAccentuations().map(a => a.key[0])).toEqual([1, 3])
    })

    test("are the very object that was inserted, so a later setter edits the document", () => {
        const mpm = new MPM()
        const def = definitionOf(OrnamentDef.createOrnamentDef('roll'))
        mpm.insertDefinition('ornamentDef', def, 'global')

        def.setTemporalSpreadValues(-100, 200, FrameDomain.Milliseconds, 1, NoteOffShift.Monophonic)

        const found = mpm.getDefinition('ornamentDef', 'roll')!
        expect(found.getTemporalSpread()?.noteOffShift).toBe(NoteOffShift.Monophonic)
        expect(found.getTemporalSpread()?.getFrameLength()).toBe(200)
        expect(found.getDynamicsGradient()).toBeNull()
        expect(mpm.toXML()).toContain('noteoff.shift="monophonic"')
    })

    test("can be removed after being renamed", () => {
        const mpm = new MPM()
        const def = definitionOf(ArticulationDef.createArticulationDef('a'))
        mpm.insertDefinition('articulationDef', def, 'global')

        // Found by element identity, not by name: renaming leaves espressivo's by-name index
        // keyed on the old one.
        def.setName('renamed')
        mpm.removeDefinition('articulationDef', def)

        expect(mpm.getDefinitions('articulationDef', 'global')).toHaveLength(0)
        expect(mpm.toXML()).not.toContain('articulationDef')
    })
})

describe("scopes", () => {
    test("a part is created on demand and numbered as MSM expects", () => {
        const mpm = new MPM()
        mpm.insertInstruction('tempo', tempo(0, 60), 1)

        expect(mpm.scopes()).toEqual(['global', 1])
        expect(mpm.toXML()).toContain('number="2"')
        expect(mpm.toXML()).toContain('midi.channel="1"')
    })

    test("reading without a scope reaches every part", () => {
        const mpm = new MPM()
        mpm.insertInstruction('tempo', tempo(0, 60), 'global')
        mpm.insertInstruction('tempo', tempo(720, 90), 0)

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
        expect(patterns[1].accentuationPatternDefName).toBe('downbeat')
    })

    test("reads the definitions the patterns refer to", () => {
        const mpm = parseMPM(source)

        const def = mpm.getDefinition('accentuationPatternDef', 'downbeat')!
        expect(def.getLength()).toBe(1)
        expect(def.size()).toBe(1)
        expect(def.getAccentuationAttributes(0)?.[2]).toBe(1)
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

describe("the ornament draft", () => {
    test("is not part of the instruction, and survives a patch of one", () => {
        const mpm = new MPM()
        const ornament = mpm.insertInstruction(
            'ornament', { id: 'o1', date: 0, nameRef: 'roll' }, 'global'
        )
        setOrnamentDraft(ornament.element, {
            frameStart: -100, frameLength: 200, frameDomain: FrameDomain.Milliseconds,
        })

        mpm.updateInstruction(ornament, { scale: 0.5 })

        expect(ornamentDraftOf(ornament.element).frameStart).toBe(-100)
        expect(mpm.getInstructions('ornament', 'global')[0]).not.toHaveProperty('frameStart')
    })

    test("comes off entirely when a real definition holds it", () => {
        const mpm = new MPM()
        const ornament = mpm.insertInstruction(
            'ornament', { id: 'o1', date: 0, nameRef: 'roll' }, 'global'
        )
        setOrnamentDraft(ornament.element, {
            transitionFrom: 0, transitionTo: 1, frameStart: -100, frameLength: 200,
            frameDomain: FrameDomain.Ticks, noteOffShift: NoteOffShift.True, intensity: 0.5,
        })

        clearOrnamentDraft(ornament.element)

        expect(ornamentDraftOf(ornament.element)).toEqual({})
        expect(mpm.toXML()).toContain('<ornament')
        for (const gone of ['transition.from', 'frame.start', 'time.unit', 'noteoff.shift']) {
            expect(mpm.toXML()).not.toContain(gone)
        }
    })
})

describe("metadata", () => {
    test("is written before the performance", () => {
        const mpm = new MPM()
        mpm.setMetadata({
            authors: [{ number: 0, text: 'Niels Pfeffer' }],
            comments: [{ text: 'a reconstruction' }],
        })

        const xml = mpm.toXML()
        expect(xml).toContain('<author number="0">Niels Pfeffer</author>')
        expect(xml).toContain('<comment>a reconstruction</comment>')
        expect(xml.indexOf('<metadata>')).toBeLessThan(xml.indexOf('<performance'))
    })

    test("replaces what was there rather than appending to it", () => {
        const mpm = new MPM()
        mpm.setMetadata({ comments: [{ text: 'first' }] })
        mpm.setMetadata({ comments: [{ text: 'second' }] })

        const xml = mpm.toXML()
        expect(xml).not.toContain('first')
        expect(xml.match(/<metadata>/g)).toHaveLength(1)
    })

    test("writes a related resource as <resource>, not as its media type", () => {
        const mpm = new MPM()
        mpm.setMetadata({ relatedResources: [{ uri: 'roll.mei', type: 'mei' }] })

        expect(mpm.toXML()).toContain('<relatedResources><resource uri="roll.mei" type="mei" /></relatedResources>')
    })

    test("writes <appInfo>, which is mpmify's own and not in the MPM schema", () => {
        const mpm = new MPM()
        mpm.setMetadata({
            appInfo: {
                name: 'mpmify', version: '1.0.0', url: 'https://example.org',
                transformations: [
                    { 'xml:id': 't1', name: 'ApproximateLogarithmicTempo', cdata: '{}', notes: ['a note'] },
                ],
            },
        })

        const xml = mpm.toXML()
        expect(xml).toContain('<appInfo name="mpmify" version="1.0.0"')
        expect(xml).toContain('<transformation name="ApproximateLogarithmicTempo"')
        expect(xml).toContain('<note>a note</note>')
    })
})
