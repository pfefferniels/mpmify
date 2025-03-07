import { AccentuationPattern, AccentuationPatternDef, MPM } from "mpm-ts";
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
        mpm.insertDefinition(mergedPattern, this.options.scope)
        toMerge.forEach(def => mpm.removeDefinition(def))

        const allInstructions = mpm.getInstructions<AccentuationPattern>('accentuationPattern', this.options.scope)
        allInstructions
            .filter(a => this.options.names.includes(a["name.ref"]))
            .forEach(a => {
                a["name.ref"] = this.options.into
            })
    }

    private mergePatterns(patterns: AccentuationPatternDef[], into: string): AccentuationPatternDef {
        if (patterns.length <= 1) {
            throw new Error('Cannot merge less than two patterns')
        }

        const [prototype, ...rest] = patterns
        prototype.name = into

        let n = 1
        for (const pattern of rest) {
            for (const accentuation of pattern.children) {
                const prototypeAccentuation = prototype.children.find(a => a.beat === accentuation.beat)
                if (!prototypeAccentuation) continue

                prototypeAccentuation.value = (prototypeAccentuation.value * n + accentuation.value) / (n + 1)
                prototypeAccentuation["transition.from"] = (prototypeAccentuation["transition.from"] * n + accentuation["transition.from"]) / (n + 1)
                prototypeAccentuation["transition.to"] = (prototypeAccentuation["transition.to"] * n + accentuation["transition.to"]) / (n + 1)
            }
            n++
        }

        return prototype
    }
}
