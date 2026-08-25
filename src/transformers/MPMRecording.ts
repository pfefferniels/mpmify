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

        // An instruction with no `@xml:id` cannot be attributed to the call that wrote it: it
        // gets no `@corresp`, the work file cannot name it, and `deriveSegments` drops the span
        // that pointed at it. All of that is silent, and it happened — nine `<tempo>` elements
        // written without one, found only by counting spans in a bake fixture. Every mpmify
        // writer supplies an id, so a missing one is a bug in the caller, and this is where it
        // is cheapest to see.
        if (inserted.id === undefined) {
            throw new Error(
                `<${type}> written at date ${String((options as { date: number }).date)} with no `
                + 'xml:id. An instruction without one cannot be attributed to the transformer '
                + 'that wrote it — pass `id` in the options.'
            )
        }

        this.created.push(inserted.id)
        return inserted
    }
}
