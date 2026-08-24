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
> (`npm run build` there). espressivo is the MPM object model mpmify writes through; it
> replaced `mpm-ts` on 2026-08-24 (see `PORT-TO-ESPRESSIVO.md` and `old-bugs.md`).

## Quick Example

```ts
import { MSM, MPM, InsertDynamicsInstructions, ApproximateLogarithmicTempo } from 'mpmify'

// 1. Create an MSM from aligned score + performance data
const msm = new MSM([
    {
        'xml:id': 'n1', part: 1, date: 0, duration: 720,
        pitchname: 'c', accidentals: 0, octave: 4,
        'midi.onset': 0.0, 'midi.duration': 0.45,
        'midi.pitch': 60, 'midi.velocity': 80
    },
    {
        'xml:id': 'n2', part: 1, date: 720, duration: 720,
        pitchname: 'd', accidentals: 0, octave: 4,
        'midi.onset': 0.5, 'midi.duration': 0.40,
        'midi.pitch': 62, 'midi.velocity': 90
    }
], { numerator: 4, denominator: 4 })

// 2. Create an empty MPM and apply transformers
const mpm = new MPM()

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

The suites under `test/` cover the transformers and, in `test/mpm/`, the MPM layer itself.
The wider check is `scripts/bake/` — see its README — which runs the whole pipeline over a
real MEI + `info.json` and is what the port was verified against.
