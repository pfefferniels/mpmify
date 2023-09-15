import { MPM, Ornament } from "../mpm"
import { MSM } from "../msm"
import { AbstractTransformer, TransformationOptions } from "./Transformer"

const physicalToSymbolic = (physicalDate: number, bpm: number, beatLength: number) => {
    return (physicalDate / 1000) * bpm * beatLength / 60
}

export interface InterpolateSymbolicOrnamentationOptions extends TransformationOptions {

}

/**
 * This transformer turns the existing physical ornamentation values into
 * symbolic ones using the existing BPM for every note.
 */
export class InterpolateSymbolicOrnamentation extends AbstractTransformer<InterpolateSymbolicOrnamentationOptions> {
    public name() { return 'InterpolateSymbolicOrnamentation' }

    public transform(msm: MSM, mpm: MPM): string {
        const ornaments = mpm.getInstructions<Ornament>('ornament', 'global')

        ornaments.forEach((o: any) => {
            const correspondingMsmNote = msm.notesAtDate(o.date, 'global')[0]

            o['frame.start'] = physicalToSymbolic(o['frame.start'],
                correspondingMsmNote.bpm || 60,
                (correspondingMsmNote['bpm.beatLength'] || 0.25) * 4 * 720).toFixed(2)
            o['frameLength'] = physicalToSymbolic(o['frameLength'],
                correspondingMsmNote.bpm || 60,
                (correspondingMsmNote['bpm.beatLength'] || 0.25) * 4 * 720).toFixed(2)
            o['time.unit'] = 'ticks'
        })

        // replace the existing physical instructions with symbolic ones
        mpm.removeInstructions('ornament', 'global')
        mpm.insertInstructions(ornaments, 'global')

        // hand it over to the next transformer
        return super.transform(msm, mpm)
    }
}
