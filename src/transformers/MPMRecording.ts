import { Instruction, InstructionType, MPM, InstructionOptions, Scope } from "../mpm";

/**
 * An {@link MPM} that notes the `xml:id` of every instruction written through it.
 *
 * `AbstractTransformer.run` hands one of these to `transform` so that a transformer's `created`
 * list — which is what the argumentation layer attributes MPM elements by — falls out of the
 * writing rather than having to be maintained by hand.
 *
 * Instructions only, not definitions or style switches: those are named rather than identified,
 * and nothing downstream resolves them.
 *
 * It shares the espressivo document with the MPM it wraps — a second handle on one tree, not a
 * copy.
 */
export class MPMRecording extends MPM {
    created: string[] = [];

    constructor(mpm: MPM) {
        super(mpm.document)
    }

    insertInstruction<K extends InstructionType>(
        type: K,
        options: InstructionOptions<K>,
        scope: Scope,
        overwrite = false,
    ): Instruction<K> {
        const inserted = super.insertInstruction(type, options, scope, overwrite)
        // An instruction written without an `@xml:id` cannot be attributed to anything, so it is
        // not recorded rather than recorded as `undefined`. Every mpmify writer supplies one.
        if (inserted.id !== undefined) this.created.push(inserted.id)
        return inserted
    }
}
