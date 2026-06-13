import * as assert from "assert";
import {
    deriveCapabilitiesFromModelInfo,
    getSupportedReasoningEfforts,
    buildReasoningEffortConfigurationSchema,
} from "../modelCapabilities";
import type { LiteLLMModelInfo } from "../../types";

suite("modelCapabilities - Reasoning Overhaul", () => {
    suite("getSupportedReasoningEfforts", () => {
        test("returns empty array when modelInfo is undefined", () => {
            const result = getSupportedReasoningEfforts(undefined, "test-model");
            assert.deepStrictEqual(result, []);
        });

        test("returns empty array when supports_reasoning is explicitly false", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_reasoning: false,
                supported_openai_params: ["stream", "temp"],
            };
            const result = getSupportedReasoningEfforts(modelInfo, "test-model");
            assert.deepStrictEqual(result, []);
        });

        test("extracts explicit reasoning effort fields from LiteLLM", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_high_reasoning_effort: true,
                supports_low_reasoning_effort: true,
                supported_openai_params: ["stream", "reasoning_effort"],
            };
            const result = getSupportedReasoningEfforts(modelInfo, "test-model");
            assert.ok(result.includes("high"));
            assert.ok(result.includes("low"));
        });

        test("treats null values as undefined (not false)", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_reasoning: null, // should be treated as undefined
                supported_openai_params: null, // should be treated as undefined
                supports_high_reasoning_effort: true,
            };
            const result = getSupportedReasoningEfforts(modelInfo, "test-model");
            assert.ok(result.includes("high"));
        });

        test("uses DEFAULT_REASONING_EFFORTS when only supports_reasoning is true", () => {
            // When supports_reasoning is true and supported_openai_params is absent (provider
            // didn't populate the field), fall back to showing the default effort ladder.
            const modelInfo: LiteLLMModelInfo = {
                supports_reasoning: true,
            };
            const result = getSupportedReasoningEfforts(modelInfo, "test-model");
            assert.ok(result.length > 0);
        });

        test("returns default set for models without explicit effort fields", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_reasoning: true,
                supported_openai_params: ["stream", "reasoning_effort"],
            };
            const result = getSupportedReasoningEfforts(modelInfo, "gpt-5-model");
            // Should include the default set
            assert.ok(result.includes("medium"));
        });
    });

    suite("deriveCapabilitiesFromModelInfo", () => {
        test("detects tools from supported_openai_params", () => {
            const modelInfo: LiteLLMModelInfo = {
                supported_openai_params: ["tools", "tool_choice"],
            };
            const result = deriveCapabilitiesFromModelInfo("test-model", modelInfo);
            assert.strictEqual(result.supportsTools, true);
        });

        test("detects tools from sparse flags even when supported_openai_params is empty", () => {
            const modelInfo: LiteLLMModelInfo = {
                supported_openai_params: [],
                supports_function_calling: true,
                supports_tool_choice: true,
            };
            const result = deriveCapabilitiesFromModelInfo("test-model", modelInfo);
            assert.strictEqual(result.supportsTools, true);
        });

        test("detects streaming from supported_openai_params", () => {
            const modelInfo: LiteLLMModelInfo = {
                supported_openai_params: ["stream", "temperature"],
            };
            const result = deriveCapabilitiesFromModelInfo("test-model", modelInfo);
            assert.strictEqual(result.supportsStreaming, true);
        });

        test("detects reasoning from explicit effort fields", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_high_reasoning_effort: true,
                supported_openai_params: ["stream"],
            };
            const result = deriveCapabilitiesFromModelInfo("test-model", modelInfo);
            assert.strictEqual(result.supportsReasoning, true);
        });

        test("handles empty supported_openai_params array", () => {
            const modelInfo: LiteLLMModelInfo = {
                supported_openai_params: [],
            };
            const result = deriveCapabilitiesFromModelInfo("test-model", modelInfo);
            assert.strictEqual(result.supportsTools, false); // tools not in empty array
        });
    });

    suite("buildReasoningEffortConfigurationSchema", () => {
        test("returns undefined for empty efforts array", () => {
            const result = buildReasoningEffortConfigurationSchema([], "test-model");
            assert.strictEqual(result, undefined);
        });

        test("returns schema with correct group: navigation", () => {
            const result = buildReasoningEffortConfigurationSchema(["low", "medium", "high"], "test-model");
            assert.ok(result);
            assert.strictEqual(result?.properties.reasoningEffort.group, "navigation");
        });

        test("includes enumDescriptions for each effort", () => {
            const result = buildReasoningEffortConfigurationSchema(["low", "medium", "high"], "test-model");
            assert.ok(result);
            assert.ok(result?.properties.reasoningEffort.enumDescriptions);
            assert.strictEqual(result?.properties.reasoningEffort.enumDescriptions.length, 3);
        });
    });
});
