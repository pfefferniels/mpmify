import { MPM, Author, Comment, RelatedResource, AppInfo, TransformationInfo, Note, Metadata } from "mpm-ts"
import { MSM } from "../../msm"
import { AbstractTransformer, TransformationOptions } from "../Transformer"

export interface AuthorOptions {
    number: number
    text: string
}

export interface CommentOptions {
    text: string
}

export interface RelatedResourceOptions {
    uri: string
    type: string
}

export interface NoteOptions {
    text: string
}

export interface TransformationInfoOptions {
    'xml:id': string
    name: string
    cdata: string
    notes?: NoteOptions[]
}

export interface AppInfoOptions {
    name: string
    version: string
    url: string
    transformations?: TransformationInfoOptions[]
}

export interface InsertMetadataOptions extends TransformationOptions {
    authors?: AuthorOptions[]
    comments?: CommentOptions[]
    relatedResources?: RelatedResourceOptions[]
    appInfo?: AppInfoOptions
}

/**
 * Inserts metadata into the MPM document.
 *
 * Metadata can include authors, comments, related resources, and app info.
 */
export class InsertMetadata extends AbstractTransformer<InsertMetadataOptions> {
    name = 'InsertMetadata'
    requires = []

    constructor(options?: InsertMetadataOptions) {
        super()
        this.options = options || {}
    }

    protected transform(msm: MSM, mpm: MPM) {
        const metadata: Metadata = []

        if (this.options.authors) {
            for (const author of this.options.authors) {
                metadata.push({
                    type: 'author',
                    number: author.number,
                    text: author.text
                } as Author)
            }
        }

        if (this.options.comments) {
            for (const comment of this.options.comments) {
                metadata.push({
                    type: 'comment',
                    text: comment.text
                } as Comment)
            }
        }

        if (this.options.relatedResources) {
            for (const resource of this.options.relatedResources) {
                metadata.push({
                    uri: resource.uri,
                    type: resource.type
                } as RelatedResource)
            }
        }

        if (this.options.appInfo) {
            const transformations: TransformationInfo[] = []

            if (this.options.appInfo.transformations) {
                for (const t of this.options.appInfo.transformations) {
                    const notes: Note[] = (t.notes || []).map(n => ({
                        type: 'note' as const,
                        text: n.text
                    }))

                    transformations.push({
                        type: 'transformation',
                        'xml:id': t['xml:id'],
                        name: t.name,
                        cdata: t.cdata,
                        children: notes
                    } as TransformationInfo)
                }
            }

            metadata.push({
                type: 'appInfo',
                name: this.options.appInfo.name,
                version: this.options.appInfo.version,
                url: this.options.appInfo.url,
                children: transformations
            } as AppInfo)
        }

        mpm.setMetadata(metadata)
    }
}
