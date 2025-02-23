import { Accentuation, AccentuationPattern, AccentuationPatternDef, MPM, Scope } from "mpm-ts";
import { MSM } from "../../msm";
import { AbstractTransformer, ScopedTransformationOptions, Transformer } from "../Transformer";
import { v4 } from "uuid";
import { InsertDynamicsInstructions } from "../dynamics";

export type AccentuationCell = {
    start: number
    end: number
    beatLength: number
}

interface InsertMetricalAccentuationOptions extends ScopedTransformationOptions {
    cells: AccentuationCell[]
    loopTolerance: number
}

type Velocity = {
    beat: number
    avgVelocityChange: number
}

export class InsertMetricalAccentuation extends AbstractTransformer<InsertMetricalAccentuationOptions> {
    name = 'InsertMetricalAccentuation'
    requires = [InsertDynamicsInstructions]

    constructor(options?: InsertMetricalAccentuationOptions) {
        super()

        // set the default options
        this.options = options || {
            scope: 'global',
            cells: [],
            loopTolerance: 0
        }
    }

    private extractVelocities({ start, end, beatLength }: AccentuationCell, msm: MSM): Velocity[] {
        const ppq = 720
        const velocities = []
        const frameLength = end - start
        for (let beat = 0; beat <= frameLength / 4 / ppq; beat += beatLength) {
            const date = start + beat * 4 * ppq

            const notesAtDate = msm.notesAtDate(date, this.options.scope)
                .filter(note => note.absoluteVelocityChange !== undefined)
            if (notesAtDate.length === 0) continue

            const avgVelocityChange = notesAtDate
                .reduce((acc, note) => acc + note.absoluteVelocityChange, 0) / notesAtDate.length

            velocities.push({
                beat: msm.timeSignature.denominator * beat + 1,
                avgVelocityChange
            })
        }
        return velocities
    }

    private calculateScale(velocities: Velocity[]) {
        return Math.max(...velocities.map(v => Math.abs(v.avgVelocityChange)))
    }

    private calculateAccentuations(velocities: Velocity[]): Accentuation[] {
        const scale = this.calculateScale(velocities)
        if (scale === 0) return []

        return velocities
            .map((v, i, arr) => {
                const next = arr[i + 1]
                if (next === undefined) return null

                const scaled = v.avgVelocityChange / scale
                return ({
                    type: 'accentuation' as 'accentuation',
                    'xml:id': 'accentuation_' + v4(),
                    beat: v.beat,
                    value: scaled,
                    'transition.from': scaled,
                    'transition.to': next.avgVelocityChange / scale
                })
            })
            .filter(a => a !== null)
    }

    protected transform(msm: MSM, mpm: MPM) {
        this.options.cells.sort((a, b) => a.start - b.start)

        if (!mpm.getDefinitions<AccentuationPatternDef>('accentuationPatternDef', this.options.scope)
            .find(def => def.name === 'neutral')) {
            mpm.insertDefinition({
                type: 'accentuationPatternDef',
                name: 'neutral',
                length: 0.25,
                children: [{
                    type: 'accentuation',
                    beat: 1,
                    value: 0,
                    "transition.from": 0,
                    "transition.to": 0
                }]
            }, this.options.scope)
        }

        this.options.cells.forEach((cell, i) => {
            const nextCell = this.options.cells.at(i + 1)

            const velocities = this.extractVelocities(cell, msm)
            const scale = this.calculateScale(velocities)
            const accentuations = this.calculateAccentuations(velocities)

            if (accentuations.length === 0 || scale === 0) return

            // try to loop until we cannot fit the data into the 
            // pattern anymore or we reach the next cell
            const currentCell = { ...cell }
            while (currentCell.end < (nextCell?.start || msm.end)) {
                const cellLength = currentCell.end - currentCell.start
                currentCell.start += cellLength
                currentCell.end += cellLength

                const currentVelocities = this.extractVelocities(currentCell, msm)
                const currentScale = this.calculateScale(currentVelocities)
                if (currentScale === 0) break

                const currentAccentuations = this.calculateAccentuations(currentVelocities)

                const hasSameBeatStructure = currentAccentuations.every(((a) => {
                    // not finding any corresponding accentuation
                    // does not contradict to continue looping
                    const corresp = accentuations.find(other => other.beat === a.beat)
                    if (!corresp) return true

                    return Math.round(a.value) === Math.round(corresp.value)
                }))

                console.log(accentuations, 'vs', currentAccentuations)

                const scaleWithinRange = Math.abs(currentScale - scale) <= this.options.loopTolerance

                if (!hasSameBeatStructure || !scaleWithinRange) {
                    break;
                }
            }

            const accentuationPatternDef: AccentuationPatternDef = {
                type: 'accentuationPatternDef',
                name: v4(),
                length: ((cell.end - cell.start) / 4 / 720) * msm.timeSignature.denominator,
                children: accentuations,
            }

            mpm.insertDefinition(accentuationPatternDef, this.options.scope)

            const loop = currentCell.start > cell.end
            mpm.insertInstruction({
                type: 'accentuationPattern',
                'name.ref': accentuationPatternDef.name,
                "xml:id": v4(),
                date: cell.start,
                scale,
                loop,
            }, this.options.scope)

            if (loop) {
                mpm.insertInstruction({
                    type: 'accentuationPattern',
                    'name.ref': 'neutral',
                    date: currentCell.start,
                    "xml:id": v4(),
                    scale: 0,
                    loop: false
                }, this.options.scope)
            }
        })

        if (mpm.getStyles('accentuationPattern', this.options.scope).length === 0) {
            mpm.insertStyle({
                "name.ref": 'performance_style',
                date: 0,
                'type': 'style',
                'xml:id': v4(),
            }, 'accentuationPattern', this.options.scope)
        }

        this.removeAccentuationDistortion(msm, mpm, this.options.scope)
    }

    removeAccentuationDistortion(msm: MSM, mpm: MPM, scope: Scope) {
        const ppq = 720

        const allAccentuations = mpm
            .getInstructions<AccentuationPattern>('accentuationPattern', scope)
            .slice()
            .reverse()

        for (const [date, chord] of msm.asChords(scope)) {
            const pattern = allAccentuations.find(pattern => pattern.date <= date)
            if (!pattern) continue

            const def = mpm.getDefinition('accentuationPatternDef', pattern["name.ref"]) as AccentuationPatternDef | null
            if (!def) {
                continue
            }

            const tickLength = (def.length * 4 * ppq) / msm.timeSignature.denominator

            if (date > pattern.date + tickLength && !pattern.loop) {
                continue
            }

            const timeSignatureDate = 0;
            const beat = 1 + ((date - timeSignatureDate) % tickLength) / ppq;

            const accentuation = def.children.find(a => a.beat === beat)
            if (!accentuation) {
                continue
            }

            const accentuationValue = this.accentuationAt(beat, def)
            const velocityChange = accentuationValue * pattern.scale

            chord
                .filter(note => note.absoluteVelocityChange !== undefined)
                .forEach(note => {
                    note.absoluteVelocityChange -= velocityChange
                })
        }
    }

    private accentuationAt(beat: number, def: AccentuationPatternDef): number {
        if (def.children.length === 0) {
            return 0
        }

        def.children.sort((a, b) => a.beat - b.beat)

        if (beat < def.children[0].beat) {
            return 0
        }
        if (beat >= def.length + 1) {
            const last = def.children[def.children.length - 1]
            const result = last["transition.to"] || last.value;
            return result;
        }

        let selectedAccent: Accentuation | undefined;
        let segmentEnd: number = def.length + 1;

        // Traverse the accentuations in reverse order
        for (let i = def.children.length - 1; i >= 0; --i) {
            const accent = def.children[i];
            if (beat === accent.beat) {
                return accent.value;
            }

            if (beat > accent.beat) {
                selectedAccent = accent;
                if (i < def.children.length - 1) {
                    // There is a subsequent accentuation; set its beat as the segment end
                    segmentEnd = def.children[i + 1].beat;
                }
                break;
            }
        }

        const result = (((beat - selectedAccent!.beat) *
            ((selectedAccent!["transition.to"] - selectedAccent!["transition.from"]))) /
            (segmentEnd - selectedAccent!.beat)) + selectedAccent!["transition.from"];
        return result;
    }
}
