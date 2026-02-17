import { Dynamics, MPM, Scope } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, generateId, ScopedTransformationOptions, TransformationOptions } from "../Transformer"
import { approximateDynamics, computeInnerControlPointsXPositions, DynamicsPoints, volumeAtDate } from "./Approximation"
import { WithEndDate } from "../tempo/tempoCalculations"

export type DynamicsWithEndDate = Dynamics & WithEndDate

export interface InsertDynamicsInstructionsOptions extends ScopedTransformationOptions {
    from: number
    to: number,
    phantomVelocities: Map<number, number>
}

export class InsertDynamicsInstructions extends AbstractTransformer<InsertDynamicsInstructionsOptions> {
    name = 'InsertDynamicsInstructions'
    requires = []

    constructor(options?: InsertDynamicsInstructionsOptions) {
        super()

        // set the default options
        this.options = options || {
            scope: 'global',
            from: 0,
            to: 0,
            phantomVelocities: new Map()
        }
    }

    protected transform(msm: MSM, mpm: MPM) {
        const points = this.asPoints(msm, this.options.scope)
        const { from, to } = this.options

        const relevantPoints = points.filter(p => p.date >= from && p.date <= to)
        const instruction = approximateDynamics(relevantPoints)
        if (!instruction) return

        instruction["xml:id"] = generateId('dynamics', instruction.date, mpm)

        mpm.insertInstruction(instruction, this.options?.scope)
        this.setRelativeVolume(msm, mpm)
    }

    private asPoints(msm: MSM, part: Scope): DynamicsPoints[] {
        const points: DynamicsPoints[] = []
        const chords = msm.asChords(part)
        for (const [date, notes] of chords) {
            const notesWithVolume = notes
                .filter(n => n["midi.velocity"] !== undefined)
            const velocity = notesWithVolume
                .reduce((sum, curr) => sum + curr["midi.velocity"], 0) / notesWithVolume.length

            const phantomVelocity = this.options.phantomVelocities.get(date)

            points.push({
                date,
                velocity: phantomVelocity || velocity
            })
        }

        return points
    }

    private setRelativeVolume(msm: MSM, mpm: MPM) {
        const instructions = mpm.getInstructions<Dynamics>('dynamics', this.options.scope)
        const instructionsWithEndDate = []
        for (let i = 0; i < instructions.length - 1; i++) {
            instructionsWithEndDate.push({
                ...instructions[i],
                endDate: instructions[i + 1].date,
                ...computeInnerControlPointsXPositions(
                    instructions[i].curvature,
                    instructions[i].protraction)
            })
        }

        const chords = msm.asChords(this.options.scope)

        for (const [date, notes] of chords) {
            const corresp = instructionsWithEndDate.find(i => date >= i.date && date < i.endDate)
            if (!corresp) continue

            for (const note of notes) {
                if (!note["midi.velocity"]) continue

                const should = volumeAtDate(corresp, note.date)
                note.absoluteVelocityChange = note["midi.velocity"] - should
                // console.log('absoluteVelocityChange', note["xml:id"], note["midi.velocity"], should, note.absoluteVelocityChange);
            }
        }
    }
}
