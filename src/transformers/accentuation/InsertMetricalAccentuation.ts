import { Accentuation, AccentuationPattern, AccentuationPatternDef, DEFAULT_STYLE_NAME, MPM } from "../../mpm";
import { MSM } from "../../msm";
import { deriveResidual, Residual } from "../../residual";
import { AbstractTransformer, generateId, ScopedTransformationOptions } from "../Transformer";
import { v4 } from "uuid";
import { InsertDynamicsInstructions } from "../dynamics";

export interface InsertMetricalAccentuationOptions extends ScopedTransformationOptions {
    name: string
    from: number
    to: number
    beatLength: number
    neutralEnd?: boolean
    scaleTolerance: number
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
            name: 'my-accentuation',
            from: 0,
            to: 0,
            beatLength: 0.25,
            neutralEnd: false,
            scaleTolerance: 0,
        }
    }

    private extractVelocities(
        { from: start, to: end, beatLength }: InsertMetricalAccentuationOptions,
        msm: MSM,
        residual: Residual
    ): Velocity[] {
        const ppq = 720
        const velocities = []
        const frameLength = end - start
        for (let beat = 0; beat <= frameLength / 4 / ppq; beat += beatLength) {
            const date = start + beat * 4 * ppq

            const notesAtDate = msm.notesAtDate(date, this.options.scope)
                .filter(note => residual.of(note)?.velocity !== undefined)
            if (notesAtDate.length === 0) continue

            const avgVelocityChange = notesAtDate
                .reduce((acc, note) => acc + residual.of(note)!.velocity!, 0) / notesAtDate.length

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

    private calculateAccentuations(velocities: Velocity[], neutralEnd?: boolean): Accentuation[] {
        const scale = this.calculateScale(velocities)
        if (scale === 0) return []

        return velocities
            .map((v, i, arr) => {
                const next = arr[i + 1]
                if (next === undefined) return null

                const transitionTo = ((i === arr.length - 2) && neutralEnd)
                    ? 0
                    : next.avgVelocityChange / scale

                const scaled = v.avgVelocityChange / scale
                return ({
                    type: 'accentuation' as const,
                    'xml:id': 'accentuation_' + v4(),
                    beat: v.beat,
                    value: scaled,
                    'transition.from': scaled,
                    'transition.to': transitionTo
                })
            })
            .filter(a => a !== null)
    }

    protected transform(msm: MSM, mpm: MPM) {
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

        const cell = {
            start: this.options.from,
            end: this.options.to,
            name: this.options.name,
            neutralEnd: this.options.neutralEnd
        }

        const nextCell = mpm.getInstructions<AccentuationPattern>('accentuationPattern', this.options.scope)
            .find(c => c.date > this.options.from);

        // What the dynamics curve leaves unexplained, per note — the quantity this used to read
        // off `absoluteVelocityChange`. Accentuation is held out because it is what this fits.
        const residual = deriveResidual(msm, mpm, { without: ['accentuationPattern'] })

        const velocities = this.extractVelocities(this.options, msm, residual)
        let scale = this.calculateScale(velocities)
        const accentuations = this.calculateAccentuations(velocities, this.options.neutralEnd)

        if (accentuations.length === 0 || scale === 0) return

        // try to loop until we cannot fit the data into the 
        // pattern anymore or we reach the next cell
        const currentCell = { ...cell }
        let iterations = 0;
        while (currentCell.end < (nextCell?.date || msm.end)) {
            const cellLength = currentCell.end - currentCell.start
            currentCell.start += cellLength
            currentCell.end += cellLength

            const currentVelocities = this.extractVelocities({
                ...this.options,
                from: currentCell.start,
                to: currentCell.end, 
                beatLength: this.options.beatLength
            }, msm, residual)
            const currentScale = this.calculateScale(currentVelocities)
            if (currentScale === 0) break

            const currentAccentuations = this.calculateAccentuations(currentVelocities, this.options.neutralEnd)

            const hasSameBeatStructure = currentAccentuations.every(((a) => {
                // not finding any corresponding accentuation
                // does not contradict to continue looping
                const corresp = accentuations.find(other => other.beat === a.beat)
                if (!corresp) return true

                return Math.round(a.value) === Math.round(corresp.value)
            }))

            const scaleWithinRange = Math.abs(currentScale - scale) <= this.options.scaleTolerance

            if (!hasSameBeatStructure || !scaleWithinRange) {
                break;
            }

            scale = (scale * iterations + currentScale) / (iterations + 1)
            iterations++;
        }

        const accentuationPatternDef: AccentuationPatternDef = {
            type: 'accentuationPatternDef',
            name: this.options.name,
            length: ((cell.end - cell.start) / 4 / 720) * msm.timeSignature.denominator,
            children: accentuations,
        }

        mpm.insertDefinition(accentuationPatternDef, this.options.scope)

        const loop = currentCell.start > cell.end
        const newPattern: AccentuationPattern = {
            type: 'accentuationPattern',
            'name.ref': accentuationPatternDef.name,
            "xml:id": generateId('accentuationPattern', cell.start, mpm),
            date: cell.start,
            scale,
            loop: loop || undefined,
        }
        mpm.insertInstruction(newPattern, this.options.scope)

        if (loop) {
            mpm.insertInstruction({
                type: 'accentuationPattern',
                'name.ref': 'neutral',
                date: currentCell.start,
                "xml:id": generateId('accentuationPattern', currentCell.start, mpm),
                scale: 0,
                loop: undefined
            }, this.options.scope)
        }


        if (mpm.getStyles('accentuationPattern', this.options.scope).length === 0) {
            mpm.insertStyle({
                "name.ref": DEFAULT_STYLE_NAME,
                date: 0,
                'type': 'style',
                'xml:id': v4(),
            }, 'accentuationPattern', this.options.scope)
        }
    }


    private accentuationAt(beat: number, def: AccentuationPatternDef): number {
        // Read once. Every `def.children` access re-reads the child elements and hands back a
        // *new* array (see `mpm/view.ts`), so sorting the property sorted a throwaway and each
        // read below got the document order back. Nothing downstream saw a sorted pattern.
        const children = [...def.children].sort((a, b) => a.beat - b.beat)

        if (children.length === 0) {
            return 0
        }

        if (beat < children[0].beat) {
            return 0
        }
        if (beat >= def.length + 1) {
            const last = children[children.length - 1]
            const result = last["transition.to"] || last.value;
            return result;
        }

        let selectedAccent: Accentuation | undefined;
        let segmentEnd: number = def.length + 1;

        // Traverse the accentuations in reverse order
        for (let i = children.length - 1; i >= 0; --i) {
            const accent = children[i];
            if (beat === accent.beat) {
                return accent.value;
            }

            if (beat > accent.beat) {
                selectedAccent = accent;
                if (i < children.length - 1) {
                    // There is a subsequent accentuation; set its beat as the segment end
                    segmentEnd = children[i + 1].beat;
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
