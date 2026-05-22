import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { LiteLLMChatProvider } from "../";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { MultiBackendClient } from "../../adapters/multiBackendClient";
import { ResponsesClient } from "../../adapters/responsesClient";
import type { ConfigManager } from "../../config/configManager";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest, ResolvedBackend } from "../../types";
import { createMockSecrets } from "../../test/utils/testMocks";
import { EffortFallbackCache } from "../../utils/reasoningEffortFallback";
import { createTelemetryMocks } from "../../test/utils/telemetryMock";
import type { BackendSession } from "../backendSession";

/**
 * Typed view of the protected/private members and methods we need to inspect
 * in tests. Casting `provider as unknown as BaseTestAccess` once eliminates
 * dozens of `as any` casts and the no-unsafe lint warnings they generate,
 * while still keeping the production class API hidden in callers.
 */
/**
 * keep BaseTestAccess up to date with any protected members used in tests so we avoid `any` casts.
 */
interface BaseTestAccess {
    _configManager: ConfigManager;
    _lastModelList: vscode.LanguageModelChatInformation[];
    _modelListFetchedAtMs: number;
    _modelInfoCache: Map<string, LiteLLMModelInfo | undefined>;
    _parameterProbeCache: Map<string, Set<string>>;
    _effortFallbackCache: EffortFallbackCache;
    _doDiscoverModels: (
        options: { silent?: boolean; configuration?: Record<string, unknown>; groupName?: string },
        token: vscode.CancellationToken
    ) => Promise<vscode.LanguageModelChatInformation[]>;
    buildOpenAIChatRequest: (
        messages: vscode.LanguageModelChatRequestMessage[],
        model: vscode.LanguageModelChatInformation,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        modelInfo?: LiteLLMModelInfo
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
    ) => { tools: readonly vscode.LanguageModelChatTool[] };
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
        modelInfo?: LiteLLMModelInfo
    ) => Promise<ReadableStream<Uint8Array>>;
}

/**
 * Convenience accessor that performs the single typed cast.
 * Tests should call `access(provider)` instead of repeating `as unknown as ...`.
 */
function access(provider: LiteLLMChatProvider): BaseTestAccess {
    return provider as unknown as BaseTestAccess;
}

function createReasoningModel(id = "reasoning-model"): vscode.LanguageModelChatInformation {
    return {
        id,
        maxInputTokens: 8192,
        maxOutputTokens: 4096,
    } as vscode.LanguageModelChatInformation;
}

function createMessages(): vscode.LanguageModelChatRequestMessage[] {
    return [
        {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("hello")],
            name: undefined,
        },
    ];
}

suite("LiteLLM Provider Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;
    let settingsMap: Map<string, unknown>;
    let telemetryMocks: ReturnType<typeof createTelemetryMocks>;

    setup(() => {
        sandbox = sinon.createSandbox();
        telemetryMocks = createTelemetryMocks(sandbox);
        telemetryMocks.setup();
    });

    teardown(() => {
        telemetryMocks.teardown();
        sandbox.restore();
    });

    setup(() => {
        settingsMap = new Map<string, unknown>();
        // Default: no canonical baseUrl configured unless a test sets it explicitly.
        sandbox.stub(vscode.workspace, "getConfiguration").returns({
            get: (key: string, defaultValue?: unknown) => (settingsMap.has(key) ? settingsMap.get(key) : defaultValue),
            update: async (key: string, value: unknown) => {
                if (value === undefined) {
                    settingsMap.delete(key);
                } else {
                    settingsMap.set(key, value);
                }
            },
            has: (key: string) => settingsMap.has(key),
        } as unknown as vscode.WorkspaceConfiguration);
    });

    const mockSecrets = createMockSecrets({
        "litellm-connector.baseUrl": "http://localhost:4000",
        "litellm-connector.apiKey": "test-api-key",
    });

    const userAgent = "GitHubCopilotChat/test VSCode/test";

    test("buildOpenAIChatRequest respects sendDefaultParameters = false (default)", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const build = access(provider).buildOpenAIChatRequest.bind(provider);
        const configManager = access(provider)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            sendDefaultParameters: false,
        });

        const model = {
            id: "gpt-4",
            maxInputTokens: 8192,
            maxOutputTokens: 4096,
        } as vscode.LanguageModelChatInformation;

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hello")],
                name: undefined,
            },
        ];

        const request = await build(messages, model, {
            modelOptions: {},
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions);
        assert.strictEqual(
            request.temperature,
            undefined,
            "Temperature should be undefined when sendDefaultParameters is false"
        );
        assert.strictEqual(
            request.frequency_penalty,
            undefined,
            "frequency_penalty should be undefined when sendDefaultParameters is false"
        );
        assert.strictEqual(
            request.presence_penalty,
            undefined,
            "presence_penalty should be undefined when sendDefaultParameters is false"
        );
    });

    test("buildOpenAIChatRequest respects sendDefaultParameters = true", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const build = access(provider).buildOpenAIChatRequest.bind(provider);
        const configManager = access(provider)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            sendDefaultParameters: true,
        });

        const model = {
            id: "gpt-4",
            maxInputTokens: 8192,
            maxOutputTokens: 4096,
        } as vscode.LanguageModelChatInformation;

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hello")],
                name: undefined,
            },
        ];

        const request = await build(messages, model, {
            modelOptions: {},
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions);
        assert.strictEqual(request.temperature, 0.7, "Temperature should be 0.7 when sendDefaultParameters is true");
        assert.strictEqual(
            request.frequency_penalty,
            0.2,
            "frequency_penalty should be 0.2 when sendDefaultParameters is true"
        );
        assert.strictEqual(
            request.presence_penalty,
            0.1,
            "presence_penalty should be 0.1 when sendDefaultParameters is true"
        );
    });

    test("buildOpenAIChatRequest prefers modelOptions over defaults", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const build = access(provider).buildOpenAIChatRequest.bind(provider);
        const configManager = access(provider)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            sendDefaultParameters: true,
        });

        const model = {
            id: "gpt-4",
            maxInputTokens: 8192,
            maxOutputTokens: 4096,
        } as vscode.LanguageModelChatInformation;

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hello")],
                name: undefined,
            },
        ];

        const request = await build(messages, model, {
            modelOptions: {
                temperature: 0.5,
                frequency_penalty: 0.8,
                presence_penalty: undefined,
            },
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions);
        assert.strictEqual(request.temperature, 0.5, "Should use provided temperature 0.5");
        assert.strictEqual(request.frequency_penalty, 0.8, "Should use provided frequency_penalty 0.8");
        assert.strictEqual(request.presence_penalty, 0.1, "Should use default presence_penalty 0.1");
    });

    test("buildOpenAIChatRequest applies reasoning effort from modelConfiguration", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const build = access(provider).buildOpenAIChatRequest.bind(provider);
        const configManager = access(provider)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://localhost:4000" });

        const model = createReasoningModel();

        const modelInfo: LiteLLMModelInfo = { supports_reasoning: true };

        const messages = createMessages();

        const request = await build(
            messages,
            model,
            {
                modelOptions: {},
                modelConfiguration: { reasoningEffort: "medium" },
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
            } satisfies vscode.ProvideLanguageModelChatResponseOptions,
            modelInfo
        );

        // Reasoning effort is sent as a flat top-level `reasoning_effort` key — the
        // canonical OpenAI/LiteLLM-compatible format. Sending the previous nested
        // `reasoning: { effort }` shape produced 400s from upstream providers because
        // LiteLLM did not translate it.
        assert.strictEqual((request as { reasoning_effort?: string }).reasoning_effort, "medium");
    });

    test("buildOpenAIChatRequest applies picker xhigh when fallback cache is empty", async () => {
        const cache = new EffortFallbackCache();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent, cache);
        const build = access(provider).buildOpenAIChatRequest.bind(provider);
        const configManager = access(provider)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://localhost:4000" });

        const request = await build(
            createMessages(),
            createReasoningModel("gpt-5"),
            {
                modelOptions: {},
                modelConfiguration: { reasoningEffort: "xhigh" },
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { supports_reasoning: true }
        );

        const sendStub = sandbox
            .stub(access(provider) as unknown as { sendRequestToLiteLLM: unknown }, "sendRequestToLiteLLM")
            .resolves(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.close();
                    },
                })
            );

        await access(provider).sendRequestWithRetry(
            request,
            createMessages(),
            createReasoningModel(),
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
            },
            { report: () => {} },
            new vscode.CancellationTokenSource().token
        );

        const firstRequest = sendStub.firstCall.args[0] as OpenAIChatCompletionRequest;
        assert.strictEqual(firstRequest.reasoning_effort, "xhigh");
    });

    test("sendRequestWithRetry applies cached lower effort when prior failure recorded", async () => {
        const cache = new EffortFallbackCache();
        // Seed a failure for xhigh so the next effective effort is high.
        cache.recordFailure("gpt-5", "xhigh");

        const provider = new LiteLLMChatProvider(mockSecrets, userAgent, cache);
        const configManager = access(provider)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://localhost:4000" });

        const request = await access(provider).buildOpenAIChatRequest(
            createMessages(),
            createReasoningModel("gpt-5"),
            {
                modelOptions: {},
                modelConfiguration: { reasoningEffort: "xhigh" },
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { supports_reasoning: true }
        );

        const observedEfforts: string[] = [];
        const sendStub = sandbox
            .stub(access(provider) as unknown as { sendRequestToLiteLLM: unknown }, "sendRequestToLiteLLM")
            .callsFake(async (req: OpenAIChatCompletionRequest) => {
                observedEfforts.push((req as { reasoning_effort?: string }).reasoning_effort ?? "");
                return new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.close();
                    },
                });
            });

        await access(provider).sendRequestWithRetry(
            request,
            createMessages(),
            createReasoningModel(),
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
            },
            { report: () => {} },
            new vscode.CancellationTokenSource().token
        );

        assert.deepStrictEqual(observedEfforts, ["high"]);
        assert.strictEqual(sendStub.callCount, 1);
    });

    test("buildOpenAIChatRequest omits reasoning_effort when user has not picked one", async () => {
        // Regression: previously we defaulted to "medium" for any reasoning-capable
        // model. That caused LiteLLM to forward a `reasoning_effort` field to upstream
        // providers that did not accept it, producing a "reasoning" 400 error on every
        // chat. We now only send the field when the user explicitly chose an effort.
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const build = access(provider).buildOpenAIChatRequest.bind(provider);
        const configManager = access(provider)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://localhost:4000" });

        const model = {
            id: "reasoning-model",
            maxInputTokens: 8192,
            maxOutputTokens: 4096,
        } as vscode.LanguageModelChatInformation;

        const modelInfo: LiteLLMModelInfo = { supports_reasoning: true };

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hello")],
                name: undefined,
            },
        ];

        const request = await build(
            messages,
            model,
            {
                modelOptions: {},
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            modelInfo
        );

        assert.strictEqual(request.reasoning_effort, undefined);
        assert.ok(!("reasoning" in request), "Should not emit nested reasoning shape either");
    });

    test("buildOpenAIChatRequest treats picker 'none' as opt-out and omits reasoning_effort", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const build = access(provider).buildOpenAIChatRequest.bind(provider);
        const configManager = access(provider)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://localhost:4000" });

        const modelInfo: LiteLLMModelInfo = { supports_reasoning: true };

        const request = await build(
            createMessages(),
            createReasoningModel(),
            {
                modelOptions: {},
                modelConfiguration: { reasoningEffort: "none" },
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            modelInfo
        );

        assert.strictEqual(request.reasoning_effort, undefined);
    });

    test("sendRequestWithRetry retries once on reasoning 4xx and succeeds", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent, new EffortFallbackCache());
        const configManager = access(provider)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://localhost:4000" });

        const request = await access(provider).buildOpenAIChatRequest(
            createMessages(),
            createReasoningModel(),
            {
                modelOptions: {},
                modelConfiguration: { reasoningEffort: "xhigh" },
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { supports_reasoning: true }
        );

        const error = { status: 400, message: "reasoning effort unsupported" };
        const observedEfforts: string[] = [];
        const sendStub = sandbox
            .stub(access(provider) as unknown as { sendRequestToLiteLLM: unknown }, "sendRequestToLiteLLM")
            .callsFake(async (req: OpenAIChatCompletionRequest) => {
                const effort = (req as { reasoning_effort?: string }).reasoning_effort;
                console.log("STUB: req.reasoning_effort =", effort, "type:", typeof effort);
                observedEfforts.push(effort ?? "");
                if (observedEfforts.length === 1) {
                    throw error;
                }
                return new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.close();
                    },
                });
            });

        await access(provider).sendRequestWithRetry(
            request,
            createMessages(),
            createReasoningModel(),
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
            },
            { report: () => {} },
            new vscode.CancellationTokenSource().token
        );

        assert.deepStrictEqual(observedEfforts, ["xhigh", "high"]);
        assert.strictEqual(sendStub.callCount, 2);
    });

    test("sendRequestWithRetry notifies once per model and original effort", async () => {
        const cache = new EffortFallbackCache();
        cache.clear();
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent, cache);
        const configManager = access(provider)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://localhost:4000" });

        const requestFactory = async () =>
            access(provider).buildOpenAIChatRequest(
                createMessages(),
                createReasoningModel(),
                {
                    modelOptions: {},
                    modelConfiguration: { reasoningEffort: "xhigh" },
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { supports_reasoning: true }
            );

        const showInfoStub = sandbox.stub(vscode.window, "showInformationMessage").resolves();

        const error = { status: 400, message: "reasoning effort unsupported" };
        const sendStub = sandbox
            .stub(access(provider) as unknown as { sendRequestToLiteLLM: unknown }, "sendRequestToLiteLLM")
            .onCall(0)
            .rejects(error)
            .onCall(1)
            .resolves(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.close();
                    },
                })
            )
            // Second invocation of sendRequestWithRetry should not trigger a second notification.
            .onCall(2)
            .rejects(error)
            .onCall(3)
            .resolves(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.close();
                    },
                })
            );

        const request1 = await requestFactory();
        await access(provider).sendRequestWithRetry(
            request1,
            createMessages(),
            createReasoningModel(),
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
            },
            { report: () => {} },
            new vscode.CancellationTokenSource().token
        );

        const request2 = await requestFactory();
        await access(provider).sendRequestWithRetry(
            request2,
            createMessages(),
            createReasoningModel(),
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
            },
            { report: () => {} },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(showInfoStub.callCount, 1);
        assert.strictEqual(sendStub.callCount, 4);
    });

    test("sendRequestWithRetry does not retry on non-reasoning 5xx errors", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent, new EffortFallbackCache());
        const configManager = access(provider)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://localhost:4000" });

        const request = await access(provider).buildOpenAIChatRequest(
            createMessages(),
            createReasoningModel(),
            {
                modelOptions: {},
                modelConfiguration: { reasoningEffort: "xhigh" },
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { supports_reasoning: true }
        );

        const error = { status: 500, message: "server error" };
        const sendStub = sandbox
            .stub(access(provider) as unknown as { sendRequestToLiteLLM: unknown }, "sendRequestToLiteLLM")
            .rejects(error);

        await assert.rejects(
            access(provider).sendRequestWithRetry(
                request,
                createMessages(),
                createReasoningModel(),
                {
                    modelOptions: {},
                    tools: [],
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                    requestInitiator: "test",
                },
                { report: () => {} },
                new vscode.CancellationTokenSource().token
            )
        );

        assert.strictEqual(sendStub.callCount, 1);
    });

    test("sendRequestWithRetry does not retry on 4xx errors that are unrelated to reasoning", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent, new EffortFallbackCache());
        const configManager = access(provider)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://localhost:4000" });

        const request = await access(provider).buildOpenAIChatRequest(
            createMessages(),
            createReasoningModel(),
            {
                modelOptions: {},
                modelConfiguration: { reasoningEffort: "xhigh" },
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { supports_reasoning: true }
        );

        const error = { status: 400, message: "Bad request" };
        const sendStub = sandbox
            .stub(access(provider) as unknown as { sendRequestToLiteLLM: unknown }, "sendRequestToLiteLLM")
            .rejects(error);

        await assert.rejects(
            access(provider).sendRequestWithRetry(
                request,
                createMessages(),
                createReasoningModel(),
                {
                    modelOptions: {},
                    tools: [],
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                    requestInitiator: "test",
                },
                { report: () => {} },
                new vscode.CancellationTokenSource().token
            )
        );

        assert.strictEqual(sendStub.callCount, 1);
    });

    test("sendRequestWithRetry enforces retry cap of five attempts", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent, new EffortFallbackCache());
        const configManager = access(provider)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://localhost:4000" });

        const request = await access(provider).buildOpenAIChatRequest(
            createMessages(),
            createReasoningModel(),
            {
                modelOptions: {},
                modelConfiguration: { reasoningEffort: "xhigh" },
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { supports_reasoning: true }
        );

        const reasoningError = { status: 400, message: "reasoning effort unsupported" };
        const sendStub = sandbox
            .stub(access(provider) as unknown as { sendRequestToLiteLLM: unknown }, "sendRequestToLiteLLM")
            .rejects(reasoningError);

        await assert.rejects(
            access(provider).sendRequestWithRetry(
                request,
                createMessages(),
                createReasoningModel(),
                {
                    modelOptions: {},
                    tools: [],
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                    requestInitiator: "test",
                },
                { report: () => {} },
                new vscode.CancellationTokenSource().token
            ),
            /reasoning effort unsupported/
        );

        assert.strictEqual(sendStub.callCount, 5);
    });

    test("discoverModels attaches backend metadata and reasoning configuration schema when supported", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        // Stub configuration-based discovery
        const configManager = access(provider)._configManager as ConfigManager;
        const session: BackendSession = {
            backendName: "group1",
            baseUrl: "http://localhost:4000",
            apiKey: "k",
            client: {
                // Minimal mock satisfying the interface without using `any`
                getModelInfo: sandbox
                    .stub()
                    .resolves({ data: [{ model_name: "m1", model_info: { supports_reasoning: true } }] }),
            } as unknown as BackendSession["client"],
        };
        sandbox.stub(configManager, "convertProviderConfiguration").returns(session);

        const models = await provider.discoverModels(
            { configuration: { providerName: "group1", baseUrl: "http://localhost:4000", apiKey: "k" } },
            new vscode.CancellationTokenSource().token
        );

        assert.ok(
            models[0].configurationSchema,
            "Expected configurationSchema to be present for reasoning-capable model"
        );
        const modelWithBackendMetadata = models[0] as vscode.LanguageModelChatInformation & {
            _backendName?: string;
            _backendUrl?: string;
            _apiKey?: string;
        };
        assert.strictEqual(modelWithBackendMetadata._backendName, "group1");
        assert.strictEqual(modelWithBackendMetadata._backendUrl, "http://localhost:4000");
        assert.strictEqual(modelWithBackendMetadata._apiKey, "k");
        const props = models[0].configurationSchema?.properties as Record<string, unknown> | undefined;
        assert.ok(props?.reasoningEffort, "Expected reasoningEffort property in configuration schema");
    });

    test("configurationSchema uses OpenAI reasoning effort values", async () => {
        const providerForReasoning = new LiteLLMChatProvider(mockSecrets, userAgent);
        const configManagerForReasoning = (
            providerForReasoning as unknown as {
                _configManager: ConfigManager;
            }
        )._configManager;
        const sessionForReasoning: BackendSession = {
            backendName: "group1",
            baseUrl: "http://localhost:4000",
            apiKey: "k",
            client: {
                getModelInfo: sandbox
                    .stub()
                    .resolves({ data: [{ model_name: "m1", model_info: { supports_reasoning: true } }] }),
            } as unknown as BackendSession["client"],
        };
        sandbox.stub(configManagerForReasoning, "convertProviderConfiguration").returns(sessionForReasoning);

        const models = await providerForReasoning.discoverModels(
            { configuration: { providerName: "group1", baseUrl: "http://localhost:4000", apiKey: "k" } },
            new vscode.CancellationTokenSource().token
        );

        const configurationSchema = models[0].configurationSchema;
        assert.ok(configurationSchema, "Expected configurationSchema to be present");

        const enumValues = (
            configurationSchema?.properties?.reasoningEffort as {
                enum: string[];
                enumItemLabels: string[];
            }
        )?.enum;

        const enumItemLabels = (
            configurationSchema?.properties?.reasoningEffort as {
                enum: string[];
                enumItemLabels: string[];
                default: string;
            }
        )?.enumItemLabels;
        const defaultValue = (
            configurationSchema?.properties?.reasoningEffort as {
                enum: string[];
                enumItemLabels: string[];
                default: string;
            }
        )?.default;

        assert.deepStrictEqual(
            enumValues,
            ["none", "low", "medium", "high"],
            "Expected catch-all effort values in enum (4-value standard set)"
        );
        assert.ok(
            enumItemLabels?.includes("Medium"),
            "Expected 'Medium' effort label to be present in enumItemLabels (capitalized for picker UX)"
        );
        assert.strictEqual(defaultValue, "medium");
    });

    test("clearModelCache resets model list and caches", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        // Seed caches
        (provider as unknown as { _modelInfoCache: Map<string, unknown> })._modelInfoCache.set("m1", { mode: "chat" });
        (provider as unknown as { _parameterProbeCache: Map<string, unknown> })._parameterProbeCache.set(
            "m1",
            new Set(["temperature"])
        );
        (provider as unknown as { _lastModelList: vscode.LanguageModelChatInformation[] })._lastModelList = [
            {
                id: "m1",
                name: "m1",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1,
                maxOutputTokens: 1,
                capabilities: { toolCalling: true, imageInput: false },
                tags: ["tools"],
            } as unknown as vscode.LanguageModelChatInformation,
        ];

        provider.clearModelCache();
        assert.strictEqual(provider.getLastKnownModels().length, 0);
        assert.strictEqual((provider as unknown as { _modelInfoCache: Map<string, unknown> })._modelInfoCache.size, 0);
        assert.strictEqual(
            (provider as unknown as { _parameterProbeCache: Map<string, unknown> })._parameterProbeCache.size,
            0
        );
    });

    test("provideLanguageModelChatResponse uses modelIdOverride when present in config", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        // Seed canonical baseUrl so provider does not fail early.
        await vscode.workspace
            .getConfiguration()
            .update("litellm-connector.baseUrl", "http://localhost:4000", vscode.ConfigurationTarget.Global);

        // Seed last model list with an override model.
        (provider as unknown as { _lastModelList: vscode.LanguageModelChatInformation[] })._lastModelList = [
            {
                id: "override-model",
                name: "override-model",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 100,
                maxOutputTokens: 100,
                capabilities: { toolCalling: true, imageInput: false },
                tags: ["tools"],
            } as unknown as vscode.LanguageModelChatInformation,
        ];

        // Stub ConfigManager to return a config with modelIdOverride.
        const configManager = (provider as unknown as { _configManager: unknown })._configManager as {
            getConfig: () => Promise<unknown>;
        };
        sandbox.stub(configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            key: "k",
            disableQuotaToolRedaction: false,
            disableCaching: true,
            inactivityTimeout: 60,
            modelIdOverride: "override-model",
        });

        // Prevent network calls: stub the low-level client to return a minimal ReadableStream.
        // We only need to assert that the request model id is the override.
        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        chatStub.callsFake(async (request: OpenAIChatCompletionRequest) => {
            const requestBody = request as { model: string };
            assert.strictEqual(requestBody.model, "override-model");

            const encoder = new TextEncoder();
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
        });

        // Ensure we don't accidentally go down the /responses path in this test.
        sandbox.stub(ResponsesClient.prototype, "sendResponsesRequest").resolves();

        const modelSelected: vscode.LanguageModelChatInformation = {
            id: "selected-model",
            name: "selected-model",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 100,
            maxOutputTokens: 100,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        // Ensure canonical baseUrl exists so provider doesn't fail before applying model override.
        await vscode.workspace
            .getConfiguration()
            .update("litellm-connector.baseUrl", "http://example", vscode.ConfigurationTarget.Global);

        await provider.provideLanguageModelChatResponse(
            modelSelected,
            messages,
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
            },
            { report: () => {} },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(chatStub.called, true);
    });

    test("provideLanguageModelChatInformation returns array (no key -> empty)", async () => {
        const emptySecrets = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: (_listener: unknown) => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const provider = new LiteLLMChatProvider(emptySecrets, userAgent);
        const infos = await provider.provideLanguageModelChatInformation(
            { silent: true },
            new vscode.CancellationTokenSource().token
        );
        assert.ok(Array.isArray(infos));
        assert.strictEqual(infos.length, 0);
    });

    test("provideLanguageModelChatInformation handles missing URL without launching config command", async () => {
        const emptySecrets = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: (_listener: unknown) => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const provider = new LiteLLMChatProvider(emptySecrets, userAgent);

        // Discovery should remain non-interactive even when configuration is missing.
        const execStub = sandbox.stub(vscode.commands, "executeCommand").resolves(undefined);

        const infos = await provider.provideLanguageModelChatInformation(
            { silent: false },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(execStub.calledWith("litellm-connector.manage"), false);
        assert.strictEqual(infos.length, 0, "Should return 0 models when URL is missing and config not completed");
    });

    test("sendRequestToLiteLLM does not emit duplicate zero-token metric for /responses", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const telemetryModule = await import("../../utils/telemetry.js");
        const reportMetricStub = sandbox.stub(telemetryModule.LiteLLMTelemetry, "reportMetric");
        sandbox.stub(ResponsesClient.prototype, "sendResponsesRequest").resolves();
        const configManager = access(provider)._configManager;
        sandbox.stub(configManager, "resolveBackends").resolves([
            {
                name: "default",
                url: "http://localhost:4000",
                apiKey: "k",
                enabled: true,
            },
        ]);
        access(provider)._lastModelList = [
            {
                id: "default/test-responses",
                name: "default/test-responses",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 256,
                capabilities: { toolCalling: true, imageInput: false },
                _backendName: "default",
                _backendUrl: "http://localhost:4000",
                _apiKey: "k",
            } as unknown as vscode.LanguageModelChatInformation,
        ];

        const stream = await access(provider).sendRequestToLiteLLM(
            {
                model: "default/test-responses",
                messages: [
                    {
                        role: "user",
                        content: "hello",
                    },
                ],
                stream: true,
                max_tokens: 256,
            },
            { report: () => {} },
            new vscode.CancellationTokenSource().token,
            "tools",
            { mode: "responses" }
        );

        const reader = stream.getReader();
        const result = await reader.read();
        assert.strictEqual(result.done, true);
        assert.strictEqual(reportMetricStub.called, false);
    });

    test("buildCapabilities maps model_info flags correctly", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const buildCapabilities = (
            provider as unknown as {
                buildCapabilities: (modelInfo: unknown) => vscode.LanguageModelChatCapabilities;
            }
        ).buildCapabilities.bind(provider);

        assert.deepEqual(buildCapabilities({ supports_vision: true, supports_function_calling: true }), {
            toolCalling: true,
            imageInput: true,
        });

        assert.deepEqual(buildCapabilities({ supports_vision: false, supports_function_calling: true }), {
            toolCalling: true,
            imageInput: false,
        });

        assert.deepEqual(buildCapabilities(undefined), {
            toolCalling: true,
            imageInput: false,
        });
    });

    test("parseApiError extracts meaningful error messages", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const parseApiError = (
            provider as unknown as {
                parseApiError: (statusCode: number, errorText: string) => string;
            }
        ).parseApiError.bind(provider);

        const jsonError = JSON.stringify({ error: { message: "Temperature not supported" } });
        assert.strictEqual(parseApiError(400, jsonError), "Temperature not supported");

        const longError = "x".repeat(300);
        assert.strictEqual(parseApiError(400, longError).length, 200);

        assert.strictEqual(parseApiError(400, ""), "API request failed with status 400");
    });

    test("getModelTags adds inline-completions for streaming chat models", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderForTagTesting {
            getModelTags: (
                modelId: string,
                modelInfo?: LiteLLMModelInfo,
                overrides?: Record<string, string[]>
            ) => string[];
        }
        const getModelTags = (provider as unknown as ProviderForTagTesting).getModelTags.bind(provider);

        const tags = getModelTags("test-model", {
            mode: "chat",
            supports_native_streaming: true,
        });
        assert.ok(tags.includes("inline-completions"), "Streaming chat models should have inline-completions tag");
    });

    test("getModelTags applies user overrides", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderForTagTesting {
            getModelTags: (
                modelId: string,
                modelInfo?: LiteLLMModelInfo,
                overrides?: Record<string, string[]>
            ) => string[];
        }
        const getModelTags = (provider as unknown as ProviderForTagTesting).getModelTags.bind(provider);

        const overrides = { "test-model": ["custom-tag"] };
        const tags = getModelTags("test-model", undefined, overrides);
        assert.ok(tags.includes("custom-tag"), "User-defined override tags should be included in result");
    });

    test("stripUnsupportedParametersFromRequest removes known unsupported params", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const strip = (
            provider as unknown as {
                stripUnsupportedParametersFromRequest: (
                    requestBody: Record<string, unknown>,
                    modelInfo: unknown,
                    modelId?: string
                ) => void;
            }
        ).stripUnsupportedParametersFromRequest.bind(provider);

        const requestBody: Record<string, unknown> = {
            temperature: 0.9,
            stop: ["\n"],
            frequency_penalty: 0.5,
        };

        const modelInfo = { supported_openai_params: ["temperature", "stop", "frequency_penalty"] };
        strip(requestBody, modelInfo, "gpt-5.1-codex-mini");

        assert.strictEqual(requestBody.temperature, undefined);
        assert.strictEqual(requestBody.frequency_penalty, undefined);
        assert.deepStrictEqual(requestBody.stop, ["\n"]);
    });

    test("stripUnsupportedParametersFromRequest handles o1 models", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const strip = (
            provider as unknown as {
                stripUnsupportedParametersFromRequest: (
                    requestBody: Record<string, unknown>,
                    modelInfo: unknown,
                    modelId?: string
                ) => void;
            }
        ).stripUnsupportedParametersFromRequest.bind(provider);

        const requestBody: Record<string, unknown> = {
            temperature: 1.0,
            top_p: 1.0,
            presence_penalty: 0.0,
            max_tokens: 1000,
        };

        // o1 models shouldn't have temperature, top_p, or penalties
        strip(requestBody, undefined, "o1-mini");

        assert.strictEqual(requestBody.temperature, undefined);
        assert.strictEqual(requestBody.top_p, undefined);
        assert.strictEqual(requestBody.presence_penalty, undefined);
        assert.strictEqual(requestBody.max_tokens, 1000);
    });

    test("stripUnsupportedParametersFromRequest handles gpt-5-mini models", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const strip = (
            provider as unknown as {
                stripUnsupportedParametersFromRequest: (
                    requestBody: Record<string, unknown>,
                    modelInfo: unknown,
                    modelId?: string
                ) => void;
            }
        ).stripUnsupportedParametersFromRequest.bind(provider);

        const requestBody: Record<string, unknown> = {
            temperature: 1.0,
            top_p: 1.0,
            presence_penalty: 0.0,
            max_tokens: 1000,
        };

        // gpt-5-mini models shouldn't have temperature, top_p, or penalties
        strip(requestBody, undefined, "gpt-5-mini");

        assert.strictEqual(requestBody.temperature, undefined);
        assert.strictEqual(requestBody.top_p, undefined);
        assert.strictEqual(requestBody.presence_penalty, undefined);
        assert.strictEqual(requestBody.max_tokens, 1000);
    });

    test("detectQuotaToolRedaction removes failing tool when enabled", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const detect = (
            provider as unknown as {
                detectQuotaToolRedaction: (
                    messages: readonly vscode.LanguageModelChatRequestMessage[],
                    tools: readonly vscode.LanguageModelChatTool[],
                    requestId: string,
                    modelId: string,
                    disableRedaction: boolean
                ) => { tools: readonly vscode.LanguageModelChatTool[] };
            }
        ).detectQuotaToolRedaction.bind(provider);

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("429 rate limit exceeded for insert_edit_into_file")],
            },
        ];
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "insert_edit_into_file", description: "", inputSchema: {} },
            { name: "replace_string_in_file", description: "", inputSchema: {} },
        ];

        const result = detect(messages, tools, "req-1", "model-1", false);
        assert.strictEqual(result.tools.length, 1);
        assert.strictEqual(result.tools[0].name, "replace_string_in_file");
    });

    test("detectQuotaToolRedaction does not remove tool when disabled", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const detect = (
            provider as unknown as {
                detectQuotaToolRedaction: (
                    messages: readonly vscode.LanguageModelChatRequestMessage[],
                    tools: readonly vscode.LanguageModelChatTool[],
                    requestId: string,
                    modelId: string,
                    disableRedaction: boolean
                ) => { tools: readonly vscode.LanguageModelChatTool[] };
            }
        ).detectQuotaToolRedaction.bind(provider);

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("429 rate limit exceeded for insert_edit_into_file")],
            },
        ];
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "insert_edit_into_file", description: "", inputSchema: {} },
            { name: "replace_string_in_file", description: "", inputSchema: {} },
        ];

        const result = detect(messages, tools, "req-2", "model-1", true);
        assert.strictEqual(result.tools.length, 2);
        assert.strictEqual(result.tools[0].name, "insert_edit_into_file");
        assert.strictEqual(result.tools[1].name, "replace_string_in_file");
    });

    test("provideLanguageModelChatInformation includes tags in model info", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        // Seed canonical baseUrl so discovery proceeds.
        await vscode.workspace
            .getConfiguration()
            .update("litellm-connector.baseUrl", "http://localhost:4000", vscode.ConfigurationTarget.Global);

        const mockData = [
            {
                model_name: "gpt-4",
                model_info: {
                    id: "gpt-4",
                    mode: "chat",
                    supports_native_streaming: true,
                    supports_function_calling: true,
                    supported_openai_params: ["tools"],
                } as LiteLLMModelInfo,
            },
            {
                model_name: "claude-coder",
                model_info: {
                    id: "claude-coder",
                    mode: "chat",
                    supports_native_streaming: true,
                } as LiteLLMModelInfo,
            },
        ];

        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({ data: mockData });

        const infos = await provider.provideLanguageModelChatInformation(
            {
                silent: true,
                configuration: { providerName: "default", baseUrl: "http://localhost:4000", apiKey: "test-key" },
            },
            {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose() {} }),
            } as vscode.CancellationToken
        );

        assert.strictEqual(infos.length, 2);

        // Check second model (claude-coder) has inline-edit tag
        const claude = infos[1] as { tags?: string[] };
        const claudeTags = claude.tags || [];
        assert.ok(
            claudeTags.includes("inline-edit"),
            "claude-coder should have inline-edit tag (name contains 'coder')"
        );
        assert.ok(
            claudeTags.includes("inline-completions"),
            "claude-coder should have inline-completions tag for streaming"
        );
    });

    test("provideLanguageModelChatInformation applies model overrides to tags", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        const mockData = [
            {
                model_name: "gpt-4",
                model_info: {
                    id: "gpt-4",
                    mode: "chat",
                    supports_native_streaming: true,
                } as LiteLLMModelInfo,
            },
        ];

        // The provider now uses MultiBackendClient which calls getModelInfo on each backend
        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({ data: mockData });

        // Stub config manager to return namespaced ID data
        interface ConfigManager {
            getConfig: () => Promise<{ url: string }>;
            resolveBackends: () => Promise<ResolvedBackend[]>;
        }
        interface ProviderWithConfigManager {
            _configManager: ConfigManager;
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox
            .stub(providerWithConfig._configManager, "resolveBackends")
            .resolves([{ name: "default", url: "http://localhost:4000", apiKey: "test-key", enabled: true }]);
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
        });

        const infos = await provider.provideLanguageModelChatInformation(
            {
                silent: true,
                configuration: { providerName: "default", baseUrl: "http://localhost:4000", apiKey: "test-key" },
            },
            {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose() {} }),
            } as vscode.CancellationToken
        );

        assert.strictEqual(infos.length, 1);
        assert.strictEqual(infos[0].id, "default/gpt-4");
    });

    test("provideLanguageModelChatInformation applies capability overrides", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        const mockData = [
            {
                model_name: "gpt-4",
                model_info: {
                    id: "gpt-4",
                    mode: "chat",
                    supports_native_streaming: true,
                    supported_openai_params: [], // No tools
                    supports_vision: false, // No vision
                } as LiteLLMModelInfo,
            },
        ];

        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({ data: mockData });

        interface ConfigManager {
            getConfig: () => Promise<{
                url: string;
                modelCapabilitiesOverrides: Record<string, { toolCalling?: boolean; imageInput?: boolean }>;
            }>;
            resolveBackends: () => Promise<ResolvedBackend[]>;
        }
        interface ProviderWithConfigManager {
            _configManager: ConfigManager;
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox
            .stub(providerWithConfig._configManager, "resolveBackends")
            .resolves([{ name: "default", url: "http://localhost:4000", apiKey: "test-key", enabled: true }]);
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            modelCapabilitiesOverrides: {
                "default/gpt-4": { toolCalling: true, imageInput: true },
            },
        });

        const infos = await provider.provideLanguageModelChatInformation(
            {
                silent: true,
                configuration: { providerName: "default", baseUrl: "http://localhost:4000", apiKey: "test-key" },
            },
            {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose() {} }),
            } as vscode.CancellationToken
        );

        assert.strictEqual(infos.length, 1);
        interface ModelInfoWithTags {
            tags?: string[];
            capabilities: { toolCalling?: boolean; imageInput?: boolean };
        }
        const gpt4 = infos[0] as unknown as ModelInfoWithTags;
        assert.strictEqual(gpt4.capabilities.toolCalling, true);
        assert.strictEqual(gpt4.capabilities.imageInput, true);
        const gpt4Tags = gpt4.tags || [];
        assert.ok(gpt4Tags.includes("tools"), "Should include tools tag from capability override");
        assert.ok(gpt4Tags.includes("vision"), "Should include vision tag from capability override");
    });

    test("provideLanguageModelChatInformation returns empty when /model/info data is invalid", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({ data: undefined } as never);

        const infos = await provider.provideLanguageModelChatInformation(
            {
                silent: true,
                configuration: { providerName: "default", baseUrl: "http://localhost:4000", apiKey: "test-key" },
            },
            {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose() {} }),
            } as vscode.CancellationToken
        );

        assert.ok(Array.isArray(infos));
        assert.strictEqual(infos.length, 0);
    });

    test("provideLanguageModelChatInformation returns empty when /model/info throws", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").rejects(new Error("network"));

        const infos = await provider.provideLanguageModelChatInformation(
            {
                silent: true,
                configuration: { providerName: "default", baseUrl: "http://localhost:4000", apiKey: "test-key" },
            },
            {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose() {} }),
            } as vscode.CancellationToken
        );

        assert.ok(Array.isArray(infos));
        assert.strictEqual(infos.length, 0);
    });

    test("detectQuotaToolRedaction does not redact when quota tool is not present", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const detect = (
            provider as unknown as {
                detectQuotaToolRedaction: (
                    messages: readonly vscode.LanguageModelChatRequestMessage[],
                    tools: readonly vscode.LanguageModelChatTool[],
                    requestId: string,
                    modelId: string,
                    disableRedaction: boolean
                ) => { tools: readonly vscode.LanguageModelChatTool[] };
            }
        ).detectQuotaToolRedaction.bind(provider);

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("quota exceeded for insert_edit_into_file")],
            },
        ];
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "replace_string_in_file", description: "", inputSchema: {} },
        ];

        const result = detect(messages, tools, "req-3", "model-1", false);
        assert.strictEqual(result.tools.length, 1);
        assert.strictEqual(result.tools[0].name, "replace_string_in_file");
    });

    test("detectQuotaToolRedaction does not redact when message has no text", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const detect = (
            provider as unknown as {
                detectQuotaToolRedaction: (
                    messages: readonly vscode.LanguageModelChatRequestMessage[],
                    tools: readonly vscode.LanguageModelChatTool[],
                    requestId: string,
                    modelId: string,
                    disableRedaction: boolean
                ) => { tools: readonly vscode.LanguageModelChatTool[] };
            }
        ).detectQuotaToolRedaction.bind(provider);

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                // Empty content -> collectMessageText returns "" -> branch continues
                content: [],
            },
        ];
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "insert_edit_into_file", description: "", inputSchema: {} },
        ];

        const result = detect(messages, tools, "req-4", "model-1", false);
        assert.strictEqual(result.tools.length, 1);
        assert.strictEqual(result.tools[0].name, "insert_edit_into_file");
    });

    test("detectQuotaToolRedaction does not redact when quota regex does not match", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const detect = (
            provider as unknown as {
                detectQuotaToolRedaction: (
                    messages: readonly vscode.LanguageModelChatRequestMessage[],
                    tools: readonly vscode.LanguageModelChatTool[],
                    requestId: string,
                    modelId: string,
                    disableRedaction: boolean
                ) => { tools: readonly vscode.LanguageModelChatTool[] };
            }
        ).detectQuotaToolRedaction.bind(provider);

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("some other error insert_edit_into_file")],
            },
        ];
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "insert_edit_into_file", description: "", inputSchema: {} },
        ];

        const result = detect(messages, tools, "req-5", "model-1", false);
        assert.strictEqual(result.tools.length, 1);
        assert.strictEqual(result.tools[0].name, "insert_edit_into_file");
    });

    test("detectQuotaToolRedaction does not redact when tool regex does not match", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const detect = (
            provider as unknown as {
                detectQuotaToolRedaction: (
                    messages: readonly vscode.LanguageModelChatRequestMessage[],
                    tools: readonly vscode.LanguageModelChatTool[],
                    requestId: string,
                    modelId: string,
                    disableRedaction: boolean
                ) => { tools: readonly vscode.LanguageModelChatTool[] };
            }
        ).detectQuotaToolRedaction.bind(provider);

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("quota exceeded for some_other_tool")],
            },
        ];
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "insert_edit_into_file", description: "", inputSchema: {} },
        ];

        const result = detect(messages, tools, "req-6", "model-1", false);
        assert.strictEqual(result.tools.length, 1);
        assert.strictEqual(result.tools[0].name, "insert_edit_into_file");
    });

    test("detectQuotaToolRedaction does not redact on echoed Copilot context without rate/quota signal", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const detect = (
            provider as unknown as {
                detectQuotaToolRedaction: (
                    messages: readonly vscode.LanguageModelChatRequestMessage[],
                    tools: readonly vscode.LanguageModelChatTool[],
                    requestId: string,
                    modelId: string,
                    disableRedaction: boolean
                ) => { tools: readonly vscode.LanguageModelChatTool[] };
            }
        ).detectQuotaToolRedaction.bind(provider);

        const echoed =
            "<context>some huge context</context>\n" +
            "<editorContext>file stuff</editorContext>\n" +
            "tool insert_edit_into_file failed";

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [new vscode.LanguageModelTextPart(echoed)],
            },
        ];
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "insert_edit_into_file", description: "", inputSchema: {} },
            { name: "replace_string_in_file", description: "", inputSchema: {} },
        ];

        const result = detect(messages, tools, "req-echo", "model-1", false);
        assert.strictEqual(result.tools.length, 2);
    });

    test("isParameterSupported returns false when parameter probe cache indicates unsupported", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const isSupported = (
            provider as unknown as {
                isParameterSupported: (param: string, modelInfo: unknown, modelId?: string) => boolean;
            }
        ).isParameterSupported.bind(provider);

        // Seed cache to indicate 'temperature' is unsupported.
        (provider as unknown as { _parameterProbeCache: Map<string, Set<string>> })._parameterProbeCache.set(
            "gpt-5.2",
            new Set(["temperature"])
        );

        assert.strictEqual(isSupported("temperature", { supported_openai_params: ["temperature"] }, "gpt-5.2"), false);
    });

    test("isParameterSupported returns false when modelId matches known model limitations substring", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const isSupported = (
            provider as unknown as {
                isParameterSupported: (param: string, modelInfo: unknown, modelId?: string) => boolean;
            }
        ).isParameterSupported.bind(provider);

        // Use a model id that should match a known limitations key via substring.
        assert.strictEqual(isSupported("temperature", undefined, "o1-preview"), false);
    });

    test("stripUnsupportedParametersFromRequest removes cache keys inside extra_body and deletes empty containers", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const strip = (
            provider as unknown as {
                stripUnsupportedParametersFromRequest: (
                    requestBody: Record<string, unknown>,
                    modelInfo: unknown,
                    modelId?: string
                ) => void;
            }
        ).stripUnsupportedParametersFromRequest.bind(provider);

        const requestBody: Record<string, unknown> = {
            cache: { "no-cache": true },
            extra_body: { cache: { "no-cache": true, no_cache: true } },
        };

        strip(requestBody, undefined, "any");

        assert.ok(!("cache" in requestBody));
        assert.ok(!("extra_body" in requestBody));
    });

    test("provideTokenCount uses local counting for small strings", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const countTokensSpy = sandbox.spy(LiteLLMClient.prototype, "countTokens");

        const model = { id: "test-model" } as vscode.LanguageModelChatInformation;
        const text = "short text";
        const token = { isCancellationRequested: false } as vscode.CancellationToken;

        const count = await provider.provideTokenCount(model, text, token);

        assert.ok(count > 0);
        assert.strictEqual(countTokensSpy.called, false, "Should not call remote token counter for small strings");
    });

    test("provideTokenCount kicks off background refinement for large strings", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        sandbox.stub(provider as unknown as { _configManager: ConfigManager }, "_configManager").value({
            getConfig: async () => ({ url: "http://localhost:4000" }),
            resolveBackends: async () => [
                { name: "default", url: "http://localhost:4000", apiKey: "test-key", enabled: true },
            ],
            convertProviderConfiguration: () => ({
                backendName: "default",
                baseUrl: "http://localhost:4000",
                apiKey: "test-key",
                client: {
                    getModelInfo: async () => ({
                        data: [
                            {
                                model_name: "test-model",
                                model_info: { mode: "chat", supports_native_streaming: true },
                            },
                        ],
                    }),
                },
            }),
        });

        // Initialize multiBackendClient by calling discoverModels
        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({ data: [] });
        await provider.provideLanguageModelChatInformation(
            {
                silent: true,
                configuration: { providerName: "default", baseUrl: "http://localhost:4000", apiKey: "test-key" },
            },
            {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose() {} }),
            } as vscode.CancellationToken
        );

        const remoteCount = 123;
        const countTokensStub = sandbox
            .stub(MultiBackendClient.prototype, "countTokens")
            .resolves({ token_count: remoteCount });

        const model = { id: "default/test-model" } as vscode.LanguageModelChatInformation;
        const largeText = "a".repeat(600);
        const token = { isCancellationRequested: false } as vscode.CancellationToken;

        // First call - returns local count immediately, but kicks off background
        const count1 = await provider.provideTokenCount(model, largeText, token);
        assert.notStrictEqual(count1, remoteCount, "Should return local count immediately");

        // Wait for background debounce and execution
        await new Promise((resolve) => setTimeout(resolve, 600));

        assert.strictEqual(countTokensStub.callCount, 1, "Should have called remote counter in background");

        // Second call - should now return cached remote count
        const count2 = await provider.provideTokenCount(model, largeText, token);
        assert.strictEqual(count2, remoteCount, "Should return cached remote count on second call");
    });

    test("isParameterSupported returns true when parameter is explicitly supported and not blocked", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const isSupported = (
            provider as unknown as {
                isParameterSupported: (param: string, modelInfo: unknown, modelId?: string) => boolean;
            }
        ).isParameterSupported.bind(provider);

        const supported = isSupported("temperature", { supported_openai_params: ["temperature", "top_p"] }, "gpt-4.1");

        assert.strictEqual(supported, true);
    });

    test("stripUnsupportedParametersFromRequest preserves supported fields when model has no limitations", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const strip = (
            provider as unknown as {
                stripUnsupportedParametersFromRequest: (
                    requestBody: Record<string, unknown>,
                    modelInfo: unknown,
                    modelId?: string
                ) => void;
            }
        ).stripUnsupportedParametersFromRequest.bind(provider);

        const requestBody: Record<string, unknown> = {
            temperature: 0.4,
            top_p: 0.9,
            frequency_penalty: 0.2,
        };

        strip(requestBody, { supported_openai_params: ["temperature", "top_p", "frequency_penalty"] }, "gpt-4.1");

        assert.deepStrictEqual(requestBody, {
            temperature: 0.4,
            top_p: 0.9,
            frequency_penalty: 0.2,
        });
    });

    test("provideTokenCount returns local estimate when cancellation is already requested", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const countTokensStub = sandbox.stub(MultiBackendClient.prototype, "countTokens");

        const token = {
            isCancellationRequested: true,
            onCancellationRequested: () => ({ dispose() {} }),
        } as vscode.CancellationToken;

        const count = await provider.provideTokenCount(
            { id: "default/test-model" } as vscode.LanguageModelChatInformation,
            "a".repeat(800),
            token
        );

        assert.ok(count > 0);
        assert.strictEqual(countTokensStub.called, false);
    });

    test("provideLanguageModelChatInformation returns empty when all resolved backends are disabled", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string }>;
                resolveBackends: () => Promise<ResolvedBackend[]>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
        });
        sandbox.stub(providerWithConfig._configManager, "resolveBackends").resolves([]);

        const infos = await provider.provideLanguageModelChatInformation(
            { silent: true },
            new vscode.CancellationTokenSource().token
        );

        assert.deepStrictEqual(infos, []);
    });

    test("getModelTags does not add inline-completions when streaming is unsupported", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderForTagTesting {
            getModelTags: (
                modelId: string,
                modelInfo?: LiteLLMModelInfo,
                overrides?: Record<string, string[]>
            ) => string[];
        }
        const getModelTags = (provider as unknown as ProviderForTagTesting).getModelTags.bind(provider);

        const tags = getModelTags("plain-model", {
            mode: "chat",
            supports_native_streaming: false,
        });

        assert.strictEqual(tags.includes("inline-completions"), false);
    });

    test("discoverModels deduplicates in-flight requests", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        // Stub _doDiscoverModels to take some time
        const doDiscoverStub = sandbox.stub(access(provider), "_doDiscoverModels").callsFake(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return [];
        });

        const p1 = provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        const p2 = provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);

        await Promise.all([p1, p2]);
        assert.strictEqual(doDiscoverStub.callCount, 1);
    });

    test("discoverModels respects TTL for silent requests", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        access(provider)._lastModelList = [{ id: "m1" } as vscode.LanguageModelChatInformation];
        access(provider)._modelListFetchedAtMs = Date.now();
        const doDiscoverStub = sandbox.stub(access(provider), "_doDiscoverModels");

        const models = await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        assert.strictEqual(models.length, 1);
        assert.strictEqual(doDiscoverStub.called, false);
    });

    test("discoverModels bypasses TTL for non-silent requests", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        access(provider)._lastModelList = [{ id: "m1" } as vscode.LanguageModelChatInformation];
        access(provider)._modelListFetchedAtMs = Date.now();
        const doDiscoverStub = sandbox
            .stub(access(provider), "_doDiscoverModels")
            .resolves([{ id: "m2" } as vscode.LanguageModelChatInformation]);

        const models = await provider.discoverModels({ silent: false }, new vscode.CancellationTokenSource().token);
        assert.strictEqual(models[0].id, "m2");
        assert.strictEqual(doDiscoverStub.calledOnce, true);
    });

    test("_doDiscoverModels falls back to extension-managed backends when provider configuration is missing", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const configManager = access(provider)._configManager;
        sandbox
            .stub(configManager, "resolveBackends")
            .resolves([{ name: "cloud", url: "http://localhost:4000", apiKey: "k", enabled: true }]);
        sandbox.stub(MultiBackendClient.prototype, "getModelInfoAll").resolves({
            data: [
                {
                    backendName: "cloud",
                    namespacedId: "cloud/gpt-4o",
                    model_name: "gpt-4o",
                    model_info: {
                        litellm_provider: "openai",
                        mode: "chat",
                        supports_native_streaming: true,
                        max_input_tokens: 8192,
                        max_output_tokens: 4096,
                    } as LiteLLMModelInfo,
                },
            ],
        });
        const execStub = sandbox.stub(vscode.commands, "executeCommand").resolves(undefined);
        const models = await access(provider)._doDiscoverModels(
            { silent: false },
            new vscode.CancellationTokenSource().token
        );
        assert.strictEqual(execStub.calledWith("litellm-connector.manage"), false);
        assert.strictEqual(models.length, 1);
        assert.strictEqual(models[0].id, "cloud/gpt-4o");
    });

    test("_doDiscoverModels falls back to extension-managed backends when provider configuration is incomplete", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const configManager = access(provider)._configManager;
        sandbox
            .stub(configManager, "resolveBackends")
            .resolves([{ name: "cloud", url: "http://localhost:4000", apiKey: "k", enabled: true }]);
        sandbox.stub(MultiBackendClient.prototype, "getModelInfoAll").resolves({
            data: [
                {
                    backendName: "cloud",
                    namespacedId: "cloud/gpt-4o-mini",
                    model_name: "gpt-4o-mini",
                    model_info: {
                        litellm_provider: "openai",
                        mode: "chat",
                        supports_native_streaming: true,
                    } as LiteLLMModelInfo,
                },
            ],
        });

        const models = await access(provider)._doDiscoverModels(
            {
                silent: true,
                configuration: {
                    baseUrl: "http://localhost:4000",
                    // missing apiKey -> convertProviderConfiguration should fail, then legacy fallback runs
                },
            },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(models.length, 1);
        assert.strictEqual(models[0].id, "cloud/gpt-4o-mini");
    });

    test("_doDiscoverModels marks modern configuration detection when provider configuration is valid", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const configManager = access(provider)._configManager;
        const modernDetected = sandbox.spy();

        provider.setModernConfigurationDetectedHandler(modernDetected);

        const session: BackendSession = {
            backendName: "modern-group",
            baseUrl: "http://localhost:4000",
            apiKey: "k",
            client: {
                getModelInfo: async () => ({
                    data: [
                        {
                            model_name: "gpt-4o",
                            model_info: {
                                litellm_provider: "openai",
                                mode: "chat",
                                supports_native_streaming: true,
                                max_input_tokens: 8192,
                                max_output_tokens: 4096,
                            } as LiteLLMModelInfo,
                        },
                    ],
                }),
            } as unknown as LiteLLMClient,
        };

        sandbox.stub(configManager, "convertProviderConfiguration").returns(session);

        const models = await access(provider)._doDiscoverModels(
            {
                silent: true,
                groupName: "modern-group",
                configuration: {
                    baseUrl: "http://localhost:4000",
                    apiKey: "k",
                },
            },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(models.length, 1);
        assert.strictEqual(modernDetected.calledOnce, true);
    });

    test("_doDiscoverModels handles error gracefully", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const configManager = access(provider)._configManager;
        sandbox.stub(configManager, "getConfig").rejects(new Error("boom"));
        const models = await access(provider)._doDiscoverModels(
            { silent: true },
            new vscode.CancellationTokenSource().token
        );
        assert.strictEqual(models.length, 0);
    });

    test("getModelTags adds inline-edit for models containing 'coder' or 'code'", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const getModelTags = access(provider).getModelTags.bind(provider);

        assert.ok(getModelTags("my-coder-model").includes("inline-edit"));
        assert.ok(getModelTags("cool-code-model").includes("inline-edit"));
    });

    test("getModelTags adds tools tag for function-calling or vision models", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const getModelTags = access(provider).getModelTags.bind(provider);
        assert.ok(getModelTags("m1", { supports_function_calling: true } as LiteLLMModelInfo).includes("tools"));
        assert.ok(getModelTags("m2", { supports_vision: true } as LiteLLMModelInfo).includes("vision"));
        assert.ok(getModelTags("m3", { supported_openai_params: ["tools"] } as LiteLLMModelInfo).includes("tools"));
        assert.ok(
            getModelTags("m4", { supported_openai_params: ["tool_choice"] } as LiteLLMModelInfo).includes("tools")
        );
    });

    test("sanitizeErrorTextForLogs caps long text and removes prompt wrappers", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const sanitize = access(provider).sanitizeErrorTextForLogs.bind(provider);

        const input = "<context>Secret</context><editorContext>Code</editorContext>Some error";
        const output = sanitize(input);
        assert.ok(output.includes("<context>…</context>"));
        assert.ok(output.includes("<editorContext>…</editorContext>"));
        assert.ok(output.includes("Some error"));

        const longInput = "a".repeat(600);
        assert.strictEqual(sanitize(longInput).length, 501); // 500 chars + ellipsis
    });

    test("collectMessageText handles string content parts", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const collect = (
            provider as unknown as { collectMessageText: (m: vscode.LanguageModelChatRequestMessage) => string }
        ).collectMessageText.bind(provider);

        const msg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: ["hello", new vscode.LanguageModelTextPart(" world")] as unknown as vscode.LanguageModelTextPart[],
        } as unknown as vscode.LanguageModelChatRequestMessage;

        assert.strictEqual(collect(msg), "hello world");
    });

    test("parseApiError handles non-JSON error text", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const parse = access(provider).parseApiError.bind(provider);

        assert.strictEqual(parse(500, "Raw error message"), "Raw error message");
        assert.strictEqual(parse(500, ""), "API request failed with status 500");
    });
});
