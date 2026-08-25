import { MPM, TransformationInfo, Metadata } from "../../mpm"
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
        super(options || {})
    }

    protected transform(msm: MSM, mpm: MPM) {
        const transformations: TransformationInfo[] = (this.options.appInfo?.transformations ?? [])
            .map(t => ({
                'xml:id': t['xml:id'],
                name: t.name,
                cdata: t.cdata,
                notes: (t.notes ?? []).map(n => n.text),
            }))

        const metadata: Metadata = {
            authors: this.options.authors?.map(author => ({
                number: author.number,
                text: author.text,
            })),
            comments: this.options.comments?.map(comment => ({ text: comment.text })),
            relatedResources: this.options.relatedResources?.map(resource => ({
                uri: resource.uri,
                type: resource.type,
            })),
            appInfo: this.options.appInfo && {
                name: this.options.appInfo.name,
                version: this.options.appInfo.version,
                url: this.options.appInfo.url,
                transformations,
            },
        }

        mpm.setMetadata(metadata)
    }
}
