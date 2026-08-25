# mpmify

Using an alignment of a score with performance data, mpmify creates 
an MPM representation of the performance.

## Building

```bash
npm install
npm run build
```

This compiles TypeScript sources to `lib/`.

> **Note:** mpmify depends on [espressivo](../meico-ts) as a local package
> (`file:../meico-ts`), so make sure it is available at the expected path and built
> (`npm run build` there). espressivo owns MPM and MSM; mpmify owns the fitting and the
> alignment. See `ESPRESSIVO.md` for where the line falls.

## Quick Example

```ts
import { Alignment, createMpm, InsertDynamicsInstructions, ApproximateLogarithmicTempo } from 'mpmify'

// 1. An alignment: the score, and what the recording did with it. Symbolic `date` and
//    `duration` are in ticks; the performance is stated in MSM's own attributes, in ms.
const msm = new Alignment([
    {
        'xml:id': 'n1', part: 1, date: 0, duration: 720,
        pitchname: 'c', accidentals: 0, octave: 4,
        'milliseconds.date': 0, 'milliseconds.date.end': 450,
        'midi.pitch': 60, velocity: 80
    },
    {
        'xml:id': 'n2', part: 1, date: 720, duration: 720,
        pitchname: 'd', accidentals: 0, octave: 4,
        'milliseconds.date': 500, 'milliseconds.date.end': 900,
        'midi.pitch': 62, velocity: 90
    }
], { numerator: 4, denominator: 4 })

// 2. Create an empty MPM and apply transformers
const mpm = createMpm()

new ApproximateLogarithmicTempo({
    scope: 'global', from: 0, to: msm.lastDate(), beatLength: 0.25, silentOnsets: []
}).run(msm, mpm)
new InsertDynamicsInstructions({
    scope: 'global', from: 0, to: msm.lastDate(), phantomVelocities: new Map()
}).run(msm, mpm)

// mpm now contains dynamics and tempo instructions derived from the performance
```

## Testing

```bash
npm test
```

The suites under `test/` cover the transformers and, in `test/mpm/` and `test/alignment/`, the
MPM and alignment layers themselves.
The wider check is `scripts/bake/` — see its README — which runs the whole pipeline over a
real MEI + `info.json` and is what the port was verified against.
