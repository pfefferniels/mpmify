import { Pipeline } from "./Pipeline";
import {
    InterpolateDynamicsMap,
    InterpolatePhysicalOrnamentation,
    TempoTransformer,
    InterpolateTimingImprecision
} from ".";
import { ExtractStyleDefinitions } from "./ExtractStyleDefinitions";
import { InterpolateAsynchrony } from "./InterpolateAsynchrony";
import { InterpolateArticulation } from "./InterpolateArticulation";
import { InterpolateRubato } from "./InterpolateRubato";
import { BeatLengthBasis } from "./BeatLengthBasis";

export interface TransformerSettings {
    tempoApproximation: 'constant' | 'linear' | 'curved'
    minimumArpeggioSize: number
    beatLength: BeatLengthBasis
    rubatoLength: BeatLengthBasis
    epsilon: number
}

export const getDefaultPipeline = (mode: 'melodic-texture' | 'chordal-texture', settings: TransformerSettings) => {
    if (mode === "melodic-texture") {
        return new Pipeline(
            new InterpolatePhysicalOrnamentation({ part: 0, minimumArpeggioSize: settings.minimumArpeggioSize, noteOffShiftTolerance: 250, placement: 'before-beat', durationThreshold: 10 }).setNext(
                new InterpolatePhysicalOrnamentation({ part: 1, minimumArpeggioSize: settings.minimumArpeggioSize, noteOffShiftTolerance: 250, placement: 'on-beat', durationThreshold: 10 }).setNext(
                    new InterpolateAsynchrony({ part: 0, tolerance: 20, precision: 0 }).setNext(
                        new TempoTransformer({ beatLength: settings.beatLength, epsilon: settings.epsilon, precision: 0, translatePhysicalModifiers: true, mode: settings.tempoApproximation }).setNext(
                            new InterpolateRubato({ part: 0, tolerance: 20, beatLength: settings.rubatoLength }).setNext(
                                new InterpolateRubato({ part: 1, tolerance: 20, beatLength: settings.rubatoLength }).setNext(
                                    new InterpolateArticulation({ part: 0, relativeDurationPrecision: 1, relativeDurationTolerance: 0.1 }).setNext(
                                        new InterpolateArticulation({ part: 1, relativeDurationPrecision: 1, relativeDurationTolerance: 0.1 }).setNext(
                                            new InterpolateDynamicsMap({ part: 0, beatLengthBasis: 'everything' }).setNext(
                                                new InterpolateDynamicsMap({ part: 1, beatLengthBasis: 'everything' }).setNext(
                                                    new InterpolateTimingImprecision().setNext(
                                                        new ExtractStyleDefinitions()
                                                    )
                                                )
                                            )
                                        )
                                    )
                                )
                            )
                        )
                    )
                )
            )
        )
    }
    else {
        return new Pipeline(
            new InterpolatePhysicalOrnamentation().setNext(
                new TempoTransformer({ beatLength: settings.beatLength, epsilon: settings.epsilon, precision: 0, translatePhysicalModifiers: true, mode: settings.tempoApproximation }).setNext(
                    new InterpolateRubato().setNext(
                        new InterpolateArticulation().setNext(
                            new InterpolateDynamicsMap().setNext(
                                new InterpolateTimingImprecision().setNext(
                                    new ExtractStyleDefinitions()
                                )
                            )
                        )
                    )
                )
            )
        )
    }
}
