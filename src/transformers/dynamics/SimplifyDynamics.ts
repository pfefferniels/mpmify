import { Dynamics, MPM, Part } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
import { v4 } from "uuid"

interface ApproximationError {
    total: number
    worst: number
    worstIndex: number
}

interface InnerControlPoints {
    x1: number
    x2: number
}

type DynamicsWithEndDate = Dynamics & {
    endDate: number
}

const computerInnerControlPoints = (protraction: number, curvature: number): InnerControlPoints => {
    return {
        x1: curvature + ((Math.abs(protraction) + protraction) / (2.0 * protraction) - (Math.abs(protraction) / protraction) * curvature) * protraction,
        x2: 1.0 - curvature + ((protraction - Math.abs(protraction)) / (2.0 * protraction) + (Math.abs(protraction) / protraction) * curvature) * protraction
    }
}

const getTForDate = (date: number, frame: DynamicsWithEndDate) => {
    if (date == frame.date)
        return 0.0;

    if (date == frame.endDate)
        return 1.0;

    const { x1, x2 } = computerInnerControlPoints(frame.protraction, frame.curvature)

    // values that are often required
    const s = frame.endDate - frame.date
    date = date - frame.date
    const u = (3.0 * x1) - (3.0 * x2) + 1.0;
    const v = (-6.0 * x1) + (3.0 * x2);
    const w = 3.0 * x1;

    // binary search for the t that is integer precise on the x-axis/time domain
    let t = 0.5;
    let diffX = ((((u * t) + v) * t + w) * t * s) - date;
    for (let tt = 0.25; Math.abs(diffX) >= 1.0; tt *= 0.5) {    // while the difference in the x-domain is >= 1.0
        if (diffX > 0.0)                                        // if t is too small
            t -= tt;
        else                                                    // if t is too big
            t += tt;
        diffX = ((((u * t) + v) * t + w) * t * s) - date;       // compute difference
    }
    return t;
}

/**
 * compute the dynamics value at the given tick position
 * @param date
 * @return
 */
const getVolumeAt = (date: number, frame: DynamicsWithEndDate): number => {
    if ((date < frame.date) || frame.volume === frame["transition.to"]) {
        return +frame.volume
    }

    if (date >= frame.endDate) {
        return frame["transition.to"]
    }

    const t = getTForDate(date, frame)
    return ((((3.0 - (2.0 * t)) * t * t) * (frame["transition.to"] - (+frame.volume))) + (+frame.volume));
}

const calculateError = (frame: DynamicsWithEndDate, points: Dynamics[]): ApproximationError => {
    let total = 0
    let worstIndex = 0
    let worst = 0
    for (let i = 0; i < points.length; i++) {
        const point = points[i]
        const t = getTForDate(point.date, frame)
        const calculatedVolume = getVolumeAt(t, frame)
        const diff = Math.abs(calculatedVolume - (+point.volume))
        if (diff > worst) {
            worst = diff
            worstIndex = i
        }
        total += diff
    }
    return { total, worst, worstIndex }
}

const findOptimalFrame = (points: Dynamics[]) => {
    const guess: DynamicsWithEndDate = {
        type: 'dynamics',
        'xml:id': `dynamics_${v4()}`,
        date: points[0].date,
        endDate: points[points.length - 1].date,
        volume: points[0].volume,
        'transition.to': +(points[points.length - 1].volume),
        protraction: 0,
        curvature: 0.5
    }

    // calculate the best combination of protraction
    // and curvature, where the error is as minimal as possible.
    const error = calculateError(guess, points)

    return {
        guess,
        error
    }
}

const douglasPeucker = (dynamics: Dynamics[], epsilon = 1): Dynamics[] => {
    const endIndex = dynamics.length - 1

    if (dynamics.length <= 2) return dynamics

    const { guess, error } = findOptimalFrame(dynamics)
    const { worst, worstIndex } = error

    if (worst > epsilon) {
        return [
            ...douglasPeucker(dynamics.slice(0, worstIndex), epsilon),
            ...douglasPeucker(dynamics.slice(worstIndex, endIndex), epsilon)
        ]
    }

    return [guess]
}

export interface SimplifyDynamicsOptions extends TransformationOptions {
    /**
     * Defines if the dynamics will be interpolated globally as opposed
     * to referring to parts. Default is 'global'.
     */
    part: Part

    epsilon: number
}

export class SimplifyDynamics extends AbstractTransformer<SimplifyDynamicsOptions> {
    constructor(options?: SimplifyDynamicsOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            part: 'global',
            epsilon: 5
        })
    }

    public name() { return 'SimplifyDynamics' }

    public transform(msm: MSM, mpm: MPM): string {
        const rawDynamics = mpm.getInstructions<Dynamics>('dynamics').slice()

        mpm.removeInstructions('dynamics', this.options.part)
        mpm.insertInstructions(douglasPeucker(rawDynamics, this.options?.epsilon || 0), this.options.part)

        return super.transform(msm, mpm)
    }
}
