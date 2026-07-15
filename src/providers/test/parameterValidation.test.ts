import * as assert from "assert";
import { LiteLLMProviderBase } from "../liteLLMProviderBase";
import type { LiteLLMModelInfo } from "../../types";
import { createMockSecrets } from "../../test/utils/testMocks";

suite("Parameter Validation from supported_openai_params", () => {
    // Create a concrete implementation for testing
    class TestableLiteLLMProvider extends LiteLLMProviderBase {
        constructor() {
            super(createMockSecrets({}), "test-agent");
        }

        public testIsParameterSupported(
            param: string,
            modelInfo: LiteLLMModelInfo | undefined,
            modelId?: string
        ): boolean {
            return this.isParameterSupported(param, modelInfo, modelId);
        }
    }

    const provider = new TestableLiteLLMProvider();

    test("returns true when supported_openai_params includes parameter", () => {
        const modelInfo: LiteLLMModelInfo = {
            supported_openai_params: ["temperature", "top_p", "stream"],
        };
        const result = provider.testIsParameterSupported("temperature", modelInfo, "test-model");
        assert.strictEqual(result, true);
    });

    test("returns false for unlisted parameters with restrictable flag", () => {
        const modelInfo: LiteLLMModelInfo = {
            supported_openai_params: ["stream"], // no temperature
        };
        const result = provider.testIsParameterSupported("temperature", modelInfo, "test-model");
        // temperature is restrictable, should return false when not in list
        assert.strictEqual(result, false);
    });

    test("returns true for unlisted non-restrictable parameters", () => {
        const modelInfo: LiteLLMModelInfo = {
            supported_openai_params: ["stream"],
        };
        const result = provider.testIsParameterSupported("user", modelInfo, "test-model");
        // user is not restrictable, should return true
        assert.strictEqual(result, true);
    });

    test("falls back to KNOWN_PARAMETER_LIMITATIONS when no model info", () => {
        // o1- prefix should block temperature
        const result = provider.testIsParameterSupported("temperature", undefined, "o1-preview");
        assert.strictEqual(result, false);
    });

    test("handles null supported_openai_params as undefined", () => {
        const modelInfo: LiteLLMModelInfo = {
            supported_openai_params: null, // null should be treated as undefined
        };
        const result = provider.testIsParameterSupported("temperature", modelInfo, "test-model");
        // No restriction info, should default to true
        assert.strictEqual(result, true);
    });

    test("empty array means no explicit support", () => {
        const modelInfo: LiteLLMModelInfo = {
            supported_openai_params: [],
        };
        const result = provider.testIsParameterSupported("tools", modelInfo, "test-model");
        // tools not in empty array, should return false for restrictable tools param equivalent
        assert.strictEqual(result, false);
    });

    test("reasoning_effort is restrictable and requires explicit support", () => {
        const modelInfo: LiteLLMModelInfo = {
            supported_openai_params: ["temperature", "top_p", "stream"],
        };
        const result = provider.testIsParameterSupported("reasoning_effort", modelInfo, "test-model");
        // reasoning_effort is restrictable, should return false when not in supported_openai_params
        assert.strictEqual(result, false);
    });

    test("reasoning_effort is supported when listed in supported_openai_params", () => {
        const modelInfo: LiteLLMModelInfo = {
            supported_openai_params: ["temperature", "reasoning_effort", "stream"],
        };
        const result = provider.testIsParameterSupported("reasoning_effort", modelInfo, "test-model");
        // reasoning_effort is listed, should return true
        assert.strictEqual(result, true);
    });

    test("keeps reasoning_effort restricted when explicit effort metadata exists but the parameter is absent", () => {
        const modelInfo: LiteLLMModelInfo = {
            supports_reasoning: true,
            supports_xhigh_reasoning_effort: true,
            supported_openai_params: ["stream"],
        };
        const result = provider.testIsParameterSupported("reasoning_effort", modelInfo, "gpt-5.4-mini");

        assert.strictEqual(result, false);
    });

    test("reasoning_effort defaults to true when supported_openai_params is undefined", () => {
        const result = provider.testIsParameterSupported("reasoning_effort", undefined, "test-model");
        // Without supported_openai_params the parameter is allowed
        assert.strictEqual(result, true);
    });

    test("cache is restrictable and requires explicit support", () => {
        const modelInfo: LiteLLMModelInfo = {
            supported_openai_params: ["stream", "temperature"],
        };

        assert.strictEqual(provider.testIsParameterSupported("cache", modelInfo, "azure_ai/gpt-4o-mini"), false);
    });

    test("cache is supported when listed in supported_openai_params", () => {
        const modelInfo: LiteLLMModelInfo = {
            supported_openai_params: ["stream", "cache"],
        };

        assert.strictEqual(provider.testIsParameterSupported("cache", modelInfo, "cache-capable-model"), true);
    });

    test("cache remains allowed when supported_openai_params is unavailable", () => {
        assert.strictEqual(provider.testIsParameterSupported("cache", undefined, "legacy-model"), true);
    });

    test("tool_choice is restrictable and requires explicit support", () => {
        const modelInfo: LiteLLMModelInfo = {
            supported_openai_params: ["temperature", "top_p", "stream"],
        };
        const result = provider.testIsParameterSupported("tool_choice", modelInfo, "test-model");
        // tool_choice should be restrictable like temperature/reasoning_effort
        // should return false when not in supported_openai_params
        assert.strictEqual(result, false);
    });

    test("tool_choice is supported when listed in supported_openai_params", () => {
        const modelInfo: LiteLLMModelInfo = {
            supported_openai_params: ["temperature", "tool_choice", "stream"],
        };
        const result = provider.testIsParameterSupported("tool_choice", modelInfo, "test-model");
        // tool_choice is listed, should return true
        assert.strictEqual(result, true);
    });

    test("tool_choice defaults to true when supported_openai_params is undefined", () => {
        const result = provider.testIsParameterSupported("tool_choice", undefined, "test-model");
        // Without supported_openai_params the parameter is allowed (backward compat)
        assert.strictEqual(result, true);
    });

    test("tool_choice returns false for GPT-5.6 Azure models not listing it in supported params", () => {
        const modelInfo: LiteLLMModelInfo = {
            model: "gpt-5.6",
            supported_openai_params: ["tools", "temperature", "top_p"],
        };
        const result = provider.testIsParameterSupported("tool_choice", modelInfo, "gpt-5.6");
        assert.strictEqual(result, false);
    });
});
