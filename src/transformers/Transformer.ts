import { AppInfo, MPM, Scope } from "mpm-ts";
import { MSM } from "../msm";
import { MPMRecording } from "./MPMRecording";

/**
 * 
 */
export interface TransformationOptions {
}

/**
 * The part on which the transformer is to be applied to.
 */
export interface ScopedTransformationOptions extends TransformationOptions {
    scope: Scope
}

/**
 * The Transformer interface declares a method for building the chain of transformations.
 * It also declares a method for executing a transformation.
 */
export interface Transformer {
    setNext(transformer: Transformer | undefined): Transformer
    setOptions(options: TransformationOptions): void
    getOptions(): TransformationOptions
    insertMetadata(mpm: MPM): void
    name: string
    created: string[]
    run(msm: MSM, mpm: MPM): void
}

/**
 * The default chaining behavior.
 */
export abstract class AbstractTransformer<OptionsType extends TransformationOptions> implements Transformer {
    abstract name: string
    nextTransformer?: Transformer
    options?: OptionsType
    created: string[] = []

    setNext(transformer: Transformer | undefined): Transformer {
        this.nextTransformer = transformer;
        return this;
    }

    // this method should not be overridden
    run(msm: MSM, mpm: MPM) {
        this.insertMetadata(mpm)

        const mpmRecording = new MPMRecording(mpm)
        this.transform(msm, mpmRecording)
        this.created = mpmRecording.created

        if (this.nextTransformer) {
            this.nextTransformer.run(msm, mpm)
        }
    }

    abstract transform(msm: MSM, mpm: MPM);

    setOptions(options: OptionsType) {
        this.options = options
    }

    getOptions(): TransformationOptions {
        return this.options || {}
    }

    insertMetadata(mpm: MPM, overwrite = true) {
        let appInfo = mpm.doc.metadata.find(el => el.type === 'appInfo') as AppInfo | undefined
        if (!appInfo) {
            appInfo = {
                type: 'appInfo',
                name: 'mpmify',
                url: 'https://github.com/pfefferniels/mpmify',
                version: '0.1',
                children: []
            }
            mpm.doc.metadata.push(appInfo)
        }

        if (overwrite) {
            appInfo.children = appInfo.children.filter(el => el.name !== this.name)
        }

        appInfo.children.push({
            type: 'transformation',
            name: this.name,
            cdata: JSON.stringify(this.options)
        })
    }
}
