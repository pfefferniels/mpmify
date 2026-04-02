# mpmify

Using an alignment of a score with performance data, mpmify creates 
an MPM representation of the performance.

## Building

```bash
npm install
npm run build
```

This compiles TypeScript sources to `lib/`.

> **Note:** mpmify depends on [mpm-ts](../mpm-ts) as a local package (`file:../mpm-ts`), so make sure it is available at the expected path.

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

new InsertDynamicsInstructions({ part: 'global', beatLength: 0.25 }).run(msm, mpm)
new ApproximateLogarithmicTempo({ part: 'global', beatLength: 0.25 }).run(msm, mpm)

// mpm now contains dynamics and tempo instructions derived from the performance
```
