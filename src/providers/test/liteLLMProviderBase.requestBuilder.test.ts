import * as vscode from "vscode";
import * as sinon from "sinon";
import * as assert from "assert";
import { RequestBuilder } from "../base/requestBuilder";
import { ConfigManager } from "../../config/configManager";
import type { LiteLLMModelInfo } from "../../types";

suite("RequestBuilder", () => {
    let sandbox: sinon.SinonSandbox;
    let configManager: sinon.SinonStubbedInstance<ConfigManager>;
    let builder: RequestBuilder;

    setup(() => {
        sandbox = sinon.createSandbox();
        configManager = sandbox.createStubInstance(ConfigManager);
        builder = new RequestBuilder({
            configManager,
            getReasoningEffort: () => undefined,
            detectQuotaToolRedaction: (messages, tools) => ({ tools, confidence: "none" as const }),
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: () => true,
            getTelemetryOptions: () => ({ caller: "test", justification: undefined, modelConfiguration: {} }),
            usageOptOutModels: new Set(),
            extractRawModelName: (id: string) => {
                // Test mirror of `LiteLLMProviderRegistry.extractRawName`:
                // strip everything up to and including the first `/`.
                const slash = id.indexOf("/");
                return slash < 0 ? id : id.slice(slash + 1);
            },
        });
    });

    teardown(() => sandbox.restore());

    test("buildOpenAIChatRequest caps max_tokens to model maxOutputTokens", async () => {
        configManager.getConfig.resolves({});
        const model = { id: "gpt-x", maxInputTokens: 100, maxOutputTokens: 50 } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        const req = await builder.buildOpenAIChatRequest(
            messages,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            undefined,
            "caller"
        );
        sinon.assert.match(req.max_tokens, 50);
        sinon.assert.match(req.stream, true);
    });

    test("buildOpenAIChatRequest attaches top-level cache_control for eligible cards without markers", async () => {
        configManager.getConfig.resolves({});
        const model = {
            id: "anthropic/claude-opus-5",
            maxInputTokens: 100,
            maxOutputTokens: 50,
        } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("reuse this prefix")],
                name: undefined,
            },
        ];

        const request = await builder.buildOpenAIChatRequest(
            messages,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            { supported_openai_params: ["cache_control"] }
        );

        assert.deepStrictEqual(request.cache_control, { type: "ephemeral" });
        assert.ok(!JSON.stringify(request.messages).includes("cache_control"));
    });

    test("V1 and V2 builders share the cache_control eligibility gate", async () => {
        configManager.getConfig.resolves({});
        const model = {
            id: "anthropic/claude-opus-5",
            maxInputTokens: 100,
            maxOutputTokens: 50,
        } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("same request")],
                name: undefined,
            },
        ];
        const options = { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions;

        const [v1Request, v2Request] = await Promise.all([
            builder.buildOpenAIChatRequest(messages, model, options, { supported_openai_params: ["cache_control"] }),
            builder.buildV2ChatRequest(messages as never, model, options, { supported_openai_params: ["cache_control"] }),
        ]);

        assert.deepStrictEqual(v1Request.cache_control, { type: "ephemeral" });
        assert.deepStrictEqual(v2Request.cache_control, { type: "ephemeral" });
    });

    test("buildOpenAIChatRequest leaves cards without cache_control unstamped", async () => {
        configManager.getConfig.resolves({});
        const model = { id: "bedrock/claude", maxInputTokens: 100, maxOutputTokens: 50 } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("do not cache")],
                name: undefined,
            },
        ];

        const request = await builder.buildOpenAIChatRequest(
            messages,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            { supports_prompt_caching: true }
        );

        assert.strictEqual(request.cache_control, undefined);
        assert.ok(!JSON.stringify(request.messages).includes("cache_control"));
    });

    test("buildOpenAIChatRequest omits Path 1 after four explicit cache markers", async () => {
        configManager.getConfig.resolves({});
        const model = {
            id: "anthropic/claude-opus-5",
            maxInputTokens: 100,
            maxOutputTokens: 50,
        } as vscode.LanguageModelChatInformation;
        const messages = Array.from({ length: 4 }, (_, index) => ({
            role: vscode.LanguageModelChatMessageRole.User,
            content: [
                new vscode.LanguageModelTextPart(`message ${index}`),
                new vscode.LanguageModelDataPart(Buffer.from("ephemeral"), "cache_control"),
            ],
            name: undefined,
        }));

        const request = await builder.buildOpenAIChatRequest(
            messages,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            { supported_openai_params: ["cache_control"] }
        );

        assert.strictEqual(request.cache_control, undefined);
        const explicitCount = request.messages.flatMap((message) =>
            Array.isArray(message.content) ? message.content.filter((content) => content.cache_control !== undefined) : []
        ).length;
        assert.strictEqual(explicitCount, 4);
    });

    test("buildV2ChatRequest preserves tool_choice", async () => {
        configManager.getConfig.resolves({});
        const model = { id: "gpt-v2", maxInputTokens: 100, maxOutputTokens: 20 } as vscode.LanguageModelChatInformation;
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];
        const modelInfo = { mode: "chat" } as LiteLLMModelInfo;

        const req = await builder.buildV2ChatRequest(
            messages as never,
            model,
            {
                modelOptions: {},
                toolMode: vscode.LanguageModelChatToolMode.Required,
                tools: [{ name: "test_tool", description: "desc", inputSchema: {} }],
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            modelInfo,
            "caller"
        );

        sinon.assert.match(req.tool_choice, {
            type: "function",
            function: { name: "test_tool" },
        });
    });

    test("buildOpenAIChatRequest injects cache bypass before applying the shared filter", async () => {
        configManager.getConfig.resolves({ disableCaching: true });
        const cacheBypassBuilder = new RequestBuilder({
            configManager,
            getReasoningEffort: () => undefined,
            detectQuotaToolRedaction: (messages, tools) => ({ tools, confidence: "none" as const }),
            stripUnsupportedParametersFromRequest: (body, modelInfo) => {
                const supportedParams = modelInfo?.supported_openai_params;
                if (Array.isArray(supportedParams) && !supportedParams.includes("cache")) {
                    const extraBody = body.extra_body;
                    if (extraBody && typeof extraBody === "object") {
                        delete (extraBody as Record<string, unknown>).cache;
                        if (Object.keys(extraBody).length === 0) {
                            delete body.extra_body;
                        }
                    }
                }
            },
            isParameterSupported: (parameter, modelInfo) => {
                const supportedParams = modelInfo?.supported_openai_params;
                return parameter !== "cache" || !Array.isArray(supportedParams) || supportedParams.includes("cache");
            },
            getTelemetryOptions: () => ({ caller: "test", justification: undefined, modelConfiguration: {} }),
            usageOptOutModels: new Set(),
            extractRawModelName: (id: string) => id,
        });
        const model = {
            id: "cache-capable-model",
            maxInputTokens: 100,
            maxOutputTokens: 50,
        } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        const request = await cacheBypassBuilder.buildOpenAIChatRequest(
            messages,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            { supported_openai_params: ["stream", "cache"] }
        );

        assert.deepStrictEqual(request.extra_body, { cache: { "no-cache": true } });
    });

    test("buildV2ChatRequest removes cache bypass for a model that excludes cache", async () => {
        configManager.getConfig.resolves({ disableCaching: true });
        const cacheBypassBuilder = new RequestBuilder({
            configManager,
            getReasoningEffort: () => undefined,
            detectQuotaToolRedaction: (messages, tools) => ({ tools, confidence: "none" as const }),
            stripUnsupportedParametersFromRequest: (body, modelInfo) => {
                const supportedParams = modelInfo?.supported_openai_params;
                if (Array.isArray(supportedParams) && !supportedParams.includes("cache")) {
                    const extraBody = body.extra_body;
                    if (extraBody && typeof extraBody === "object") {
                        delete (extraBody as Record<string, unknown>).cache;
                        if (Object.keys(extraBody).length === 0) {
                            delete body.extra_body;
                        }
                    }
                }
            },
            isParameterSupported: (parameter, modelInfo) => {
                const supportedParams = modelInfo?.supported_openai_params;
                return parameter !== "cache" || !Array.isArray(supportedParams) || supportedParams.includes("cache");
            },
            getTelemetryOptions: () => ({ caller: "test", justification: undefined, modelConfiguration: {} }),
            usageOptOutModels: new Set(),
            extractRawModelName: (id: string) => id,
        });
        const model = {
            id: "azure_ai/gpt-5.4-mini",
            maxInputTokens: 100,
            maxOutputTokens: 50,
        } as vscode.LanguageModelChatInformation;
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        const request = await cacheBypassBuilder.buildV2ChatRequest(
            messages as never,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            { supported_openai_params: ["stream"] }
        );

        assert.strictEqual(request.extra_body, undefined);
    });

    test("buildOpenAIChatRequest serializes an explicitly selected none effort", async () => {
        configManager.getConfig.resolves({});
        const noneBuilder = new RequestBuilder({
            configManager,
            getReasoningEffort: () => "none",
            detectQuotaToolRedaction: (messages, tools) => ({ tools, confidence: "none" as const }),
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: (param: string) => param === "reasoning_effort",
            getTelemetryOptions: () => ({ caller: "test", justification: undefined, modelConfiguration: {} }),
            usageOptOutModels: new Set(),
            extractRawModelName: (id: string) => id,
        });
        const model = { id: "gpt-5", maxInputTokens: 100, maxOutputTokens: 50 } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        const request = await noneBuilder.buildOpenAIChatRequest(
            messages,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            { supported_openai_params: ["reasoning_effort"] },
            "test"
        );

        assert.strictEqual(request.reasoning_effort, "none");
    });

    test("buildOpenAIChatRequest emits adaptive fields for an affected Claude route", async () => {
        configManager.getConfig.resolves({});
        const adaptiveBuilder = new RequestBuilder({
            configManager,
            getReasoningEffort: () => "high",
            detectQuotaToolRedaction: (messages, tools) => ({ tools, confidence: "none" as const }),
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: (parameter, modelInfo) =>
                modelInfo?.supported_openai_params?.includes(parameter) === true,
            getTelemetryOptions: () => ({ caller: "test", justification: undefined, modelConfiguration: {} }),
            usageOptOutModels: new Set(),
            extractRawModelName: (id: string) => id,
        });
        const model = {
            id: "vertex_ai/claude-opus-4-8",
            maxInputTokens: 100_000,
            maxOutputTokens: 8_192,
        } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        const request = await adaptiveBuilder.buildOpenAIChatRequest(
            messages,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            { supported_openai_params: ["reasoning_effort", "thinking"] },
            "test"
        );

        assert.strictEqual(request.reasoning_effort, undefined);
        assert.deepStrictEqual(request.thinking, { type: "adaptive", display: "summarized" });
        assert.deepStrictEqual(request.output_config, { effort: "high" });
    });

    test("buildOpenAIChatRequest keeps Opus 4.7 on flat reasoning_effort", async () => {
        configManager.getConfig.resolves({});
        const standardBuilder = new RequestBuilder({
            configManager,
            getReasoningEffort: () => "high",
            detectQuotaToolRedaction: (messages, tools) => ({ tools, confidence: "none" as const }),
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: (parameter, modelInfo) =>
                modelInfo?.supported_openai_params?.includes(parameter) === true,
            getTelemetryOptions: () => ({ caller: "test", justification: undefined, modelConfiguration: {} }),
            usageOptOutModels: new Set(),
            extractRawModelName: (id: string) => id,
        });
        const model = {
            id: "anthropic/claude-opus-4-7",
            maxInputTokens: 100_000,
            maxOutputTokens: 8_192,
        } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        const request = await standardBuilder.buildOpenAIChatRequest(
            messages,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            { supported_openai_params: ["reasoning_effort", "thinking"] },
            "test"
        );

        assert.strictEqual(request.reasoning_effort, "high");
        assert.strictEqual(request.thinking, undefined);
        assert.strictEqual(request.output_config, undefined);
    });

    test("buildV2ChatRequest omits none when reasoning_effort is unsupported", async () => {
        configManager.getConfig.resolves({});
        const noneBuilder = new RequestBuilder({
            configManager,
            getReasoningEffort: () => "none",
            detectQuotaToolRedaction: (messages, tools) => ({ tools, confidence: "none" as const }),
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: (param: string) => param !== "reasoning_effort",
            getTelemetryOptions: () => ({ caller: "test", justification: undefined, modelConfiguration: {} }),
            usageOptOutModels: new Set(),
            extractRawModelName: (id: string) => id,
        });
        const model = { id: "gpt-5", maxInputTokens: 100, maxOutputTokens: 50 } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        const request = await noneBuilder.buildV2ChatRequest(
            messages as never,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            { supported_openai_params: ["stream"] },
            "test"
        );

        assert.strictEqual(request.reasoning_effort, undefined);
    });

    test("buildOpenAIChatRequest omits tool_choice when not supported by model", async () => {
        // Create a builder where isParameterSupported returns false for tool_choice
        const builderWithGating = new RequestBuilder({
            configManager,
            getReasoningEffort: () => undefined,
            detectQuotaToolRedaction: (messages, tools) => ({ tools, confidence: "none" as const }),
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: (param: string) => param !== "tool_choice", // tool_choice not supported
            getTelemetryOptions: () => ({ caller: "test", justification: undefined, modelConfiguration: {} }),
            usageOptOutModels: new Set(),
            extractRawModelName: (id: string) => {
                const slash = id.indexOf("/");
                return slash < 0 ? id : id.slice(slash + 1);
            },
        });

        configManager.getConfig.resolves({});
        const model = {
            id: "azure/gpt-5.6",
            maxInputTokens: 100000,
            maxOutputTokens: 4096,
        } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("test")],
                name: undefined,
            },
        ];
        const modelInfo = { model: "gpt-5.6", supported_openai_params: ["tools"] } as LiteLLMModelInfo;

        const req = await builderWithGating.buildOpenAIChatRequest(
            messages,
            model,
            {
                tools: [{ name: "tool1", description: "test", inputSchema: {} }],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                modelOptions: {},
                requestInitiator: "test",
            } as vscode.ProvideLanguageModelChatResponseOptions,
            modelInfo,
            "test"
        );

        // tool_choice should be undefined when not supported by model
        assert.strictEqual(req.tool_choice, undefined);
    });

    test("buildOpenAIChatRequest adds tool_choice: auto when supported and tools present", async () => {
        configManager.getConfig.resolves({});
        const model = {
            id: "openai/gpt-4",
            maxInputTokens: 100000,
            maxOutputTokens: 4096,
        } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("test")],
                name: undefined,
            },
        ];
        const modelInfo = { model: "gpt-4", supported_openai_params: ["tools", "tool_choice"] } as LiteLLMModelInfo;

        const req = await builder.buildOpenAIChatRequest(
            messages,
            model,
            {
                tools: [{ name: "tool1", description: "test", inputSchema: {} }],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                modelOptions: {},
                requestInitiator: "test",
            } as vscode.ProvideLanguageModelChatResponseOptions,
            modelInfo,
            "test"
        );

        // tool_choice should be "auto" when model supports it and tools are present
        assert.strictEqual(req.tool_choice, "auto");
    });
});
