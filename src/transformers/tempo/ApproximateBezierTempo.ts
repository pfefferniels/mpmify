import { v4 } from "uuid"
import { TempoWithEndDate } from "./tempoCalculations"
import { MSM } from "../../msm"
import { MPM } from "mpm-ts"
import { ConfigurableTempoTransformer, Point, TempoSegmentWithPoints } from "./ConfigurableTempoTransformer"

export type BezierCurve = {
    P0: [number, number],
    P1: [number, number],
    P2: [number, number],
    x: (t: number) => number,
    y: (t: number) => number,
    derivative: BezierCurve
}

const quadraticBezier = (P0: [number, number], P1: [number, number], P2: [number, number]): BezierCurve => {
    return {
        P0: P0,
        P1: P1,
        P2: P2,
        x: (t: number) => Math.pow(1 - t, 2) * P0[0] + 2 * t * (1 - t) * P1[0] + Math.pow(t, 2) * P2[0],
        y: (t: number) => Math.pow(1 - t, 2) * P0[1] + 2 * t * (1 - t) * P1[1] + Math.pow(t, 2) * P2[1],
        derivative: {
            x: (t: number) => 2 * (1 - t) * (P1[0] - P0[0]) + 2 * t * (P2[0] - P1[0]),
            y: (t: number) => 2 * (1 - t) * (P1[1] - P0[1]) + 2 * t * (P2[1] - P1[1])
        }
    } as BezierCurve
}

/**
 * cf. https://www.researchgate.net/publication/220437355_A_new_method_for_video_data_compression_by_quadratic_Bezier_curve_fitting
 */
const bestMiddle = (data: Point[], dimension: 0 | 1) => {
    let sum1 = 0;
    for (let i = 0; i < data.length; i++) {
        const ti = (1 / data.length) * i
        sum1 += data[i][dimension] - Math.pow(1 - ti, 2) * data[0][dimension] - Math.pow(ti, 2) * data[data.length - 1][dimension]
    }

    let sum2 = 0;
    for (let i = 0; i < data.length; i++) {
        const ti = (1 / data.length) * i
        sum2 += 2 * ti * (1 - ti)
    }

    return sum1 / sum2
}

// https://cdn.hackaday.io/files/1946398327434976/Nouri-Suleiman-Least-Squares-Data-Fitting-with-Quadratic-Bezier-Curves.pdf

/**
 * Finds the optimal control point P1 for a quadratic Bézier fit.
 * @param data Array of [x,y] points (includes endpoints P0 and P2).
 * @param epsilon Stopping threshold for error improvement.
 * @param initialP1 Optional initial guess for P1. Defaults to centroid of data.
 * @returns An object with P1: [x,y] and the final error value.
 * @description This function is largely based on a paper by Suleiman (2013). The 
 * implementation was written by ChatGPT o3-mini-high, Deep Research, cf.
 * https://chatgpt.com/c/67c01ea4-2410-8005-818f-906a06497b82.
 */
function findP1(data: Point[], epsilon: number, initialP1?: Point): { P1: Point; error: number } {
    const n = data.length;
    if (n < 2) {
        throw new Error("At least two points (P0 and P2) are required.");
    }
    const P0 = data[0];
    const P2 = data[n - 1];

    // Helper: clamp a point to the bounding box of P0 and P2
    const minX = Math.min(P0[0], P2[0]), maxX = Math.max(P0[0], P2[0]);
    const minY = Math.min(P0[1], P2[1]), maxY = Math.max(P0[1], P2[1]);
    function clampToBox(pt: Point): Point {
        const [x, y] = pt;
        const cx = Math.min(maxX, Math.max(minX, x));
        const cy = Math.min(maxY, Math.max(minY, y));
        return [cx, cy];
    }

    // Initial P1 guess: use provided or centroid of all data points
    let P1: Point = initialP1 ? [...initialP1] as Point : [0, 0];
    if (!initialP1) {
        // Compute centroid (average of all points)
        for (const [x, y] of data) {
            P1[0] += x;
            P1[1] += y;
        }
        P1[0] /= n;
        P1[1] /= n;
    }
    P1 = clampToBox(P1);

    // Helper: find the parameter t in [0,1] that minimizes distance from curve (P0,P1,P2) to point q.
    function findClosestT(q: Point): number {
        const [x0, y0] = P0, [x1, y1] = P1, [x2, y2] = P2;
        const [qx, qy] = q;
        // Coefficients of f(t) = |B(t)-q|^2 = d4*t^4 + 4*d3*t^3 + 2*d2*t^2 + 4*d1*t + d0:
        const dx0 = x0 - qx, dy0 = y0 - qy;
        const A = x0 - 2 * x1 + x2;        // (x0 - 2x1 + x2)
        const B = y0 - 2 * y1 + y2;        // (y0 - 2y1 + y2)
        const d4 = A * A + B * B;
        const d3 = A * (x1 - x0) + B * (y1 - y0);
        const d2 = A * dx0 + B * dy0 + 2 * (x1 - x0) ** 2 + 2 * (y1 - y0) ** 2;
        const d1 = (x1 - x0) * dx0 + (y1 - y0) * dy0;
        // If derivative polynomial P(t) = d4*t^3 + 3*d3*t^2 + d2*t + d1 is degenerate or all roots outside [0,1],
        // we'll fall back to checking endpoints.
        let tBest = 0;
        let fBest = dx0 * dx0 + dy0 * dy0;  // f(0) = |P0 - q|^2
        // Check endpoint t=1:
        const dx2 = x2 - qx, dy2 = y2 - qy;
        const f1 = dx2 * dx2 + dy2 * dy2;   // |P2 - q|^2
        if (f1 < fBest) {
            fBest = f1;
            tBest = 1;
        }
        // If d4 is nearly 0, the curve is almost linear; we can just return whichever endpoint was closer.
        if (Math.abs(d4) < 1e-9) {
            return tBest;
        }
        // Use Newton-Raphson to find a root of P'(t) = 0 in [0,1]
        let t = 0.5;  // initial guess (mid-curve)
        for (let iter = 0; iter < 20; iter++) {
            // Polynomial and its derivatives at current t
            const p = d4 * t * t * t + 3 * d3 * t * t + d2 * t + d1;                     // P(t)
            const dp = 3 * d4 * t * t + 6 * d3 * t + d2;                            // P'(t)
            if (Math.abs(p) < 1e-12) break;  // close to a root
            if (Math.abs(dp) < 1e-12) break; // derivative too small, stop to avoid divide-by-zero
            const tNext = t - p / dp;
            if (tNext < 0 || tNext > 1) {
                // If Newton step goes out of [0,1], clamp it and stop (root likely outside [0,1])
                t = Math.min(1, Math.max(0, tNext));
                break;
            }
            if (Math.abs(tNext - t) < 1e-9) {
                t = tNext;
                break;  // converged
            }
            t = tNext;
        }
        // After Newton's iteration, ensure t is within [0,1]
        t = Math.min(1, Math.max(0, t));
        // Evaluate distance at this t
        const oneMinusT = 1 - t;
        const bx = oneMinusT * oneMinusT * x0 + 2 * oneMinusT * t * x1 + t * t * x2;
        const by = oneMinusT * oneMinusT * y0 + 2 * oneMinusT * t * y1 + t * t * y2;
        const dx = bx - qx, dy = by - qy;
        const fMid = dx * dx + dy * dy;
        if (fMid < fBest) {
            tBest = t;
            fBest = fMid;
        }
        return tBest;
    }

    // Main iterative refinement
    let prevError = Number.MAX_VALUE;
    let currError = 0;
    const tValues: number[] = new Array(n);
    const maxIterations = 100;  // safety cap to prevent infinite loops
    for (let iter = 0; iter < maxIterations; iter++) {
        // 1. Assign closest t for each point
        currError = 0;
        for (let i = 0; i < n; i++) {
            const q = data[i];
            const t = (i === 0) ? 0 : (i === n - 1 ? 1 : findClosestT(q));
            tValues[i] = t;
            // Accumulate squared error
            const omT = 1 - t;
            const bx = omT * omT * P0[0] + 2 * omT * t * P1[0] + t * t * P2[0];
            const by = omT * omT * P0[1] + 2 * omT * t * P1[1] + t * t * P2[1];
            const dx = bx - q[0], dy = by - q[1];
            currError += dx * dx + dy * dy;
        }

        // Check convergence: stop if improvement is below epsilon
        if (prevError - currError < epsilon) {
            break;
        }
        prevError = currError;

        // 2. Compute least-squares solution for P1 (keeping P0, P2 fixed)
        let alpha = 0, beta = 0, gamma = 0;
        let deltaX = 0, deltaY = 0;
        for (let i = 0; i < n; i++) {
            const t = tValues[i];
            const omT = 1 - t;
            const t2 = t * t;
            const omT2 = omT * omT;
            alpha += t * omT2 * omT;    // t * (1-t)^3
            beta += t2 * t * omT;      // t^3 * (1-t)
            gamma += t2 * omT2;         // t^2 * (1-t)^2
            deltaX += t * omT * data[i][0];
            deltaY += t * omT * data[i][1];
        }
        if (gamma === 0) {
            // Degenerate case: all t are 0 or 1 (curve used only at endpoints). 
            // We can choose P1 arbitrarily – use centroid of data as a fallback.
            P1 = clampToBox([deltaX /*which would be 0*/, deltaY /*also 0*/]);
            // Actually if gamma=0, alpha=beta=deltaX=deltaY=0, so centroid is appropriate:
            P1 = clampToBox([0, 0]);
            for (const [x, y] of data) {
                P1[0] += x;
                P1[1] += y;
            }
            P1[0] /= n;
            P1[1] /= n;
            P1 = clampToBox(P1);
        } else {
            // Apply the formula for P1
            const x0 = P0[0], y0 = P0[1], x2 = P2[0], y2 = P2[1];
            const newPx = (deltaX - alpha * x0 - beta * x2) / (2 * gamma);
            const newPy = (deltaY - alpha * y0 - beta * y2) / (2 * gamma);
            P1 = clampToBox([newPx, newPy]);
        }
        // Loop continues to next iteration with updated P1
    }

    return { P1: P1, error: currError };
}

export const findBezierCurve = (data: [number, number][]) => {
    const first = data[0]
    const last = data[data.length - 1]

    const P0 = [first[0], first[1]] as [number, number]
    const P2 = [last[0], last[1]] as [number, number]
    const P1 = findP1(data, 100)

    //const P1 = [bestMiddle(data, 0), bestMiddle(data, 1)] as [number, number]
    // console.log('bezier', P0, P1, P2)

    return quadraticBezier(P0, P1.P1, P2);
}

export const approximateFromData = (data: [number, number][], beatLength: number) => {
    const length = data[data.length - 1][0] - data[0][0]
    const curve = findBezierCurve(data)

    const tempoCurve = (t: number) => (60000 * (curve.P2[0] - curve.P0[0])) / (curve.derivative.y(t) * 0.25 * 4 * 720)


    const startBPM = tempoCurve(0)
    const endBPM = tempoCurve(1)

    const meanTempo = (endBPM - startBPM) / 2 + startBPM
    const meanTempoAtT = (125 * length + 3 * meanTempo * (curve.P0[1] - curve.P1[1])) / (3 * meanTempo * (curve.P0[1] - 2 * curve.P1[1] + curve.P2[1]))
    const meanTempoAt = (curve.x(meanTempoAtT) - curve.x(0)) / curve.x(1)

    const tempo: TempoWithEndDate = {
        type: 'tempo',
        'xml:id': `tempo_${v4()}`,
        'bpm': startBPM,
        'transition.to': endBPM,
        meanTempoAt,
        date: data[0][0],
        endDate: data[data.length - 1][0],
        beatLength
    }

    return { curve, tempo }
}

export class ApproximateBezierTempo extends ConfigurableTempoTransformer {
    name = 'ApproximateBezierTempo'

    curves: BezierCurve[] = []

    protected transform(msm: MSM, mpm: MPM) {
        this.curves = []
        super.transform(msm, mpm)
    }

    protected approximateTempo(segment: TempoSegmentWithPoints): TempoWithEndDate {
        if (segment.points.length < 2) {
            throw new Error('At least two points are required to approximate a tempo curve.');
        }

        const result = approximateFromData(segment.points, segment.beatLength)
        this.curves.push(result.curve)

        return result.tempo
    }

    protected addTickOnsets(msm: MSM) {
        for (const curve of this.curves) {
            const startDate = curve.P0[0]
            const endDate = curve.P2[0]

            msm.allNotes
                .filter(n => n.date >= startDate && n.date < endDate)
                .forEach(n => {
                    n.tickDate = findDate(n.date, curve)
                })
        }
    }
}

const findDate = (targetMs: number, effectiveCurve: BezierCurve): number => {
    const t = findT(targetMs - effectiveCurve.P0[1], effectiveCurve)
    return effectiveCurve.x(t)
}

export const findT = (targetY: number, effectiveCurve: BezierCurve): number => {
    const y0 = effectiveCurve.P0[1];
    const y1 = effectiveCurve.P1[1];
    const y2 = effectiveCurve.P2[1];

    // Coefficients for the quadratic equation: A*t^2 + B*t + C = 0
    const A = y0 - 2 * y1 + y2;
    const B = 2 * (y1 - y0);
    const C = y0 - targetY;

    let t: number;

    // Handle the degenerate (linear) case when A is approximately 0
    if (Math.abs(A) < 1e-8) {
        if (Math.abs(B) < 1e-8) {
            // The curve is essentially constant; if y0 === targetY, return 0, otherwise no valid t.
            return y0 === targetY ? 0 : NaN;
        }
        t = -C / B;
        return t;
    }

    // Compute the discriminant
    const discriminant = B * B - 4 * A * C;
    if (discriminant < 0) {
        // No real solution exists (targetY might be outside the range of y-values on the curve)
        return NaN;
    }

    const sqrtDiscriminant = Math.sqrt(discriminant);
    const t1 = (-B + sqrtDiscriminant) / (2 * A);
    const t2 = (-B - sqrtDiscriminant) / (2 * A);

    // Prefer the solution that lies within [0, 1]
    if (t1 >= 0 && t1 <= 1) {
        t = t1;
    } else if (t2 >= 0 && t2 <= 1) {
        t = t2;
    } else {
        // If neither solution lies in [0,1], use an initial guess to choose the closest
        const initialGuess = targetY / (effectiveCurve.y(1) - effectiveCurve.y(0));
        t = Math.abs(t1 - initialGuess) < Math.abs(t2 - initialGuess) ? t1 : t2;
    }

    return t;
};
