import * as assert from "assert";
import { REASONING_EFFORT_DEFAULT, resolveReasoningEffort, type ReasoningEffort } from "../reasoningDefaults";

suite("reasoningDefaults", () => {
    test("hardcoded default is 'medium'", () => {
        // Phase 1: hardcoded. Phase 3 replaces with config-backed lookup.
        assert.strictEqual(REASONING_EFFORT_DEFAULT, "medium");
    });

    test("returns undefined when model does not support reasoning", () => {
        const result = resolveReasoningEffort({
            modelId: "gpt-4o",
            supportsReasoning: false,
            supportedEfforts: undefined,
            callerOverride: undefined,
        });
        assert.strictEqual(result, undefined);
    });

    test("returns hardcoded default when model supports reasoning and no override", () => {
        const result = resolveReasoningEffort({
            modelId: "gpt-5.1-codex-max",
            supportsReasoning: true,
            supportedEfforts: undefined,
            callerOverride: undefined,
        });
        assert.strictEqual(result, "medium");
    });

    test("caller override wins over default", () => {
        const result = resolveReasoningEffort({
            modelId: "gpt-5.3-codex",
            supportsReasoning: true,
            supportedEfforts: undefined,
            callerOverride: "high",
        });
        assert.strictEqual(result, "high");
    });

    test("invalid caller override falls back to default", () => {
        const result = resolveReasoningEffort({
            modelId: "gpt-5.3-codex",
            supportsReasoning: true,
            supportedEfforts: undefined,
            callerOverride: "ultra" as unknown as ReasoningEffort,
        });
        assert.strictEqual(result, "medium");
    });

    test("clamps default to nearest supported effort when default not allowed", () => {
        // Model card reports only ["minimal", "high"]; default "medium" must clamp.
        const result = resolveReasoningEffort({
            modelId: "gpt-5.1-codex-max",
            supportsReasoning: true,
            supportedEfforts: ["minimal", "high"],
            callerOverride: undefined,
        });
        // "medium" is between minimal and high; we prefer the higher tier (closer to default budget).
        assert.strictEqual(result, "high");
    });

    test("clamp also applies to caller override", () => {
        const result = resolveReasoningEffort({
            modelId: "gpt-5.1-codex-max",
            supportsReasoning: true,
            supportedEfforts: ["minimal", "high"],
            callerOverride: "low",
        });
        assert.strictEqual(result, "minimal");
    });

    test("returns default unchanged when supported list includes it", () => {
        const result = resolveReasoningEffort({
            modelId: "gpt-5.1-codex-max",
            supportsReasoning: true,
            supportedEfforts: ["minimal", "low", "medium", "high"],
            callerOverride: undefined,
        });
        assert.strictEqual(result, "medium");
    });
});
