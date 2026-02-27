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

// Ensure built-in registrations are loaded (side-effect of importing Order)
import "../src/transformers/Order"

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
            const transformer = createTransformer("ApproximateLogarithmicTempo")!
            transformer.options = {
                scope: 'global',
                from: 0,
                to: 720,
            }
            transformer.argumentation = {
                id: "arg-1",
                type: "simpleArgumentation",
                conclusion: {
                    id: "belief-1",
                    motivation: "move",
                    certainty: "plausible"
                }
            }

            const work = { name: "test", mpm: "test.mpm", mei: "test.mei" }
            const json = exportWork(work, [transformer])
            const result = importWork(json)

            expect(result.transformers).toHaveLength(1)
            expect(result.transformers[0].name).toBe("ApproximateLogarithmicTempo")
            expect(result.transformers[0].options).toEqual(transformer.options)
        })
    })

    describe("custom transformer registration (isolated)", () => {
        test("register with after positioning", () => {
            clearRegistry()

            class Alpha extends AbstractTransformer<TransformationOptions> {
                name = "Alpha"
                requires = []
                protected transform() { /* no-op */ }
            }
            class Beta extends AbstractTransformer<TransformationOptions> {
                name = "Beta"
                requires = []
                protected transform() { /* no-op */ }
            }
            class Custom extends AbstractTransformer<TransformationOptions> {
                name = "Custom"
                requires = []
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
                protected transform() { /* no-op */ }
            }
            class Beta extends AbstractTransformer<TransformationOptions> {
                name = "Beta"
                requires = []
                protected transform() { /* no-op */ }
            }
            class Custom extends AbstractTransformer<TransformationOptions> {
                name = "Custom"
                requires = []
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
                protected transform() { /* no-op */ }
            }

            expect(() => {
                registerTransformer(Custom, { after: "DoesNotExist" })
            }).toThrow('anchor not found in order')
        })
    })
})
