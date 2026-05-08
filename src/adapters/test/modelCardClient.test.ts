import * as assert from "assert";
import * as sinon from "sinon";
import { ModelCardClient } from "../modelCardClient";

suite("ModelCardClient Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;
    const baseUrl = "http://localhost:4000";
    const apiKey = "test-api-key";
    const userAgent = "test-agent";

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("getModelFeatures returns cached data if available", async () => {
        const client = new ModelCardClient(baseUrl, apiKey, userAgent);

        // Pre-populate cache
        (client as unknown as { cache: Map<string, { data: unknown; expiresAt: number }> }).cache.set("test-model", {
            data: {
                supportedParams: new Set(["max_tokens"]),
                supportsSystemMessages: true,
                supportsVision: false,
                supportsTools: false,
                supportsReasoning: false,
                supportsPromptCaching: false,
                supportsNativeStreaming: true,
                supportsResponseSchema: false,
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
            },
            expiresAt: Date.now() + 60000,
        });

        const features = await client.getModelFeatures("test-model");

        assert.strictEqual(features.supportedParams.has("max_tokens"), true);
        assert.strictEqual(features.supportsSystemMessages, true);
    });

    test("getModelFeatures fetches from LiteLLM on cache miss", async () => {
        const client = new ModelCardClient(baseUrl, apiKey, userAgent);

        const mockResponse = {
            model_name: "gpt-4",
            model_info: {
                supported_openai_params: ["max_tokens", "temperature"],
                supports_system_messages: true,
                supports_vision: false,
                supports_function_calling: true,
                supports_reasoning: false,
                supports_prompt_caching: true,
                supports_native_streaming: true,
                supports_response_schema: false,
                max_input_tokens: 8000,
                max_output_tokens: 4000,
            },
            litellm_params: {},
            provider: "openai",
            input_cost: "0.01",
            output_cost: "0.03",
            max_tokens: 4000,
            max_input_tokens: 8000,
        };

        const fetchStub = sandbox.stub(globalThis, "fetch").resolves({
            ok: true,
            json: () => Promise.resolve(mockResponse),
        } as unknown as Response);

        const features = await client.getModelFeatures("gpt-4");

        assert.strictEqual(fetchStub.calledOnce, true);
        assert.strictEqual(features.supportedParams.has("temperature"), true);
        assert.strictEqual(features.supportsSystemMessages, true);
        assert.strictEqual(features.supportsTools, true);
        assert.strictEqual(features.maxInputTokens, 8000);
    });

    test("getModelFeatures uses fallback on fetch failure", async () => {
        const client = new ModelCardClient(baseUrl, apiKey, userAgent);

        sandbox.stub(globalThis, "fetch").rejects(new Error("Network error"));

        const features = await client.getModelFeatures("unknown-model");

        assert.strictEqual(features.supportedParams.has("max_tokens"), true);
        // Should return conservative defaults
        assert.strictEqual(features.supportedParams.has("max_tokens"), true);
        assert.strictEqual(features.supportedParams.has("temperature"), true);
    });

    test("getModelFeatures parses reasoning efforts", async () => {
        const client = new ModelCardClient(baseUrl, apiKey, userAgent);

        const mockResponse = {
            model_name: "o1-preview",
            model_info: {
                supported_openai_params: ["max_tokens"],
                supports_system_messages: false,
                supports_reasoning: true,
                supports_minimal_reasoning_effort: true,
                supports_high_reasoning_effort: true,
            },
            litellm_params: {},
            provider: "openai",
            input_cost: "0.01",
            output_cost: "0.03",
            max_tokens: 100000,
            max_input_tokens: 200000,
        };

        sandbox.stub(globalThis, "fetch").resolves({
            ok: true,
            json: () => Promise.resolve(mockResponse),
        } as unknown as Response);

        const features = await client.getModelFeatures("o1-preview");

        assert.strictEqual(features.supportsReasoning, true);
        assert.deepStrictEqual(features.supportedReasoningEfforts, ["minimal", "high"]);
    });

    test("clearCache removes all cached entries", async () => {
        const client = new ModelCardClient(baseUrl, apiKey, userAgent);

        // Pre-populate cache
        (client as unknown as { cache: Map<string, { data: unknown; expiresAt: number }> }).cache.set("model-1", {
            data: {
                supportedParams: new Set(["max_tokens"]),
                supportsSystemMessages: true,
                supportsVision: false,
                supportsTools: false,
                supportsReasoning: false,
                supportsPromptCaching: false,
                supportsNativeStreaming: true,
                supportsResponseSchema: false,
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
            },
            expiresAt: Date.now() + 60000,
        });
        (client as unknown as { cache: Map<string, { data: unknown; expiresAt: number }> }).cache.set("model-2", {
            data: {
                supportedParams: new Set(["temperature"]),
                supportsSystemMessages: true,
                supportsVision: false,
                supportsTools: false,
                supportsReasoning: false,
                supportsPromptCaching: false,
                supportsNativeStreaming: true,
                supportsResponseSchema: false,
                maxInputTokens: 2000,
                maxOutputTokens: 2000,
            },
            expiresAt: Date.now() + 60000,
        });

        client.clearCache();

        const cache = (client as unknown as { cache: Map<string, { data: unknown; expiresAt: number }> }).cache;
        assert.strictEqual(cache.size, 0);
    });

    test("isCached returns correct status", async () => {
        const client = new ModelCardClient(baseUrl, apiKey, userAgent);

        // Pre-populate cache with expired entry
        (client as unknown as { cache: Map<string, { data: unknown; expiresAt: number }> }).cache.set("expired-model", {
            data: {
                supportedParams: new Set(["max_tokens"]),
                supportsSystemMessages: true,
                supportsVision: false,
                supportsTools: false,
                supportsReasoning: false,
                supportsPromptCaching: false,
                supportsNativeStreaming: true,
                supportsResponseSchema: false,
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
            },
            expiresAt: Date.now() - 1000, // Expired
        });

        assert.strictEqual(client.isCached("nonexistent"), false);
        assert.strictEqual(client.isCached("expired-model"), false);
    });

    test("ModelCardClient throws error without baseUrl", () => {
        assert.throws(() => {
            new ModelCardClient("", apiKey, userAgent);
        }, /baseUrl/);
    });
});
