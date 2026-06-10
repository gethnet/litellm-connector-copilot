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
});
