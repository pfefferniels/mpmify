import { AccentuationPattern, AccentuationPatternDef, Accentuation, MPM } from "../../mpm";
import { MSM } from "../../msm";
import { AbstractTransformer, ScopedTransformationOptions } from "../Transformer";
import { InsertMetricalAccentuation } from "./InsertMetricalAccentuation";

interface MergeMetricalAccentuationsOptions extends ScopedTransformationOptions {
    names: string[]
    into: string
}

export class MergeMetricalAccentuations extends AbstractTransformer<MergeMetricalAccentuationsOptions> {
    name = 'MergeMetricalAccentuations'
    requires = [InsertMetricalAccentuation]

    constructor(options?: MergeMetricalAccentuationsOptions) {
        super()

        // set the default options
        this.options = options || {
            names: [],
            into: '',
            scope: 'global'
        }
    }

    protected transform(_: MSM, mpm: MPM) {
        const allDefs = mpm.getDefinitions<AccentuationPatternDef>('accentuationPatternDef', this.options.scope)
        if (allDefs.length <= 1) return

        const toMerge = allDefs.filter(a => this.options.names.includes(a.name))
        if (toMerge.length <= 1) return

        const mergedPattern = this.mergePatterns(toMerge, this.options.into)

        // Remove first, then insert. The merged pattern is a fresh record rather than one of
        // the originals mutated in place, so the two steps do not interfere: removing the
        // originals cannot take the merged one with it.
        toMerge.forEach(def => mpm.removeDefinition(def))
        mpm.insertDefinition(mergedPattern, this.options.scope)

        const allInstructions = mpm.getInstructions<AccentuationPattern>('accentuationPattern', this.options.scope)
        allInstructions
            .filter(a => this.options.names.includes(a["name.ref"]))
            .forEach(a => {
                a["name.ref"] = this.options.into
            })
    }

    /**
     * The running mean of the patterns' accentuations, beat by beat, as a new definition named
     * `into`. Beats the first pattern does not have are not introduced: the prototype decides
     * the beat structure, and the rest only move its values.
     */
    private mergePatterns(patterns: AccentuationPatternDef[], into: string): AccentuationPatternDef {
        if (patterns.length <= 1) {
            throw new Error('Cannot merge less than two patterns')
        }

        const [prototype, ...rest] = patterns
        const children: Accentuation[] = prototype.children.map(accentuation => ({
            type: 'accentuation',
            beat: accentuation.beat,
            value: accentuation.value,
            'transition.from': accentuation['transition.from'],
            'transition.to': accentuation['transition.to'],
        }))

        let n = 1
        for (const pattern of rest) {
            for (const accentuation of pattern.children) {
                const merged = children.find(a => a.beat === accentuation.beat)
                if (!merged) continue

                merged.value = (merged.value * n + accentuation.value) / (n + 1)
                merged["transition.from"] = (merged["transition.from"] * n + accentuation["transition.from"]) / (n + 1)
                merged["transition.to"] = (merged["transition.to"] * n + accentuation["transition.to"]) / (n + 1)
            }
            n++
        }

        return {
            type: 'accentuationPatternDef',
            name: into,
            length: prototype.length,
            children,
        }
    }
}
