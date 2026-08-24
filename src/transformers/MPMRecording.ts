import { AnyInstruction, MPM, Scope } from "../mpm";

/**
 * An {@link MPM} that notes the `xml:id` of every instruction written through it.
 *
 * `AbstractTransformer.run` hands one of these to `transform` so that a transformer's `created`
 * list — which is what the argumentation layer attributes MPM elements by — falls out of the
 * writing rather than having to be maintained by hand.
 *
 * Instructions only, not definitions or style switches: those are named rather than identified,
 * and nothing downstream resolves them. (mpm-ts's version was a method-wrapping decorator whose
 * type admitted all three; it too was only ever asked to record `insertInstruction`.)
 *
 * It shares the espressivo document with the MPM it wraps — a second handle on one tree, not a
 * copy.
 */
export class MPMRecording extends MPM {
    created: string[] = [];

    constructor(mpm: MPM) {
        super(mpm.document)
    }

    insertInstruction<T extends AnyInstruction>(instruction: T, scope: Scope, overwrite = false): T {
        const inserted = super.insertInstruction(instruction, scope, overwrite)
        this.created.push(inserted['xml:id'])
        return inserted
    }
}
