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
                supports_reasoning: true,
                supports_high_reasoning_effort: true,
                supports_low_reasoning_effort: true,
                supported_openai_params: ["stream", "reasoning_effort"],
            };
            const result = getSupportedReasoningEfforts(modelInfo, "test-model");
            assert.ok(result.includes("high"));
            assert.ok(result.includes("low"));
        });

        test("extracts all explicitly supported expanded effort fields", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_reasoning: true,
                supports_none_reasoning_effort: true,
                supports_minimal_reasoning_effort: true,
                supports_low_reasoning_effort: true,
                supports_medium_reasoning_effort: true,
                supports_high_reasoning_effort: true,
                supports_xhigh_reasoning_effort: true,
                supports_max_reasoning_effort: true,
                supported_openai_params: ["stream", "reasoning_effort"],
            };

            const result = getSupportedReasoningEfforts(modelInfo, "test-model");

            assert.deepStrictEqual(result, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
        });

        test("preserves only explicitly supported effort fields", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_reasoning: true,
                supports_none_reasoning_effort: true,
                supports_minimal_reasoning_effort: null,
                supports_low_reasoning_effort: null,
                supports_medium_reasoning_effort: null,
                supports_high_reasoning_effort: null,
                supports_xhigh_reasoning_effort: true,
                supports_max_reasoning_effort: null,
                supported_openai_params: ["stream", "reasoning_effort"],
            };

            const result = getSupportedReasoningEfforts(modelInfo, "luna-model");

            assert.deepStrictEqual(result, ["none", "xhigh"]);
        });

        test("does not infer effort support from null fields", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_reasoning: true,
                supports_none_reasoning_effort: null,
                supports_minimal_reasoning_effort: null,
                supports_low_reasoning_effort: null,
                supports_medium_reasoning_effort: null,
                supports_high_reasoning_effort: null,
                supports_xhigh_reasoning_effort: null,
                supports_max_reasoning_effort: null,
                supported_openai_params: ["reasoning_effort"],
            };

            const result = getSupportedReasoningEfforts(modelInfo, "test-model");

            assert.deepStrictEqual(result, ["none", "low", "medium", "high"]);
        });

        test("preserves the baseline behavior for an explicit effort when supports_reasoning is null", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_reasoning: null,
                supports_none_reasoning_effort: true,
                supported_openai_params: ["reasoning_effort"],
            };

            assert.deepStrictEqual(getSupportedReasoningEfforts(modelInfo, "test-model"), ["none"]);
        });

        test("extracts the explicit none reasoning effort field", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_none_reasoning_effort: true,
                supported_openai_params: ["reasoning_effort"],
            };

            const result = getSupportedReasoningEfforts(modelInfo, "test-model");

            assert.deepStrictEqual(result, ["none"]);
        });

        test("does not broaden explicit all-false effort metadata into defaults", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_reasoning: true,
                supports_none_reasoning_effort: false,
                supports_minimal_reasoning_effort: false,
                supports_low_reasoning_effort: false,
                supports_medium_reasoning_effort: false,
                supports_high_reasoning_effort: false,
                supports_xhigh_reasoning_effort: false,
                supports_max_reasoning_effort: false,
                supported_openai_params: ["reasoning_effort"],
            };

            const result = getSupportedReasoningEfforts(modelInfo, "test-model");

            assert.deepStrictEqual(result, []);
        });

        test("uses the four-value generic reasoning fallback", () => {
            const modelInfo: LiteLLMModelInfo = {
                supports_reasoning: true,
                supported_openai_params: ["reasoning_effort"],
            };

            const result = getSupportedReasoningEfforts(modelInfo, "test-model");

            assert.deepStrictEqual(result, ["none", "low", "medium", "high"]);
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
