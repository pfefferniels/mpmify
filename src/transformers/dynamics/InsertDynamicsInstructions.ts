import { Dynamics, MPM, Scope } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
import { approximateDynamics, computeInnerControlPointsXPositions, DynamicsPoints, volumeAtDate } from "./Approximation"
import { WithEndDate } from "../tempo/tempoCalculations"

export type DynamicsWithEndDate = Dynamics & WithEndDate

export interface InsertDynamicsInstructionsOptions extends TransformationOptions {
    /**
     * Defines if the dynamics will be interpolated globally as opposed
     * to referring to parts. Default is 'global'.
     */
    part: Scope

    markers: number[]
}

export class InsertDynamicsInstructions extends AbstractTransformer<InsertDynamicsInstructionsOptions> {
    name = 'InsertDynamicsInstructions'
    requires = []

    constructor(options?: InsertDynamicsInstructionsOptions) {
        super()

        // set the default options
        this.options = options || {
            part: 'global',
            markers: [0]
        }
    }

    protected transform(msm: MSM, mpm: MPM) {
        const markers = this.options.markers
        this.options.markers.sort((a, b) => a - b)
        const points = this.asPoints(msm, this.options.part)

        const dynamics: Dynamics[] = []
        for (let i = 0; i < this.options.markers.length; i++) {
            const startDate = markers[i]
            const endDate = markers[i + 1]

            const relevantPoints = points.filter(p => p.date >= startDate && (endDate ? p.date <= endDate : true))
            const instruction = approximateDynamics(relevantPoints)
            if (instruction) {
                dynamics.push(instruction)
            }
        }

        mpm.insertInstructions(dynamics, this.options?.part)
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

            points.push({
                date,
                velocity
            })
        }

        return points
    }

    private setRelativeVolume(msm: MSM, mpm: MPM) {
        const instructions = mpm.getInstructions<Dynamics>('dynamics', this.options.part)
        const instructionsWithEndDate = []
        for (let i=0; i<instructions.length - 1; i++) {
            instructionsWithEndDate.push({
                ...instructions[i],
                endDate: instructions[i + 1].date,
                ...computeInnerControlPointsXPositions(
                    instructions[i].curvature,
                    instructions[i].protraction)
            })
        }

        const chords = msm.asChords(this.options.part)

        for (const [date, notes] of chords) {
            const corresp = instructionsWithEndDate.find(i => date >= i.date && date < i.endDate)
            if (!corresp) continue 

            for (const note of notes) {
                if (!note["midi.velocity"]) continue 

                const should = volumeAtDate(corresp, note.date)
                note.absoluteVelocityChange = note["midi.velocity"] - should
            }
        }
    }
}
