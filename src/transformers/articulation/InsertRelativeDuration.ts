import { Articulation, MPM, Part } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"
import { v4 } from "uuid"

export interface InterpolateArticulationOptions extends TransformationOptions {
    /**
     * The part on which the transformer is to be applied to.
     */
    part: Part
}

/**
 * Inserts the relative duration attribute of the <articulation> element.
 * It can be applied to different parts (melodic preset) or globally (chordal preset).
 * Should be applied after the `InterpolatePhysicalOrnamentation` and a 
 * tempo transformer (simple or curved).
 * 
 * @note Interpolation of relative duration is tempo-dependent, meaning that its 
 * precision depends on the precision of the tempo approximation.
 */
export class InsertRelativeDuration extends AbstractTransformer<InterpolateArticulationOptions> {
    constructor(options?: InterpolateArticulationOptions) {
        super()

        // set the default options
        this.setOptions(options || {
            part: 'global'
        })
    }

    public name() { return 'InterpolateArticulation' }

    public transform(msm: MSM, mpm: MPM): string {
        const articulations: Articulation[] = []
        const chords = msm.asChords(this.options?.part)
        for (const [date, chord] of chords) {
            const chordArticulations: Articulation[] = []
            for (const note of chord) {
                if (!note.tickDuration) {
                    console.log('no tick duration defined for the given note', note["xml:id"], 'at date', date)
                    continue
                }

                const relativeDuration = note.tickDuration / note.duration

                chordArticulations.push({
                    type: 'articulation',
                    'xml:id': `articulation_${v4()}`,
                    date,
                    noteid: '#' + note['xml:id'],
                    relativeDuration
                })
            }

            // if all the notes were combined into one articulation 
            // instruction for the given date, it is not necessary to 
            // define the noteids.
            if (chordArticulations.length === 1) {
                delete chordArticulations[0].noteid
            }

            articulations.push(...chordArticulations)
        }

        mpm.insertInstructions(articulations, this.options?.part !== undefined ? this.options.part : 'global')

        // hand it over to the next transformer
        return super.transform(msm, mpm)
    }
}
