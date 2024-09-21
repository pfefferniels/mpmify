import { AppInfo, MPM, Scope } from "mpm-ts";
import { MSM } from "../msm";

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
    setNext(transformer: Transformer): Transformer
    transform(msm: MSM, mpm: MPM): string
    setOptions(options: TransformationOptions): void
    insertMetadata(mpm: MPM): void
    name(): string
}

/**
 * The default chaining behavior.
 */
export abstract class AbstractTransformer<OptionsType extends TransformationOptions> implements Transformer {
    public nextTransformer?: Transformer
    public options?: OptionsType

    public setNext(transformer: Transformer): Transformer {
        this.nextTransformer = transformer;
        return this;
    }

    public transform(msm: MSM, mpm: MPM): string {
        if (this.nextTransformer) {
            this.nextTransformer.insertMetadata(mpm)
            return this.nextTransformer.transform(msm, mpm)
        }

        return 'done'
    }

    public setOptions(options: OptionsType) {
        this.options = options
    }

    public insertMetadata(mpm: MPM) {
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

        appInfo.children.push({
            type: 'transformation',
            name: this.name(),
            cdata: JSON.stringify(this.options)
        })
    }

    abstract name(): string
}
