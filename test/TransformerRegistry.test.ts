// @vitest-environment jsdom

import { describe, test, expect } from "vitest"
import {
    registerTransformer,
    createTransformer,
    getTransformerOrder,
    isRegistered,
    clearRegistry,
} from "../src/transformers/TransformerRegistry"
import { AbstractTransformer, TransformationOptions } from "../src/transformers/Transformer"
import { exportWork, importWork } from "../src/Work"

// Importing Order also registers every built-in transformer, which is what the first describe
// below reads.
import { validate } from "../src/transformers/Order"

describe("TransformerRegistry", () => {
    describe("built-in registration", () => {
        test("built-in transformers are pre-registered", () => {
            expect(isRegistered("MakeChoice")).toBe(true)
            expect(isRegistered("ApproximateLogarithmicTempo")).toBe(true)
            expect(isRegistered("InsertArticulation")).toBe(true)
            expect(isRegistered("InsertPedal")).toBe(true)
            expect(isRegistered("CombineAdjacentRubatos")).toBe(true)
            expect(isRegistered("StylizeArticulation")).toBe(true)
            expect(isRegistered("InsertMetadata")).toBe(true)
        })

        test("getTransformerOrder returns all built-in names in correct relative order", () => {
            const order = getTransformerOrder()
            expect(order.length).toBeGreaterThanOrEqual(16)
            expect(order.indexOf("MakeChoice")).toBeLessThan(order.indexOf("ApproximateLogarithmicTempo"))
            expect(order.indexOf("ApproximateLogarithmicTempo")).toBeLessThan(order.indexOf("InsertPedal"))
        })
    })

    describe("createTransformer", () => {
        test("creates a known transformer", () => {
            const t = createTransformer("InsertRubato")
            expect(t).not.toBeNull()
            expect(t!.name).toBe("InsertRubato")
        })

        test("returns null for unknown name", () => {
            expect(createTransformer("NonExistentTransformer")).toBeNull()
        })
    })

    describe("roundtrip through importWork/exportWork", () => {
        test("transformer survives serialization roundtrip", () => {
            // A work file records a call as its name and its options, and `importWork` rebuilds
            // it through the registry — so the roundtrip holds exactly as long as the name is
            // registered under the spelling the file uses.
            const transformer = createTransformer("ApproximateLogarithmicTempo")!
            transformer.options = {
                scope: 'global',
                from: 0,
                to: 720,
            }

            const work = { name: "test", mpm: "test.mpm", mei: "test.mei" }
            const json = exportWork(work, [transformer])
            const result = importWork(json)

            expect(result.transformers).toHaveLength(1)
            expect(result.transformers[0].id).toBe(transformer.id)
            expect(result.transformers[0].name).toBe("ApproximateLogarithmicTempo")
            expect(result.transformers[0].options).toEqual(transformer.options)
        })
    })

    describe("renames", () => {
        test("a retired name still builds the transformer that replaced it", () => {
            const transformer = createTransformer("TranslatePhyiscalTimeToTicks")
            expect(transformer).not.toBeNull()
            // The instance carries the *current* name, so an old work file loads into a
            // chain that orders and validates like any other.
            expect(transformer!.name).toBe("TranslatePhysicalTimeToTicks")
        })

        test("the retired name is not itself registered", () => {
            expect(isRegistered("TranslatePhyiscalTimeToTicks")).toBe(false)
            expect(isRegistered("TranslatePhysicalTimeToTicks")).toBe(true)
        })
    })

    describe("custom transformer registration (isolated)", () => {
        test("register with after positioning", () => {
            clearRegistry()

            class Alpha extends AbstractTransformer<TransformationOptions> {
                name = "Alpha"
                requires = []
                constructor() { super({}) }
                protected transform() { /* no-op */ }
            }
            class Beta extends AbstractTransformer<TransformationOptions> {
                name = "Beta"
                requires = []
                constructor() { super({}) }
                protected transform() { /* no-op */ }
            }
            class Custom extends AbstractTransformer<TransformationOptions> {
                name = "Custom"
                requires = []
                constructor() { super({}) }
                protected transform() { /* no-op */ }
            }

            registerTransformer(Alpha)
            registerTransformer(Beta)
            registerTransformer(Custom, { after: "Alpha" })

            const order = getTransformerOrder()
            expect(order).toEqual(["Alpha", "Custom", "Beta"])
        })

        test("register with before positioning", () => {
            clearRegistry()

            class Alpha extends AbstractTransformer<TransformationOptions> {
                name = "Alpha"
                requires = []
                constructor() { super({}) }
                protected transform() { /* no-op */ }
            }
            class Beta extends AbstractTransformer<TransformationOptions> {
                name = "Beta"
                requires = []
                constructor() { super({}) }
                protected transform() { /* no-op */ }
            }
            class Custom extends AbstractTransformer<TransformationOptions> {
                name = "Custom"
                requires = []
                constructor() { super({}) }
                protected transform() { /* no-op */ }
            }

            registerTransformer(Alpha)
            registerTransformer(Beta)
            registerTransformer(Custom, { before: "Beta" })

            const order = getTransformerOrder()
            expect(order).toEqual(["Alpha", "Custom", "Beta"])
        })

        test("re-registration of same name is idempotent", () => {
            clearRegistry()

            class Alpha extends AbstractTransformer<TransformationOptions> {
                name = "Alpha"
                requires = []
                constructor() { super({}) }
                protected transform() { /* no-op */ }
            }

            registerTransformer(Alpha)
            registerTransformer(Alpha)

            expect(getTransformerOrder()).toEqual(["Alpha"])
        })

        test("throws on unknown anchor name", () => {
            clearRegistry()

            class Custom extends AbstractTransformer<TransformationOptions> {
                name = "Custom"
                requires = []
                constructor() { super({}) }
                protected transform() { /* no-op */ }
            }

            expect(() => {
                registerTransformer(Custom, { after: "DoesNotExist" })
            }).toThrow('anchor not found in order')
        })
    })

    // `validate` is the registry read from the other end: what a chain has to look like for the
    // pipeline to be able to order, save and run it. Isolated for the same reason as above.
    describe("validate (isolated)", () => {
        class Alpha extends AbstractTransformer<TransformationOptions> {
            name = "Alpha"
            requires = []
            constructor() { super({}) }
            protected transform() { /* no-op */ }
        }
        class NeedsAlpha extends AbstractTransformer<TransformationOptions> {
            name = "NeedsAlpha"
            requires = [Alpha]
            constructor() { super({}) }
            protected transform() { /* no-op */ }
        }

        test("an unregistered name is reported, with its position in the chain", () => {
            clearRegistry()
            registerTransformer(Alpha)

            class Stranger extends AbstractTransformer<TransformationOptions> {
                name = "Stranger"
                requires = []
                constructor() { super({}) }
                protected transform() { /* no-op */ }
            }

            // Unregistered, so `importWork` would drop it and the chain would run without it
            // saying anything. That silence is what `validate` breaks.
            const messages = validate([new Alpha(), new Stranger()])
            expect(messages).toHaveLength(1)
            expect(messages[0].index).toBe(1)
            expect(messages[0].message).toContain("Stranger")
        })

        test("a requirement is reported only when the chain does not already satisfy it", () => {
            clearRegistry()
            registerTransformer(Alpha)
            registerTransformer(NeedsAlpha)

            expect(validate([new NeedsAlpha()])).toHaveLength(1)
            expect(validate([new Alpha(), new NeedsAlpha()])).toEqual([])
        })

        test("a requirement met only later in the chain is still missing", () => {
            clearRegistry()
            registerTransformer(Alpha)
            registerTransformer(NeedsAlpha)

            // `requires` is about what has already run, not about mere presence.
            expect(validate([new NeedsAlpha(), new Alpha()])).toHaveLength(1)
        })
    })
})
