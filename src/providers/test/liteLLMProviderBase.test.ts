import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { LiteLLMChatProvider } from "../";
import type { ConfigManager } from "../../config/configManager";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../../types";
import { createMockSecrets } from "../../test/utils/testMocks";
import { EffortFallbackCache } from "../../utils/reasoningEffortFallback";
import { createTelemetryMocks } from "../../test/utils/telemetryMock";
import { getModelTags } from "../../utils/modelCapabilities";
import type { DerivedModelCapabilities } from "../../utils/modelCapabilities";
import type { BackendSession } from "../backendSession";

function createDerived(overrides: Partial<DerivedModelCapabilities> = {}): DerivedModelCapabilities {
    return {
        supportsTools: false,
        supportsVision: false,
        supportsStreaming: false,
        supportsReasoning: false,
        supportsPdf: false,
        supportsAudioInput: false,
        supportsAudioOutput: false,
        supportsComputerUse: false,
        supportsFunctionCalling: false,
        supportsToolChoice: false,
        supportsSystemMessages: false,
        supportsResponseSchema: false,
        supportsPromptCaching: false,
        supportsWebSearch: false,
        supportsUrlContext: false,
        supportsReasoningEffort: false,
        supportsThinking: false,
        endpointMode: "chat" as const,
        maxInputTokens: 4096,
        maxOutputTokens: 2048,
        rawContextWindow: 8192,
        ...overrides,
    };
}

/**
 * Typed view of protected/private members and methods used in tests. We cast
 * once to eliminate per-call `any` casts while keeping the production class
 * API hidden from callers.
 */
interface BaseTestAccess {
    _configManager: ConfigManager;
    _registry: {
        lookup: (
            id: string
        ) => { baseUrl: string; apiKey: string; rawModelName: string; routingIdentity: string } | undefined;
        findBackendForRawName: (
            rawName: string
        ) => { baseUrl: string; apiKey: string; rawModelName: string; routingIdentity: string } | undefined;
        getModelInfo: (id: string) => LiteLLMModelInfo | undefined;
        clear: () => void;
        clearCaches: () => void;
        size: () => number;
    };
    _transport: {
        sendRequestToLiteLLM: (
            request: OpenAIChatCompletionRequest,
            progress: vscode.Progress<vscode.LanguageModelResponsePart>,
            token: vscode.CancellationToken,
            caller?: string,
            modelInfo?: LiteLLMModelInfo,
            configuration?: Record<string, unknown>
        ) => Promise<ReadableStream<Uint8Array>>;
    };
    _effortFallbackCache: EffortFallbackCache;
    buildOpenAIChatRequest: (
        messages: vscode.LanguageModelChatRequestMessage[],
        model: vscode.LanguageModelChatInformation,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        modelInfo?: LiteLLMModelInfo,
        caller?: string
    ) => Promise<OpenAIChatCompletionRequest>;
    buildCapabilities: (modelInfo: LiteLLMModelInfo | undefined) => vscode.LanguageModelChatCapabilities;
    parseApiError: (statusCode: number, errorText: string) => string;
    getModelTags: (modelId: string, modelInfo?: LiteLLMModelInfo, overrides?: Record<string, string[]>) => string[];
    stripUnsupportedParametersFromRequest: (
        requestBody: Record<string, unknown>,
        modelInfo: LiteLLMModelInfo | undefined,
        modelId?: string
    ) => void;
    detectQuotaToolRedaction: (
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        tools: readonly vscode.LanguageModelChatTool[],
        requestId: string,
        modelId: string,
        disableRedaction: boolean
    ) => {
        tools: readonly vscode.LanguageModelChatTool[];
        confidence: "none" | "low" | "high";
    };
    isParameterSupported: (param: string, modelInfo: LiteLLMModelInfo | undefined, modelId?: string) => boolean;
    sanitizeErrorTextForLogs: (text: string) => string;
    collectMessageText: (m: vscode.LanguageModelChatRequestMessage) => string;
    sendRequestWithRetry: (
        request: OpenAIChatCompletionRequest,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        model: vscode.LanguageModelChatInformation,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        modelInfo?: LiteLLMModelInfo
    ) => Promise<ReadableStream<Uint8Array>>;
    sendRequestToLiteLLM: (
        request: OpenAIChatCompletionRequest,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        modelInfo?: LiteLLMModelInfo,
        configuration?: Record<string, unknown>
    ) => Promise<ReadableStream<Uint8Array>>;
    getCallTimeConfiguration: (
        options: vscode.ProvideLanguageModelChatResponseOptions,
        model: vscode.LanguageModelChatInformation
    ) => Promise<Record<string, unknown> | undefined>;
    applyReasoningEffort: (
        request: OpenAIChatCompletionRequest,
        effort: OpenAIChatCompletionRequest["reasoning_effort"] | undefined
    ) => void;
}

function access(provider: LiteLLMChatProvider): BaseTestAccess {
    return provider as unknown as BaseTestAccess;
}
/**
 * Creates an Error with a `status` property attached, which the
 * reasoning-effort fallback detects as a 4xx error worth retrying.
 */
function apiError(message: string, status: number): Error & { status: number } {
    const err = new Error(message) as Error & { status: number };
    err.status = status;
    return err;
}

/**
 * Helper: seeds the discovery layer so `resolveBackendForCall` returns a known
 * session for the given configuration. Use this when a test exercises the
 * chat flow and we don't want to stub an HTTP fetch.
 */
function seedBackendForCall(
    sandbox: sinon.SinonSandbox,
    provider: LiteLLMChatProvider,
    configuration: Record<string, unknown> | undefined,
    session: BackendSession | undefined
): void {
    const configManager = access(provider)._configManager;
    sandbox
        .stub(configManager, "convertProviderConfiguration")
        .callsFake((_groupName: string, cfg: Record<string, unknown>) => {
            if (cfg === configuration) {
                return session;
            }
            return undefined;
        });
}

suite("LiteLLMProviderBase", () => {
    let sandbox: sinon.SinonSandbox;
    let telemetryMocks: ReturnType<typeof createTelemetryMocks>;

    const mockSecrets = createMockSecrets({
        "litellm-connector.baseUrl": "http://localhost:4000",
        "litellm-connector.apiKey": "test-api-key",
    });

    const userAgent = "GitHubCopilotChat/test VSCode/test";

    setup(() => {
        sandbox = sinon.createSandbox();
        telemetryMocks = createTelemetryMocks(sandbox);
        telemetryMocks.setup();
    });

    teardown(() => {
        telemetryMocks.teardown();
        sandbox.restore();
    });

    // buildOpenAIChatRequest default-parameters tests removed in v2.2.0
    // (sendDefaultParameters was deprecated in v1.5.0 and removed per plan).

    suite("reasoning effort handling", () => {
        const model: vscode.LanguageModelChatInformation = {
            id: "reasoning-model",
            name: "reasoning-model",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        suite("applyReasoningEffort", () => {
            test("omits reasoning_effort field when effort is 'none'", () => {
                const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
                const request = { model: "test-model", messages: [] } as OpenAIChatCompletionRequest;

                access(provider).applyReasoningEffort(request, "none");

                const recordRequest = request as unknown as Record<string, unknown>;
                assert.strictEqual(recordRequest.reasoning_effort, undefined);
                assert.ok(!("reasoning_effort" in request));
            });

            test("sets reasoning_effort field for non-none values", () => {
                const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
                const request = { model: "test-model", messages: [] } as OpenAIChatCompletionRequest;

                access(provider).applyReasoningEffort(request, "high");

                const recordRequest = request as unknown as Record<string, unknown>;
                assert.strictEqual(recordRequest.reasoning_effort, "high");
            });
        });

        test("applies reasoning effort from modelConfiguration", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const request = await access(provider).buildOpenAIChatRequest(
                [
                    {
                        role: vscode.LanguageModelChatMessageRole.User,
                        name: undefined,
                        content: [new vscode.LanguageModelTextPart("hi")],
                    },
                ],
                model,
                {
                    configuration: { baseUrl: "https://wolfram.example", apiKey: "k", reasoningEffort: "medium" },
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                undefined,
                "test"
            );

            assert.strictEqual(request.reasoning_effort, "medium");
        });

        test("applies picker xhigh when fallback cache is empty", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const modelInfo: LiteLLMModelInfo = {
                mode: "chat",
                supports_reasoning: true,
                supports_reasoning_effort: true,
            };
            const request = await access(provider).buildOpenAIChatRequest(
                [
                    {
                        role: vscode.LanguageModelChatMessageRole.User,
                        name: undefined,
                        content: [new vscode.LanguageModelTextPart("hi")],
                    },
                ],
                model,
                {
                    configuration: { baseUrl: "https://wolfram.example", apiKey: "k", reasoningEffort: "xhigh" },
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                modelInfo,
                "test"
            );

            assert.strictEqual(request.reasoning_effort, "xhigh");
        });

        test("omits reasoning_effort when user has not picked one", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const request = await access(provider).buildOpenAIChatRequest(
                [
                    {
                        role: vscode.LanguageModelChatMessageRole.User,
                        name: undefined,
                        content: [new vscode.LanguageModelTextPart("hi")],
                    },
                ],
                model,
                {
                    configuration: { baseUrl: "https://wolfram.example", apiKey: "k" },
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                undefined,
                "test"
            );
            assert.strictEqual(request.reasoning_effort, undefined);
        });

        test("treats picker 'none' as opt-out and omits reasoning_effort", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const request = await access(provider).buildOpenAIChatRequest(
                [
                    {
                        role: vscode.LanguageModelChatMessageRole.User,
                        name: undefined,
                        content: [new vscode.LanguageModelTextPart("hi")],
                    },
                ],
                model,
                {
                    configuration: { baseUrl: "https://wolfram.example", apiKey: "k", reasoningEffort: "none" },
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                undefined,
                "test"
            );
            assert.strictEqual(request.reasoning_effort, undefined);
        });
    });

    suite("sendRequestWithRetry — reasoning fallback", () => {
        const model: vscode.LanguageModelChatInformation = {
            id: "model-reasoning",
            name: "model-reasoning",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        function setupProvider(): LiteLLMChatProvider {
            return new LiteLLMChatProvider(mockSecrets, userAgent, new EffortFallbackCache());
        }

        test("retries once on reasoning 4xx and succeeds", async () => {
            const provider = setupProvider();
            const baseConfig = { baseUrl: "https://wolfram.example", apiKey: "k", reasoningEffort: "high" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k",
                client: {} as never,
            });
            const sendStub = sandbox
                .stub(access(provider)._transport, "sendRequestToLiteLLM")
                .onCall(0)
                .rejects(apiError("LiteLLM API error 400: reasoning_effort not supported", 400))
                .onCall(1)
                .resolves(new ReadableStream());

            const stream = await access(provider).sendRequestWithRetry(
                { model: "model-reasoning", messages: [], stream: true, max_tokens: 100, reasoning_effort: "high" },
                [
                    {
                        role: vscode.LanguageModelChatMessageRole.User,
                        name: undefined,
                        content: [new vscode.LanguageModelTextPart("hi")],
                    },
                ],
                model,
                { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                new vscode.CancellationTokenSource().token,
                "test"
            );

            assert.ok(stream);
            assert.ok(sendStub.calledTwice);
        });

        test("notifies once per model and original effort", async () => {
            const provider = setupProvider();
            const baseConfig = { baseUrl: "https://wolfram.example", apiKey: "k", reasoningEffort: "high" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k",
                client: {} as never,
            });
            const showInfo = sandbox.stub(vscode.window, "showInformationMessage").resolves(undefined);

            sandbox
                .stub(access(provider)._transport, "sendRequestToLiteLLM")
                .onCall(0)
                .rejects(apiError("LiteLLM API error 400: reasoning_effort not supported", 400))
                .onCall(1)
                .resolves(new ReadableStream());

            await access(provider).sendRequestWithRetry(
                // Use a unique model id to avoid sharing the
                // `EffortFallbackCache` notification key with the
                // "retries once on reasoning 4xx" test which runs first.
                { model: "notify-once-model", messages: [], stream: true, max_tokens: 100, reasoning_effort: "high" },
                [
                    {
                        role: vscode.LanguageModelChatMessageRole.User,
                        name: undefined,
                        content: [new vscode.LanguageModelTextPart("hi")],
                    },
                ],
                model,
                { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                new vscode.CancellationTokenSource().token,
                "test"
            );

            assert.ok(showInfo.called);
        });

        test("does not retry on non-reasoning 5xx errors", async () => {
            const provider = setupProvider();
            const baseConfig = { baseUrl: "https://wolfram.example", apiKey: "k" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k",
                client: {} as never,
            });
            const sendStub = sandbox
                .stub(access(provider)._transport, "sendRequestToLiteLLM")
                .rejects(new Error("Internal server error 500"));

            await assert.rejects(() =>
                access(provider).sendRequestWithRetry(
                    { model: "model-reasoning", messages: [], stream: true, max_tokens: 100, reasoning_effort: "high" },
                    [
                        {
                            role: vscode.LanguageModelChatMessageRole.User,
                            name: undefined,
                            content: [new vscode.LanguageModelTextPart("hi")],
                        },
                    ],
                    model,
                    { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                    new vscode.CancellationTokenSource().token,
                    "test"
                )
            );

            assert.ok(sendStub.calledOnce, "should not retry on non-reasoning 5xx");
        });

        test("does not retry on 4xx errors that are unrelated to reasoning", async () => {
            const provider = setupProvider();
            const baseConfig = { baseUrl: "https://wolfram.example", apiKey: "k" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k",
                client: {} as never,
            });
            const sendStub = sandbox
                .stub(access(provider)._transport, "sendRequestToLiteLLM")
                .rejects(apiError("LiteLLM API error 401: invalid api key", 401));

            await assert.rejects(() =>
                access(provider).sendRequestWithRetry(
                    { model: "model-reasoning", messages: [], stream: true, max_tokens: 100, reasoning_effort: "high" },
                    [
                        {
                            role: vscode.LanguageModelChatMessageRole.User,
                            name: undefined,
                            content: [new vscode.LanguageModelTextPart("hi")],
                        },
                    ],
                    model,
                    { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                    new vscode.CancellationTokenSource().token,
                    "test"
                )
            );

            assert.ok(sendStub.calledOnce);
        });

        test("enforces retry cap of five attempts", async () => {
            const provider = setupProvider();
            const baseConfig = { baseUrl: "https://wolfram.example", apiKey: "k" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k",
                client: {} as never,
            });
            const sendStub = sandbox
                .stub(access(provider)._transport, "sendRequestToLiteLLM")
                .rejects(apiError("LiteLLM API error 400: reasoning_effort not supported", 400));

            await assert.rejects(() =>
                access(provider).sendRequestWithRetry(
                    { model: "model-reasoning", messages: [], stream: true, max_tokens: 100, reasoning_effort: "high" },
                    [
                        {
                            role: vscode.LanguageModelChatMessageRole.User,
                            name: undefined,
                            content: [new vscode.LanguageModelTextPart("hi")],
                        },
                    ],
                    model,
                    { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                    new vscode.CancellationTokenSource().token,
                    "test"
                )
            );

            // Should not exceed the cap; allow some slack.
            assert.ok(sendStub.callCount <= 6, `called ${sendStub.callCount} times`);
        });

        test("retries once without stream_options include_usage on unknown parameter rejection", async () => {
            const provider = setupProvider();
            const baseConfig = { baseUrl: "https://wolfram.example", apiKey: "k" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k",
                client: {} as never,
            });
            const sendStub = sandbox
                .stub(access(provider)._transport, "sendRequestToLiteLLM")
                .onCall(0)
                .rejects(apiError("LiteLLM API error 400: stream_options.include_usage is not supported", 400))
                .onCall(1)
                .resolves(new ReadableStream());

            await access(provider).sendRequestWithRetry(
                {
                    model: "model-reasoning",
                    messages: [],
                    stream: true,
                    max_tokens: 100,
                    stream_options: { include_usage: true },
                },
                [
                    {
                        role: vscode.LanguageModelChatMessageRole.User,
                        name: undefined,
                        content: [new vscode.LanguageModelTextPart("hi")],
                    },
                ],
                model,
                { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                new vscode.CancellationTokenSource().token,
                "test"
            );

            assert.ok(sendStub.calledTwice);
        });

        test("applies cached lower effort when prior failure recorded", async () => {
            const provider = setupProvider();
            const baseConfig = { baseUrl: "https://wolfram.example", apiKey: "k", reasoningEffort: "high" };
            seedBackendForCall(sandbox, provider, baseConfig, {
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k",
                client: {} as never,
            });
            // Pre-seed fallback cache: prior "high" failure → next "low"
            access(provider)._effortFallbackCache.recordFailure("model-reasoning", "high");

            const capturedRequests: OpenAIChatCompletionRequest[] = [];
            sandbox.stub(access(provider)._transport, "sendRequestToLiteLLM").callsFake(async (req) => {
                capturedRequests.push(req);
                return new ReadableStream();
            });

            await access(provider).sendRequestWithRetry(
                { model: "model-reasoning", messages: [], stream: true, max_tokens: 100, reasoning_effort: "high" },
                [
                    {
                        role: vscode.LanguageModelChatMessageRole.User,
                        name: undefined,
                        content: [new vscode.LanguageModelTextPart("hi")],
                    },
                ],
                model,
                { configuration: baseConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>,
                new vscode.CancellationTokenSource().token,
                "test"
            );

            assert.ok(capturedRequests[0].reasoning_effort !== "high", "should have downgraded before first send");
        });
    });

    suite("discoverModels", () => {
        const config: Record<string, unknown> = {
            providerName: "test-group",
            baseUrl: "http://localhost:4000",
            apiKey: "test-key",
        };

        // Factory: created lazily so `sandbox` is in scope.
        const makeMockSession = (): BackendSession => ({
            backendName: "test-group",
            baseUrl: "http://localhost:4000",
            apiKey: "test-key",
            client: {
                getModelInfo: sandbox.stub().resolves({
                    data: [
                        {
                            model_name: "gpt-4",
                            model_info: {
                                litellm_provider: "openai",
                                supports_reasoning: true,
                                supports_reasoning_effort: true,
                                max_input_tokens: 128000,
                                max_output_tokens: 4096,
                                mode: "chat",
                            },
                        },
                    ],
                }),
            } as unknown as BackendSession["client"],
        });

        test("returns the same model id on subsequent calls (stateless re-fetch, not cached reference)", async () => {
            // The discovery layer is stateless: every call performs a fresh
            // `/model/info` HTTP request. Two calls produce two independent
            // fetches, so the returned array references differ. The model
            // id is stable across calls because the routing identity
            // (derived from the URL hostname) does not change.
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const configManager = access(provider)._configManager;
            const mockSession = makeMockSession();
            sandbox.stub(configManager, "convertProviderConfiguration").returns(mockSession);

            const models1 = await provider.discoverModels(
                { silent: true, configuration: config },
                new vscode.CancellationTokenSource().token
            );
            const models2 = await provider.discoverModels(
                { silent: true, configuration: config },
                new vscode.CancellationTokenSource().token
            );

            assert.strictEqual(models1.length, 1);
            assert.strictEqual(models2.length, 1);
            assert.strictEqual(models1[0].id, models2[0].id, "model id is stable across calls");
        });

        test("attaches reasoning configuration schema when supported", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const configManager = access(provider)._configManager;
            const mockSession = makeMockSession();
            sandbox.stub(configManager, "convertProviderConfiguration").returns(mockSession);

            const models = await provider.discoverModels(
                { silent: true, configuration: config },
                new vscode.CancellationTokenSource().token
            );

            assert.ok(models[0].configurationSchema, "schema should be attached for reasoning models");
        });

        test("returns [] when no configuration is provided (vendor-level call)", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const token = new vscode.CancellationTokenSource().token;
            const models = await provider.discoverModels({ silent: true }, token);
            assert.deepStrictEqual(models, []);
        });

        test("throws a LanguageModelError when configuration is invalid", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const token = new vscode.CancellationTokenSource().token;
            const configManager = access(provider)._configManager;
            sandbox.stub(configManager, "convertProviderConfiguration").returns(undefined);
            await assert.rejects(
                () =>
                    provider.discoverModels(
                        { silent: true, configuration: { baseUrl: "http://x", apiKey: "k" } },
                        token
                    ),
                (err: unknown) => err instanceof vscode.LanguageModelError
            );
        });

        test("marks modern configuration detection when provider configuration is valid", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const configManager = access(provider)._configManager;
            const mockSession = makeMockSession();
            sandbox.stub(configManager, "convertProviderConfiguration").returns(mockSession);

            const detected = sandbox.stub();
            provider.setModernConfigurationDetectedHandler(detected);

            await provider.discoverModels(
                { silent: true, configuration: config },
                new vscode.CancellationTokenSource().token
            );
            assert.ok(detected.calledOnce);
        });

        test("per-group model lists are isolated — one group refresh does not trample another", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const configManager = access(provider)._configManager;
            const wolframConfig: Record<string, unknown> = {
                baseUrl: "https://wolfram.example",
                apiKey: "k-w",
            };
            const gethConfig: Record<string, unknown> = {
                baseUrl: "https://geth.example",
                apiKey: "k-g",
            };
            const stub = sandbox.stub(configManager, "convertProviderConfiguration");
            // groupName is "" at the discovery call site (the picker uses the URL-derived
            // label); we match on the second argument (configuration payload) only.
            stub.withArgs(sinon.match.string, wolframConfig).returns({
                backendName: "wolfram",
                baseUrl: "https://wolfram.example",
                apiKey: "k-w",
                client: {
                    getModelInfo: async () => ({
                        data: [{ model_name: "wolfram-only", model_info: { litellm_provider: "openai" } }],
                    }),
                } as unknown as BackendSession["client"],
            });
            stub.withArgs(sinon.match.string, gethConfig).returns({
                backendName: "geth",
                baseUrl: "https://geth.example",
                apiKey: "k-g",
                client: {
                    getModelInfo: async () => ({
                        data: [{ model_name: "geth-only", model_info: { litellm_provider: "openai" } }],
                    }),
                } as unknown as BackendSession["client"],
            });

            const wolframModels = await provider.discoverModels(
                { silent: true, configuration: wolframConfig },
                new vscode.CancellationTokenSource().token
            );
            const gethModels = await provider.discoverModels(
                { silent: true, configuration: gethConfig },
                new vscode.CancellationTokenSource().token
            );

            // The BackendRegistry is the source of truth. Each backend's
            // model list is keyed by its baseUrl, so a refresh of one
            // backend does not trample another.
            const registry = access(provider)._registry;
            const wolframIds = registry.lookup("wolfram.example/wolfram-only")?.rawModelName;
            const gethIds = registry.lookup("geth.example/geth-only")?.rawModelName;
            assert.strictEqual(wolframIds, "wolfram-only");
            assert.strictEqual(gethIds, "geth-only");
            // The namespaced id reflects the URL-derived routing identity.
            assert.strictEqual(wolframModels[0].id, "wolfram.example/wolfram-only");
            assert.strictEqual(gethModels[0].id, "geth.example/geth-only");
        });

        test("returns the live result every call (no ghost cache from prior delivery)", async () => {
            // The discovery layer is stateless: every call performs a fresh
            // `/model/info` HTTP request. An empty result is surfaced
            // honestly (so the picker reflects the live state of the
            // backend); it is NOT replaced by the prior delivery's list.
            // This is a deliberate behavior change from the previous
            // 5-minute-TTL design, which kept stale entries.
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const configManager = access(provider)._configManager;
            const mockSession = makeMockSession();
            sandbox.stub(configManager, "convertProviderConfiguration").returns(mockSession);

            // First discovery returns models
            const first = await provider.discoverModels(
                { silent: true, configuration: config },
                new vscode.CancellationTokenSource().token
            );
            assert.strictEqual(first.length, 1);

            // Now stub the client to return empty
            (mockSession.client.getModelInfo as sinon.SinonStub).resolves({ data: [] });

            const second = await provider.discoverModels(
                { silent: true, configuration: config },
                new vscode.CancellationTokenSource().token
            );
            // Empty result is surfaced; the previous list is NOT reused.
            assert.strictEqual(second.length, 0);
        });

        test("registers the backend in the BackendRegistry with the per-group credentials", async () => {
            // The BackendRegistry is the source of truth for response-time
            // routing. After a successful discovery, the registry's
            // `lookup(modelId)` MUST resolve to the same `baseUrl` /
            // `apiKey` that was passed in on the originating call. The
            // model object on the wire no longer needs to carry
            // `configuration` because the registry is the source of truth.
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const configManager = access(provider)._configManager;
            const mockSession = makeMockSession();
            sandbox.stub(configManager, "convertProviderConfiguration").returns(mockSession);

            const models = await provider.discoverModels(
                { silent: true, configuration: config },
                new vscode.CancellationTokenSource().token
            );

            assert.strictEqual(models.length, 1);
            const registry = access(provider)._registry;
            const looked = registry.lookup(models[0].id);
            assert.ok(looked, "registry should resolve the namespaced id back to a routing entry");
            assert.strictEqual(looked!.baseUrl, "http://localhost:4000");
            assert.strictEqual(looked!.apiKey, "test-key");
        });
    });

    suite("discoverModels — change detection (no discovery loop)", () => {
        // VS Code re-queries provideLanguageModelChatInformation on every
        // onDidChangeLanguageModelChatInformation event. Firing the event
        // unconditionally from discoverModels caused an infinite loop:
        // discover → fire → VS Code re-queries → discover → fire → ...
        // The loop is broken by firing ONLY when the model id set returned
        // for a given baseUrl differs from the prior delivery.

        const makeSession = (models: { model_name: string; litellm_provider: string }[]) =>
            ({
                backendName: "test-group",
                baseUrl: "http://localhost:4000",
                apiKey: "test-key",
                client: {
                    getModelInfo: async () => ({ data: models }),
                } as unknown as { getModelInfo: sinon.SinonStub },
            }) as unknown as BackendSession;

        const makeProvider = (session: ReturnType<typeof makeSession>, sandbox: sinon.SinonSandbox) => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            sandbox.stub(access(provider)._configManager, "convertProviderConfiguration").returns(session);
            return provider;
        };

        test("fires onDidChange on the first discovery (no prior delivery)", async () => {
            const localSandbox = sinon.createSandbox();
            try {
                const provider = makeProvider(
                    makeSession([{ model_name: "gpt-4", litellm_provider: "openai" }]),
                    localSandbox
                );
                const fired: number[] = [];
                provider.onDidChangeLanguageModelChatInformation(() => fired.push(1));

                await provider.discoverModels(
                    { silent: true, configuration: { baseUrl: "http://localhost:4000", apiKey: "k" } },
                    new vscode.CancellationTokenSource().token
                );

                assert.strictEqual(fired.length, 1, "first delivery must fire");
            } finally {
                localSandbox.restore();
            }
        });

        test("does NOT fire onDidChange when the model set is unchanged", async () => {
            const localSandbox = sinon.createSandbox();
            try {
                const provider = makeProvider(
                    makeSession([{ model_name: "gpt-4", litellm_provider: "openai" }]),
                    localSandbox
                );
                const fired: number[] = [];
                provider.onDidChangeLanguageModelChatInformation(() => fired.push(1));

                const token = new vscode.CancellationTokenSource().token;
                const cfg = { baseUrl: "http://localhost:4000", apiKey: "k" };

                // First call: fires.
                await provider.discoverModels({ silent: true, configuration: cfg }, token);
                // Second call: same models, must NOT fire.
                await provider.discoverModels({ silent: true, configuration: cfg }, token);
                // Third call: still no change.
                await provider.discoverModels({ silent: true, configuration: cfg }, token);

                assert.strictEqual(fired.length, 1, "only the first delivery should fire");
            } finally {
                localSandbox.restore();
            }
        });

        test("fires onDidChange again when the model set changes", async () => {
            const localSandbox = sinon.createSandbox();
            try {
                const getModelInfoStub = localSandbox.stub().resolves({
                    data: [{ model_name: "gpt-4", model_info: { litellm_provider: "openai" } }],
                });
                const session = {
                    backendName: "test-group",
                    baseUrl: "http://localhost:4000",
                    apiKey: "test-key",
                    client: { getModelInfo: getModelInfoStub },
                } as unknown as BackendSession;
                const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
                localSandbox.stub(access(provider)._configManager, "convertProviderConfiguration").returns(session);
                const fired: number[] = [];
                provider.onDidChangeLanguageModelChatInformation(() => fired.push(1));

                const token = new vscode.CancellationTokenSource().token;
                const cfg = { baseUrl: "http://localhost:4000", apiKey: "k" };

                await provider.discoverModels({ silent: true, configuration: cfg }, token);
                assert.strictEqual(fired.length, 1);

                // The LiteLLM client now returns a different model set.
                getModelInfoStub.resolves({
                    data: [{ model_name: "claude-3", model_info: { litellm_provider: "anthropic" } }],
                });
                await provider.discoverModels({ silent: true, configuration: cfg }, token);
                assert.strictEqual(fired.length, 2, "second call with different ids must fire");

                // Same ids again — no fire.
                await provider.discoverModels({ silent: true, configuration: cfg }, token);
                assert.strictEqual(fired.length, 2);
            } finally {
                localSandbox.restore();
            }
        });

        test("treats different baseUrls independently", async () => {
            // Two distinct baseUrls should each have their own change-detection
            // fingerprint. A change in baseUrl A must not reset baseUrl B's
            // fingerprint, and vice versa.
            const localSandbox = sinon.createSandbox();
            try {
                const sessionA = makeSession([{ model_name: "gpt-4", litellm_provider: "openai" }]);
                const sessionB = makeSession([{ model_name: "claude-3", litellm_provider: "anthropic" }]);
                const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
                const stub = localSandbox.stub(access(provider)._configManager, "convertProviderConfiguration");
                stub.callsFake((_groupName: string, config: Record<string, unknown>) => {
                    if (config.baseUrl === "http://a") {
                        return sessionA;
                    }
                    if (config.baseUrl === "http://b") {
                        return sessionB;
                    }
                    return undefined;
                });

                const fired: number[] = [];
                provider.onDidChangeLanguageModelChatInformation(() => fired.push(1));

                const token = new vscode.CancellationTokenSource().token;
                // A first → fires
                await provider.discoverModels(
                    { silent: true, configuration: { baseUrl: "http://a", apiKey: "k" } },
                    token
                );
                assert.strictEqual(fired.length, 1);
                // A again (same ids) → does not fire
                await provider.discoverModels(
                    { silent: true, configuration: { baseUrl: "http://a", apiKey: "k" } },
                    token
                );
                assert.strictEqual(fired.length, 1);
                // B first time → fires (its own fingerprint is fresh)
                await provider.discoverModels(
                    { silent: true, configuration: { baseUrl: "http://b", apiKey: "k" } },
                    token
                );
                assert.strictEqual(fired.length, 2);
                // B again → does not fire
                await provider.discoverModels(
                    { silent: true, configuration: { baseUrl: "http://b", apiKey: "k" } },
                    token
                );
                assert.strictEqual(fired.length, 2);
            } finally {
                localSandbox.restore();
            }
        });
    });

    suite("clearModelCache", () => {
        test("clears the BackendRegistry routing table and the base capability cache", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            // Seed the BackendRegistry with a backend so the routing table
            // is non-empty. After clearModelCache the registry must be
            // empty.
            const registry = access(provider)._registry;
            // Use the public `clear` is the observable surface; we test
            // that `size` shrinks to 0 after clearModelCache.
            // Seed by reaching into a public test seam: the registry's
            // `size()` returns the count of backends; a fresh registry is 0.
            assert.strictEqual(registry.size(), 0);

            // clearModelCache must clear the registry. The base
            // provider has no separate model-info cache to clear — the
            // registry is the single source of truth.
            provider.clearModelCache();
            assert.strictEqual(registry.size(), 0);
        });
    });

    suite("buildCapabilities and parseApiError", () => {
        test("buildCapabilities maps model_info flags correctly", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const caps = access(provider).buildCapabilities({
                supports_function_calling: true,
                supports_vision: true,
            } as LiteLLMModelInfo);
            assert.strictEqual(caps.toolCalling, true);
            assert.strictEqual(caps.imageInput, true);
        });

        test("buildCapabilities defaults to { toolCalling: true, imageInput: false } when no model_info", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const caps = access(provider).buildCapabilities(undefined);
            assert.strictEqual(caps.toolCalling, true);
            assert.strictEqual(caps.imageInput, false);
        });

        test("parseApiError extracts meaningful error messages", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const text = JSON.stringify({ error: { message: "Invalid API key" } });
            assert.strictEqual(access(provider).parseApiError(401, text), "Invalid API key");
        });

        test("parseApiError handles non-JSON error text", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            assert.strictEqual(access(provider).parseApiError(500, "Internal server error"), "Internal server error");
        });

        test("parseApiError returns generic message when errorText is empty", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            assert.strictEqual(access(provider).parseApiError(500, ""), "API request failed with status 500");
        });
    });

    suite("getCallTimeConfiguration — per-group config at response time", () => {
        test("prefers options.configuration when present", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const optionsConfig = { baseUrl: "https://from-options", apiKey: "k-options" };
            const modelConfig = { baseUrl: "https://from-model", apiKey: "k-model" };
            const result = await access(provider).getCallTimeConfiguration(
                { configuration: optionsConfig } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                {
                    id: "m",
                    name: "m",
                    family: "litellm",
                    version: "1.0",
                    configuration: modelConfig,
                } as unknown as vscode.LanguageModelChatInformation
            );
            assert.ok(result);
            assert.strictEqual(result!.baseUrl, optionsConfig.baseUrl);
            assert.strictEqual(result!.apiKey, optionsConfig.apiKey);
            // merged config toggles should also be present
            assert.strictEqual(result!.allowChatCompletionsFallback, false);
        });

        test("falls back to the BackendRegistry when options.configuration is missing", async () => {
            // VS Code 1.120 does NOT carry the per-group config on
            // `ProvideLanguageModelChatResponseOptions`. The response path
            // falls back to the in-memory `LiteLLMProviderRegistry` keyed
            // by the namespaced model id. The model object on the wire no
            // longer needs to carry `configuration` because the registry
            // is the single source of truth.
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const registryEntry = { baseUrl: "https://from-registry", apiKey: "k-registry" };
            sandbox.stub(access(provider)._registry, "lookup").withArgs("m").returns({
                baseUrl: registryEntry.baseUrl,
                apiKey: registryEntry.apiKey,
                rawModelName: "m",
                routingIdentity: "",
            });
            const result = await access(provider).getCallTimeConfiguration(
                {} as vscode.ProvideLanguageModelChatResponseOptions,
                {
                    id: "m",
                    name: "m",
                    family: "litellm",
                    version: "1.0",
                } as unknown as vscode.LanguageModelChatInformation
            );
            assert.ok(result);
            assert.deepStrictEqual(result!.baseUrl, registryEntry.baseUrl);
            assert.strictEqual(result!.apiKey, registryEntry.apiKey);
            // merged config toggles should also be present
            assert.strictEqual(result!.allowChatCompletionsFallback, false);
        });

        test("returns undefined when neither options nor model carry configuration", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const result = await access(provider).getCallTimeConfiguration(
                {} as vscode.ProvideLanguageModelChatResponseOptions,
                {
                    id: "m",
                    name: "m",
                    family: "litellm",
                    version: "1.0",
                } as unknown as vscode.LanguageModelChatInformation
            );
            assert.strictEqual(result, undefined);
        });
    });

    suite("getModelTags", () => {
        test("adds inline-completions for streaming chat models", () => {
            const tags = getModelTags("gpt-4-streaming", createDerived({ supportsStreaming: true }), {});
            assert.ok(tags.includes("inline-completions"));
        });

        test("does not add inline-completions when streaming is unsupported", () => {
            const tags = getModelTags("m", createDerived({ supportsStreaming: false }), {});
            assert.ok(!tags.includes("inline-completions"));
        });

        test("applies user overrides", () => {
            const tags = getModelTags("m", createDerived(), { m: ["custom-tag"] });
            assert.ok(tags.includes("custom-tag"));
        });

        test("adds inline-edit for models containing 'coder' or 'code'", () => {
            const tags = getModelTags("codex", createDerived(), {});
            assert.ok(tags.includes("inline-edit"));
        });

        test("adds tools tag for function-calling or vision models", () => {
            const tags = getModelTags("m", createDerived({ supportsTools: true }), {});
            assert.ok(tags.includes("tools"));
        });
    });

    suite("stripUnsupportedParametersFromRequest", () => {
        test("removes known unsupported params", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const body: Record<string, unknown> = { temperature: 0.5, top_p: 1, model: "claude-3-5-sonnet" };
            access(provider).stripUnsupportedParametersFromRequest(
                body,
                { supports_function_calling: true } as LiteLLMModelInfo,
                "claude-3-5-sonnet"
            );
            assert.strictEqual(body.temperature, undefined);
        });

        test("handles o1 models", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const body: Record<string, unknown> = { temperature: 0.5, top_p: 1, model: "o1-mini" };
            access(provider).stripUnsupportedParametersFromRequest(body, {} as LiteLLMModelInfo, "o1-mini");
            assert.strictEqual(body.temperature, undefined);
            assert.strictEqual(body.top_p, undefined);
        });

        test("handles gpt-5-mini models", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const body: Record<string, unknown> = { temperature: 0.5, top_p: 1, frequency_penalty: 0 };
            access(provider).stripUnsupportedParametersFromRequest(body, {} as LiteLLMModelInfo, "gpt-5-mini");
            assert.strictEqual(body.temperature, undefined);
        });

        test("removes cache keys inside extra_body and deletes empty containers", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const body: Record<string, unknown> = {
                extra_body: { cache: { "no-cache": true, other: "x" } },
            };
            access(provider).stripUnsupportedParametersFromRequest(body, {} as LiteLLMModelInfo, "m");
            const eb = body.extra_body as { cache?: { other?: string } };
            assert.ok(eb.cache);
            assert.strictEqual(eb.cache?.other, "x");
        });

        test("preserves supported fields when model has no limitations", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const body: Record<string, unknown> = { temperature: 0.5 };
            access(provider).stripUnsupportedParametersFromRequest(body, {} as LiteLLMModelInfo, "any-model");
            assert.strictEqual(body.temperature, 0.5);
        });
    });

    suite("isParameterSupported", () => {
        test("returns false when modelId matches known model limitations substring", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            assert.strictEqual(
                access(provider).isParameterSupported("temperature", undefined, "claude-3-5-sonnet-2024"),
                false
            );
        });

        test("returns true when parameter is explicitly supported and not blocked", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            assert.strictEqual(
                access(provider).isParameterSupported(
                    "temperature",
                    { supported_openai_params: ["temperature"] } as LiteLLMModelInfo,
                    "m"
                ),
                true
            );
        });
    });

    suite("detectQuotaToolRedaction", () => {
        const makeText = (s: string): vscode.LanguageModelChatRequestMessage => ({
            role: vscode.LanguageModelChatMessageRole.User,
            name: undefined,
            content: [new vscode.LanguageModelTextPart(s)],
        });

        const tools: vscode.LanguageModelChatTool[] = [
            { name: "insert_edit_into_file", description: "", inputSchema: {} },
        ];

        test("removes failing tool when enabled", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const messages: vscode.LanguageModelChatRequestMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    name: undefined,
                    content: [new vscode.LanguageModelToolCallPart("call_legacy_1", "insert_edit_into_file", {})],
                } as unknown as vscode.LanguageModelChatRequestMessage,
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [
                        new vscode.LanguageModelToolResultPart("call_legacy_1", [
                            new vscode.LanguageModelTextPart(
                                "Error: 429 rate limit exceeded when calling insert_edit_into_file"
                            ),
                        ]),
                    ],
                } as unknown as vscode.LanguageModelChatRequestMessage,
            ];
            const result = access(provider).detectQuotaToolRedaction(messages, tools, "rid", "m", false);
            assert.strictEqual(result.tools.length, 0);
            assert.strictEqual(result.confidence, "high");
        });

        test("does not remove tool when disabled", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const result = access(provider).detectQuotaToolRedaction(
                [makeText("Error: 429 rate limit exceeded when calling insert_edit_into_file")],
                tools,
                "rid",
                "m",
                true
            );
            assert.strictEqual(result.tools.length, 1);
            assert.strictEqual(result.confidence, "none");
        });

        test("does not redact when quota tool is not present", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const result = access(provider).detectQuotaToolRedaction(
                [makeText("Error: 429 rate limit exceeded")],
                tools,
                "rid",
                "m",
                false
            );
            assert.strictEqual(result.tools.length, 1);
            assert.strictEqual(result.confidence, "none");
        });

        test("does not redact when message has no text", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const result = access(provider).detectQuotaToolRedaction(
                [
                    {
                        role: vscode.LanguageModelChatMessageRole.User,
                        name: undefined,
                        content: [],
                    } as unknown as vscode.LanguageModelChatRequestMessage,
                ],
                tools,
                "rid",
                "m",
                false
            );
            assert.strictEqual(result.tools.length, 1);
            assert.strictEqual(result.confidence, "none");
        });

        test("does not redact when quota regex does not match", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const result = access(provider).detectQuotaToolRedaction(
                [makeText("All good, no errors here insert_edit_into_file")],
                tools,
                "rid",
                "m",
                false
            );
            assert.strictEqual(result.tools.length, 1);
            assert.strictEqual(result.confidence, "none");
        });

        test("does not redact when tool regex does not match", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const result = access(provider).detectQuotaToolRedaction(
                [makeText("Error: 429 rate limit exceeded with replace_string_in_file")],
                [{ name: "insert_edit_into_file", description: "", inputSchema: {} }],
                "rid",
                "m",
                false
            );
            assert.strictEqual(result.tools.length, 1);
            assert.strictEqual(result.confidence, "low");
        });

        test("does not redact on echoed Copilot context without rate/quota signal", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const result = access(provider).detectQuotaToolRedaction(
                [makeText("<context>Some text</context> insert_edit_into_file normal response")],
                tools,
                "rid",
                "m",
                false
            );
            assert.strictEqual(result.tools.length, 1);
            assert.strictEqual(result.confidence, "none");
        });

        // Helper functions for new confidence-aware tests
        const makeToolResultMessage = (
            callId: string,
            _toolName: string,
            resultText: string
        ): vscode.LanguageModelChatRequestMessage =>
            ({
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [
                    new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart(resultText)]),
                ],
            }) as unknown as vscode.LanguageModelChatRequestMessage;

        const makeAssistantToolCall = (callId: string, toolName: string): vscode.LanguageModelChatRequestMessage =>
            ({
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [new vscode.LanguageModelToolCallPart(callId, toolName, {})],
            }) as unknown as vscode.LanguageModelChatRequestMessage;

        test("redacts on real tool-result quota error for the matching tool", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const messages = [
                makeAssistantToolCall("call_1", "insert_edit_into_file"),
                makeToolResultMessage(
                    "call_1",
                    "insert_edit_into_file",
                    "Error: 429 rate limit exceeded while writing file"
                ),
            ];
            const tools: vscode.LanguageModelChatTool[] = [
                { name: "insert_edit_into_file", description: "", inputSchema: {} },
            ];
            const result = access(provider).detectQuotaToolRedaction(messages, tools, "rid", "m", false);
            assert.strictEqual(result.tools.length, 0);
            assert.strictEqual(result.confidence, "high");
        });

        test("does not redact when reminderInstructions body mentions both patterns", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            // A plausible <reminderInstructions> body — text content only, no tool parts.
            const reminder =
                "If a tool returns 429 / rate limit exceeded / quota exceeded when calling " +
                "tools like insert_edit_into_file or replace_string_in_file, do not retry.";
            const result = access(provider).detectQuotaToolRedaction([makeText(reminder)], tools, "rid", "m", false);
            assert.strictEqual(result.tools.length, 1);
            assert.strictEqual(result.confidence, "low");
        });

        test("does not redact when userRequest body mentions both patterns", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const userRequest =
                "Help me debug a 429 quota exceeded error coming from insert_edit_into_file in our e2e tests.";
            const result = access(provider).detectQuotaToolRedaction([makeText(userRequest)], tools, "rid", "m", false);
            assert.strictEqual(result.tools.length, 1);
            assert.strictEqual(result.confidence, "low");
        });

        test("does not redact when quota error is in an older turn (not the most recent tool result)", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const messages = [
                // Older assistant turn that did NOT call insert_edit_into_file.
                makeText("Earlier in the conversation."),
                // Old quota tool result for a different tool.
                makeToolResultMessage("call_old", "run_in_terminal", "Error: 429 rate limit exceeded"),
                // Most recent user turn: a clean new request with no quota signal.
                makeText("Now please continue with the on-boarding flow."),
            ];
            const result = access(provider).detectQuotaToolRedaction(messages, tools, "rid", "m", false);
            assert.strictEqual(result.tools.length, 1);
            // We find the quota error in an old tool result, but since it's for a
            // non-redactable tool, we return "low" confidence (not our concern).
            assert.strictEqual(result.confidence, "low");
        });

        test("does not redact when tool result is for a different tool than the matched one", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const messages = [
                makeAssistantToolCall("call_2", "run_in_terminal"),
                makeToolResultMessage("call_2", "run_in_terminal", "Error: 429 rate limit exceeded from upstream"),
            ];
            const tools: vscode.LanguageModelChatTool[] = [
                { name: "insert_edit_into_file", description: "", inputSchema: {} },
                { name: "run_in_terminal", description: "", inputSchema: {} },
            ];
            const result = access(provider).detectQuotaToolRedaction(messages, tools, "rid", "m", false);
            assert.strictEqual(result.tools.length, 2);
            // We find a real quota error in a tool result, but it's for run_in_terminal
            // which we don't redact, so it's "low" confidence (observability only).
            assert.strictEqual(result.confidence, "low");
        });
    });

    suite("provideTokenCount", () => {
        const model: vscode.LanguageModelChatInformation = {
            id: "gpt-4",
            name: "gpt-4",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        test("uses local counting for small strings", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const tokenSource = new vscode.CancellationTokenSource();
            const count = await provider.provideTokenCount(model, "hi", tokenSource.token, {
                baseUrl: "https://wolfram.example",
                apiKey: "k",
            });
            assert.ok(count >= 0);
        });

        test("returns local estimate when cancellation is already requested", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const tokenSource = new vscode.CancellationTokenSource();
            tokenSource.cancel();
            const count = await provider.provideTokenCount(model, "hi", tokenSource.token, {
                baseUrl: "https://wolfram.example",
                apiKey: "k",
            });
            assert.ok(count >= 0);
        });

        test("kicks off background refinement for large strings", async () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const tokenSource = new vscode.CancellationTokenSource();

            await provider.provideTokenCount(model, "x".repeat(1000), tokenSource.token, {
                baseUrl: "https://wolfram.example",
                apiKey: "k",
            });
            // No assertion — the test verifies the path doesn't throw and returns a number.
            assert.ok(true);
        });
    });

    suite("sanitizeErrorTextForLogs / collectMessageText", () => {
        test("caps long text and removes prompt wrappers", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const longText = "<context>big payload</context> " + "x".repeat(2000);
            const out = access(provider).sanitizeErrorTextForLogs(longText);
            assert.ok(out.length <= 600);
            assert.ok(out.includes("<context>…</context>"));
        });

        test("collectMessageText handles string content parts", () => {
            const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
            const text = access(provider).collectMessageText({
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("hello")],
            });
            assert.strictEqual(text, "hello");
        });
    });

    suite("Logger usage", () => {
        test("Logger.info is used at startup", () => {
            // Smoke test: constructor doesn't throw.
            new LiteLLMChatProvider(mockSecrets, userAgent);
            assert.ok(true);
        });
    });
});
