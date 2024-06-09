type Point = [number, number];

interface TempoWithEndDate {
    date: number;
    'bpm': number;
    'beatLength': number;
    'transition.to'?: number;
    'meanTempoAt'?: number;
    endDate: number,
}

type BezierCurve = {
    P0: [number, number],
    P1: [number, number],
    P2: [number, number],
    x: (t: number) => number,
    y: (t: number) => number,
    derivative: BezierCurve
}

const computeMillisecondsForTransition = (date: number, tempo: TempoWithEndDate): number => {
    const N = 2 * Math.floor((date - tempo.date) / (720 / 4));
    const adjustedN = (N === 0) ? 2 : N;

    const n = adjustedN / 2;
    const x = (date - tempo.date) / adjustedN;

    const resultConst = (date - tempo.date) * 5000 / (adjustedN * tempo.beatLength * 720);
    let resultSum = 1 / tempo.bpm + 1 / getTempoAt(date, tempo);

    for (let k = 1; k < n; k++) {
        resultSum += 2 / getTempoAt(tempo.date + 2 * k * x, tempo);
    }

    for (let k = 1; k <= n; k++) {
        resultSum += 4 / getTempoAt(tempo.date + (2 * k - 1) * x, tempo);
    }

    return resultConst * resultSum;
}

const getTempoAt = (date: number, tempo: TempoWithEndDate): number => {
    // no tempo
    if (!tempo.bpm) return 100.0;

    // constant tempo
    if (!tempo["transition.to"]) return tempo.bpm

    if (date === tempo.endDate) return tempo["transition.to"]

    const result = (date - tempo.date) / (tempo.endDate - tempo.date);
    const exponent = Math.log(0.5) / Math.log(tempo.meanTempoAt || 0.5);
    return Math.pow(result, exponent) * (tempo["transition.to"] - tempo.bpm) + tempo.bpm;
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
 * https://cdn.hackaday.io/files/1946398327434976/Nouri-Suleiman-Least-Squares-Data-Fitting-with-Quadratic-Bezier-Curves.pdf
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


const findBezierCurve = (data: [number, number][]) => {
    const first = data[0]
    const last = data[data.length - 1]

    const P0 = [first[0], first[1]] as [number, number]
    const P2 = [last[0], last[1]] as [number, number]
    const P1 = [bestMiddle(data, 0), bestMiddle(data, 1)] as [number, number]

    console.log(P0, P1, P2)

    return quadraticBezier(P0, P1, P2);
}

export const approximateFromData = (data: [number, number][], beatLength: number) => {
    const length = data[data.length - 1][0] - data[0][0]
    const curve = findBezierCurve(data)

    const tempoCurve = (t: number) => (60000 * length) / (curve.derivative.y(t) * 720)

    let startBPM = 0
    {
        const length = curve.x(1 / 10000) - curve.x(0)
        const ms = curve.y(1 / 10000) - curve.y(0)
        startBPM = (60000 * length) / (ms * 720)
    }

    let endBPM = 0
    {
        const length = curve.x(1) - curve.x(1 - (1 / 10000))
        const ms = curve.y(1) - curve.y(1 - (1 / 10000))
        endBPM = (60000 * length) / (ms * 720)
    }


    const meanTempo = (endBPM - startBPM) / 2 + startBPM
    const meanTempoAtT = (125 * length + 3 * meanTempo * (curve.P0[1] - curve.P1[1])) / (3 * meanTempo * (curve.P0[1] - 2 * curve.P1[1] + curve.P2[1]))
    const meanTempoAt = (curve.x(meanTempoAtT) - curve.x(0)) / curve.x(1)

    return {
        'bpm': startBPM,
        'transition.to': endBPM,
        meanTempoAt,
        date: data[0][0],
        endDate: data[data.length - 1][0],
        beatLength: 0.25
    }
}

////////
/*
{
    const instruction1: TempoWithEndDate = {
        date: 0,
        endDate: 2880,
        bpm: 60,
        "transition.to": 120,
        beatLength: 0.25,
        meanTempoAt: 0.7
    }

    const points = []
    for (let i = 0; i <= 2880; i += 180) {
        points.push([i, computeMillisecondsForTransition(i, instruction1)] as [number, number])
    }

    const newTempo = approximateFromData(points, 0.0625)
    console.log('A:', newTempo)

    for (let i = 0; i < points.length; i++) {
        console.log(`${points[i][1].toFixed(0)} -> ${computeMillisecondsForTransition(points[i][0], newTempo).toFixed(0)}`)
    }
}

{
    const instruction2: TempoWithEndDate = {
        date: 2880,
        endDate: 5760,
        bpm: 120,
        "transition.to": 60,
        beatLength: 0.25,
        meanTempoAt: 0.2
    }

    const points = []
    for (let i = 2880; i <= 5760; i += 180) {
        points.push([i, computeMillisecondsForTransition(i, instruction2)] as [number, number])
    }

    const newTempo = approximateFromData(points, 0.0625)

    console.log('B:', newTempo)

    for (let i = 0; i < points.length; i++) {
        console.log(`${points[i][1].toFixed(0)} -> ${computeMillisecondsForTransition(points[i][0], newTempo).toFixed(0)}`)
    }
}



*/