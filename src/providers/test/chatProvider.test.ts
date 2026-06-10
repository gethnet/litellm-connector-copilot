import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { Logger } from "../../utils/logger";
import { LiteLLMTelemetry } from "../../utils/telemetry";
import { createMockSecrets } from "../../test/utils/testMocks";
import { createTelemetryMocks } from "../../test/utils/telemetryMock";

/**
 * Seeds the per-group discovery state on a provider so the new routing path
 * (`resolveBackendForCall`) finds a backend during the request flow.
 *
 * The single-provider architecture moved routing identity from a global model
 * list keyed by hostname-namespaced IDs to call-time configuration. Tests
 * pre-dating the migration stub `getConfig().url` only; this helper bridges
 * them by stubbing `resolveBackendForCall` to return a known session.
 */
function seedDiscoveredBackend(sandbox: sinon.SinonSandbox, provider: LiteLLMChatProvider, modelId: string): void {
    const seededModel = {
        id: modelId,
        name: modelId,
        tooltip: "",
        family: "litellm",
        version: "1.0.0",
        maxInputTokens: 1000,
        maxOutputTokens: 1000,
        capabilities: { toolCalling: true, imageInput: false },
    } as unknown as vscode.LanguageModelChatInformation;

    // The BackendRegistry is the single source of truth. We reach into
    // its private `setModelsForBackend` write path to seed a known
    // (id → backend) mapping without going through the public
    // `discoverModels` ingress. This is a test-only seam: production
    // code never calls `setModelsForBackend` directly. We use a typed
    // `Internals` interface (cast via `unknown`) to keep this typed
    // and avoid `any` casts at the call site. The test cares about
    // the response-time routing path, not the discovery HTTP fetch.
    interface Internals {
        _registry: {
            setModelsForBackend: (
                baseUrl: string,
                apiKey: string,
                routingIdentity: string,
                models: vscode.LanguageModelChatInformation[]
            ) => void;
        };
        _configManager: {
            convertProviderConfiguration: (
                groupName: string,
                configuration: Record<string, unknown>
            ) => { backendName: string; baseUrl: string; apiKey: string } | undefined;
        };
    }
    const providerInternals = provider as unknown as Internals;
    providerInternals._registry.setModelsForBackend("http://localhost:4000", "test-api-key", "localhost:4000", [
        seededModel,
    ]);
    sandbox.stub(providerInternals._configManager, "convertProviderConfiguration").returns({
        backendName: "localhost:4000",
        baseUrl: "http://localhost:4000",
        apiKey: "test-api-key",
        client: {} as never,
    } as never);
}

suite("LiteLLM Chat Provider Unit Tests", () => {
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

    test("provideTokenCount handles string and message inputs", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const tokenSource = new vscode.CancellationTokenSource();

        const stringCount = await provider.provideTokenCount(
            {
                id: "gpt-4",
                name: "gpt-4",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
            },
            "12345",
            tokenSource.token
        );

        // "12345" -> 1-2 tokens depending on tokenizer
        assert.ok(
            stringCount >= 1 && stringCount <= 2,
            `stringCount (${stringCount}) should be within expected range [1, 2]`
        );

        const message: vscode.LanguageModelChatRequestMessage = {
            role: vscode.LanguageModelChatMessageRole.User,
            name: undefined,
            content: [new vscode.LanguageModelTextPart("1234"), new vscode.LanguageModelTextPart("abc")],
        };

        const messageCount = await provider.provideTokenCount(
            {
                id: "gpt-4",
                name: "gpt-4",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
            },
            message,
            tokenSource.token
        );

        // "1234" (1) + "abc" (1) + overhead (3) = 5 (or 6 depending on role/message formatting)
        assert.ok(
            messageCount >= 2 && messageCount <= 6,
            `messageCount (${messageCount}) should be within expected range [2, 6]`
        );
    });

    test("provideLanguageModelChatResponse throws when config URL is missing", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: { getConfig: () => Promise<{ url?: string }> };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: undefined });

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("hi")],
            },
        ];

        await assert.rejects(
            () =>
                provider.provideLanguageModelChatResponse(
                    model,
                    messages,
                    {
                        modelOptions: {},
                        tools: [],
                        toolMode: vscode.LanguageModelChatToolMode.Auto,
                        requestInitiator: "test",
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    { report: () => {} },
                    new vscode.CancellationTokenSource().token
                ),
            /No baseUrl|No apiKey|configure the LiteLLM provider group/i
        );
    });

    test("provideLanguageModelChatResponse retries without optional parameters on unsupported param error", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        // Seed the discovered model list so the new per-group routing path in
        // `sendRequestToLiteLLM` (which prefers `getDiscoveredModelBackend` over legacy
        // `resolveBackends`) finds a backend. Without this the request fails with
        // "LiteLLM configuration not found" before reaching the stubbed `chat` call.
        seedDiscoveredBackend(sandbox, provider, "model-1");

        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        const encoder = new TextEncoder();
        chatStub.onFirstCall().rejects(new Error("LiteLLM API error\nunsupported parameter"));
        chatStub.onSecondCall().callsFake(async (request: { temperature?: number; top_p?: number }) => {
            assert.strictEqual(request.temperature, undefined);
            assert.strictEqual(request.top_p, undefined);
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
            // Ensure the mock stream has getReader for decodeSSE
            if (!(stream as unknown as { getReader: unknown }).getReader) {
                (stream as unknown as { getReader: () => unknown }).getReader = () => {
                    const reader = (stream as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
                    return {
                        read: async (): Promise<{ done: boolean | undefined; value: Uint8Array | undefined }> => {
                            const next = (await reader.next()) as IteratorResult<Uint8Array, undefined>;
                            return { done: next.done, value: next.value };
                        },
                        releaseLock: () => {},
                    };
                };
            }
            return stream;
        });

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("hi")],
            },
        ];

        await provider.provideLanguageModelChatResponse(
            model,
            messages,
            {
                modelOptions: { temperature: 0.9, top_p: 0.8 },
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: () => {} },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(chatStub.callCount, 2);
    });

    test("provideLanguageModelChatResponse refreshes model override and logs when refresh fails", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string; modelIdOverride?: string }>;
            };
            discoverModels: (options: { silent: boolean }, token: vscode.CancellationToken) => Promise<void>;
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox
            .stub(providerWithConfig._configManager, "getConfig")
            .resolves({ url: "http://localhost:4000", modelIdOverride: "override" });
        sandbox.stub(providerWithConfig, "discoverModels").rejects(new Error("refresh failed"));
        // Seed discovered backend so the routing path doesn't reject before we exercise the
        // override refresh warning behaviour.
        seedDiscoveredBackend(sandbox, provider, "model-1");
        const warnStub = sandbox.stub(Logger, "warn");

        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        const encoder = new TextEncoder();
        chatStub.callsFake(
            async () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                        controller.close();
                    },
                })
        );

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        await provider.provideLanguageModelChatResponse(
            model,
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: () => {} },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(warnStub.called, true);
    });

    test("provideLanguageModelChatResponse throws on cancellation during request", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        sandbox.stub(LiteLLMClient.prototype, "chat").rejects(new Error("boom"));

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const token: vscode.CancellationToken = {
            isCancellationRequested: true,
            onCancellationRequested: () => ({ dispose() {} }),
        } as vscode.CancellationToken;

        await assert.rejects(
            () =>
                provider.provideLanguageModelChatResponse(
                    model,
                    [
                        {
                            role: vscode.LanguageModelChatMessageRole.User,
                            name: undefined,
                            content: [new vscode.LanguageModelTextPart("hi")],
                        },
                    ],
                    {
                        modelOptions: {},
                        tools: [],
                        toolMode: vscode.LanguageModelChatToolMode.Auto,
                        requestInitiator: "test",
                        configuration: {
                            baseUrl: "http://localhost:4000",
                            apiKey: "test-api-key",
                        } as unknown as Record<string, unknown>,
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    { report: () => {} },
                    token
                ),
            /Operation cancelled by user/
        );
    });

    test("provideLanguageModelChatResponse surfaces parsed API error details", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        sandbox
            .stub(LiteLLMClient.prototype, "chat")
            .rejects(new Error('LiteLLM API error\n{"error":{"message":"temperature unsupported"}}'));

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("hi")],
            },
        ];

        await assert.rejects(
            () =>
                provider.provideLanguageModelChatResponse(
                    model,
                    messages,
                    {
                        modelOptions: { temperature: 0.9 },
                        tools: [],
                        toolMode: vscode.LanguageModelChatToolMode.Auto,
                        requestInitiator: "test",
                        configuration: {
                            baseUrl: "http://localhost:4000",
                            apiKey: "test-api-key",
                        } as unknown as Record<string, unknown>,
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    { report: () => {} },
                    new vscode.CancellationTokenSource().token
                ),
            /temperature unsupported/i
        );
    });

    test("provideLanguageModelChatResponse decorates temperature-related API errors", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        sandbox
            .stub(LiteLLMClient.prototype, "chat")
            .rejects(new Error('LiteLLM API error\n{"error":{"message":"temperature"}}'));

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        await assert.rejects(
            () =>
                provider.provideLanguageModelChatResponse(
                    model,
                    [
                        {
                            role: vscode.LanguageModelChatMessageRole.User,
                            name: undefined,
                            content: [new vscode.LanguageModelTextPart("hi")],
                        },
                    ],
                    {
                        modelOptions: { temperature: 0.9 },
                        tools: [],
                        toolMode: vscode.LanguageModelChatToolMode.Auto,
                        requestInitiator: "test",
                        configuration: {
                            baseUrl: "http://localhost:4000",
                            apiKey: "test-api-key",
                        } as unknown as Record<string, unknown>,
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    { report: () => {} },
                    new vscode.CancellationTokenSource().token
                ),
            /may not support certain parameters/i
        );
    });

    test("provideLanguageModelChatResponse rethrows non-API errors", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: { getConfig: () => Promise<{ url: string }> };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        sandbox.stub(LiteLLMClient.prototype, "chat").rejects(new Error("boom"));

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        await assert.rejects(
            () =>
                provider.provideLanguageModelChatResponse(
                    model,
                    [
                        {
                            role: vscode.LanguageModelChatMessageRole.User,
                            name: undefined,
                            content: [new vscode.LanguageModelTextPart("hi")],
                        },
                    ],
                    {
                        modelOptions: {},
                        tools: [],
                        toolMode: vscode.LanguageModelChatToolMode.Auto,
                        requestInitiator: "test",
                        configuration: {
                            baseUrl: "http://localhost:4000",
                            apiKey: "test-api-key",
                        } as unknown as Record<string, unknown>,
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    { report: () => {} },
                    new vscode.CancellationTokenSource().token
                ),
            /boom/
        );
    });

    test("provideLanguageModelChatResponse handles streaming response", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const tokenSource = new vscode.CancellationTokenSource();

        // Mock LiteLLMClient.chat to return a stream.
        // Important: `decodeSSE` splits on single newlines, so each SSE line must end with `\n`.
        const encoder = new TextEncoder();
        // Note: VS Code extension host runs on Node, which doesn't always provide a global
        // Web `ReadableStream`. Use Node's implementation to ensure `.getReader()` exists.
        const { ReadableStream } = await import("node:stream/web");
        const makeStream = () =>
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n'));
                    controller.enqueue(encoder.encode("data: [DONE]\n"));
                    controller.close();
                },
            });

        // `LiteLLMProviderBase` constructs its own `LiteLLMClient`, so stubbing the prototype
        // doesn't always intercept in the extension host test environment.
        // (Not needed for this test since we call `processStreamingResponse` directly.)

        const parts: vscode.LanguageModelResponsePart[] = [];
        const progress = { report: (part: vscode.LanguageModelResponsePart) => parts.push(part) };

        // We need to mock the config for inactivity timeout
        interface ProviderWithConfig {
            _configManager: {
                getConfig: () => Promise<unknown>;
            };
        }
        const pWithConfig = provider as unknown as ProviderWithConfig;
        sandbox.stub(pWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            inactivityTimeout: 60,
        });

        // Sanity-check the SSE decoder itself.
        const { decodeSSE } = await import("../../adapters/sse/sseDecoder.js");
        const decoded: string[] = [];
        for await (const payload of decodeSSE(makeStream(), tokenSource.token)) {
            decoded.push(payload);
        }
        assert.deepStrictEqual(decoded, ['{"choices":[{"delta":{"content":"Hello"}}]}']);

        // Exercise the streaming pipeline directly (deterministic unit test).
        // We MUST reset the streaming state so that the internal _streamingState is initialized.
        const providerAsChat = provider as LiteLLMChatProvider;
        // Accessing protected members for testing
        const providerTest = providerAsChat as unknown as {
            resetStreamingState: () => void;
            _streamingState: unknown;
            processStreamingResponse: (
                stream: AsyncIterable<string>,
                progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                token: vscode.CancellationToken
            ) => Promise<void>;
        };

        if (typeof providerTest.resetStreamingState === "function") {
            providerTest.resetStreamingState();
        } else if (providerTest._streamingState === undefined) {
            // Fallback for older versions or if the method is truly private and not exposed via any
            const { createInitialStreamingState } =
                await import("../../adapters/streaming/liteLLMStreamInterpreter.js");
            (providerTest as { _streamingState: unknown })._streamingState = createInitialStreamingState();
        }

        await providerTest.processStreamingResponse(
            makeStream() as unknown as AsyncIterable<string>,
            progress,
            tokenSource.token
        );

        // Avoid brittle `instanceof` checks in the extension host (multiple `vscode` module instances can exist).
        // Instead, assert on the structural shape of the emitted parts.
        const textParts = parts.filter(
            (p): p is vscode.LanguageModelTextPart =>
                p instanceof vscode.LanguageModelTextPart ||
                typeof (p as unknown as Record<string, unknown>)?.value === "string"
        );
        assert.ok(
            textParts.length > 0,
            `Expected at least one text part, got: ${parts.map((p) => p.constructor?.name).join(", ")}`
        );
        assert.strictEqual(textParts.map((p) => p.value).join(""), "Hello");
    });

    test("provideLanguageModelChatResponse emits usage data part via StreamTokenCapture after streaming", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        const encoder = new TextEncoder();
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(
            async () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                        controller.close();
                    },
                })
        );

        const model: vscode.LanguageModelChatInformation = {
            id: "model-1",
            name: "model-1",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const reported: vscode.LanguageModelResponsePart[] = [];
        await provider.provideLanguageModelChatResponse(
            model,
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => reported.push(part) },
            new vscode.CancellationTokenSource().token
        );

        // Usage data should now be emitted by StreamTokenCapture.flushUsage()
        const usagePart = reported.find((part) => part instanceof vscode.LanguageModelDataPart);
        assert.ok(usagePart, "Expected a usage LanguageModelDataPart to be emitted by StreamTokenCapture");
        assert.strictEqual(usagePart.mimeType, "usage");

        // Verify the usage payload has the expected structure
        const payload = JSON.parse(Buffer.from(usagePart.data).toString("utf-8")) as {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
        };
        assert.ok(payload.prompt_tokens > 0, "Expected prompt_tokens to be positive");
        assert.ok(payload.completion_tokens > 0, "Expected completion_tokens to be positive");
        assert.strictEqual(payload.total_tokens, payload.prompt_tokens + payload.completion_tokens);
    });

    test("requests usage by default and suppresses include_usage after upstream rejects stream_options", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const providerAny = provider as unknown as {
            _usageOptOutModels: Set<string>;
            buildOpenAIChatRequest: (typeof LiteLLMChatProvider.prototype)["buildOpenAIChatRequest"];
            sendRequestWithRetry: (typeof LiteLLMChatProvider.prototype)["sendRequestWithRetry"];
            _configManager: { getConfig: () => Promise<{ url: string }> };
        };

        sandbox.stub(providerAny._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-usage");

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("hi")],
            },
        ];
        const model = {
            id: "model-usage",
            name: "model-usage",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 1000,
            maxOutputTokens: 1000,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const requestBody = await providerAny.buildOpenAIChatRequest(
            messages,
            model,
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            undefined,
            "chat"
        );
        assert.deepStrictEqual(requestBody.stream_options, { include_usage: true });

        const encoder = new TextEncoder();
        const successStream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}' + "\n\n"));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            },
        });

        const sendStub = sandbox
            .stub(providerAny, "sendRequestWithRetry")
            .onFirstCall()
            .rejects(new Error("LiteLLM API error: 400\nUnsupported parameter: stream_options"))
            .onSecondCall()
            .resolves(successStream);

        const reported: vscode.LanguageModelResponsePart[] = [];
        await provider.provideLanguageModelChatResponse(
            model,
            messages,
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => reported.push(part) },
            new vscode.CancellationTokenSource().token
        );

        assert.ok(
            providerAny._usageOptOutModels.has("model-usage"),
            "Model should be marked as usage opt-out after rejection"
        );
        assert.strictEqual(sendStub.callCount, 2);
    });

    test("prefers streamed usage metrics over estimated counts", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        sandbox
            .stub(
                (
                    provider as unknown as {
                        _configManager: {
                            getConfig: () => Promise<{ url: string }>;
                        };
                    }
                )._configManager,
                "getConfig"
            )
            .resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-usage");

        const encoder = new TextEncoder();
        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}' + "\n\n"));
                    controller.enqueue(
                        encoder.encode(
                            'data: {"usage":{"prompt_tokens":12,"completion_tokens":7,"input_token_details":{"cached_tokens":3},"output_token_details":{"reasoning_tokens":2},"system_tokens":5}}' +
                                "\n\n"
                        )
                    );
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            })
        );

        const telemetrySpy = sandbox.spy(LiteLLMTelemetry, "reportMetric");
        const parts: vscode.LanguageModelResponsePart[] = [];
        await provider.provideLanguageModelChatResponse(
            {
                id: "model-usage",
                name: "model-usage",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
            },
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => parts.push(part) },
            new vscode.CancellationTokenSource().token
        );

        const usagePart = parts.find((p) => p instanceof vscode.LanguageModelDataPart) as vscode.LanguageModelDataPart;
        const payload = JSON.parse(Buffer.from(usagePart.data).toString("utf-8")) as Record<string, unknown>;
        assert.strictEqual(payload.prompt_tokens, 12);
        assert.strictEqual(payload.completion_tokens, 7);
        assert.strictEqual((payload.prompt_tokens_details as { cached_tokens: number }).cached_tokens, 3);
        assert.strictEqual(
            (payload.completion_tokens_details as { reasoning_tokens: number; tool_tokens: number }).reasoning_tokens,
            2
        );
        assert.strictEqual(
            (payload.completion_tokens_details as { reasoning_tokens: number; tool_tokens?: number }).tool_tokens,
            undefined
        );
        assert.strictEqual(payload.system_prompt_tokens, 5);

        sinon.assert.calledWithMatch(telemetrySpy, sinon.match({ tokensIn: 12, tokensOut: 7 }));
    });

    test("merges partial usage frames to avoid dropping previously reported token details", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        sandbox
            .stub(
                (
                    provider as unknown as {
                        _configManager: {
                            getConfig: () => Promise<{ url: string }>;
                        };
                    }
                )._configManager,
                "getConfig"
            )
            .resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-partial-usage");

        const encoder = new TextEncoder();
        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}' + "\n\n"));
                    controller.enqueue(
                        encoder.encode(
                            'data: {"usage":{"prompt_tokens":12,"completion_tokens":5,"input_token_details":{"cached_tokens":3},"output_token_details":{"reasoning_tokens":2,"tool_tokens":1},"system_tokens":5}}' +
                                "\n\n"
                        )
                    );
                    // Simulate a later sparse usage frame from upstream that omits details or sends lower values.
                    controller.enqueue(
                        encoder.encode('data: {"usage":{"prompt_tokens":12,"completion_tokens":7}}' + "\n\n")
                    );
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            })
        );

        const usageParts: vscode.LanguageModelDataPart[] = [];
        await provider.provideLanguageModelChatResponse(
            {
                id: "model-partial-usage",
                name: "model-partial-usage",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
            },
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            {
                report: (part) => {
                    if (part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage") {
                        usageParts.push(part);
                    }
                },
            },
            new vscode.CancellationTokenSource().token
        );

        assert.ok(usageParts.length >= 2, "Expected at least two usage data frames");
        const finalPayload = JSON.parse(Buffer.from(usageParts[usageParts.length - 1].data).toString("utf-8")) as {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
            system_prompt_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
            completion_tokens_details?: { reasoning_tokens?: number; tool_tokens?: number };
        };

        assert.strictEqual(finalPayload.prompt_tokens, 12);
        assert.strictEqual(finalPayload.completion_tokens, 7);
        assert.strictEqual(finalPayload.total_tokens, 19);
        assert.strictEqual(finalPayload.prompt_tokens_details?.cached_tokens, 3);
        assert.strictEqual(finalPayload.completion_tokens_details?.reasoning_tokens, 2);
        assert.strictEqual(finalPayload.completion_tokens_details?.tool_tokens, 1);
        assert.strictEqual(finalPayload.system_prompt_tokens, 5);
    });

    test("counts tool-call only responses in fallback token reporting", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        sandbox
            .stub(
                (
                    provider as unknown as {
                        _configManager: {
                            getConfig: () => Promise<{ url: string }>;
                        };
                    }
                )._configManager,
                "getConfig"
            )
            .resolves({ url: "http://localhost:4000" });
        seedDiscoveredBackend(sandbox, provider, "model-tool-only");

        const encoder = new TextEncoder();
        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        encoder.encode(
                            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}' +
                                "\n\n"
                        )
                    );
                    controller.enqueue(encoder.encode('data: {"choices":[{"finish_reason":"tool_calls"}]}' + "\n\n"));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            })
        );

        const telemetrySpy = sandbox.spy(LiteLLMTelemetry, "reportMetric");
        const parts: vscode.LanguageModelResponsePart[] = [];
        await provider.provideLanguageModelChatResponse(
            {
                id: "model-tool-only",
                name: "model-tool-only",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
            },
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => parts.push(part) },
            new vscode.CancellationTokenSource().token
        );

        const usagePart = parts.find((part) => part instanceof vscode.LanguageModelDataPart) as
            | vscode.LanguageModelDataPart
            | undefined;
        if (usagePart) {
            const payload = JSON.parse(Buffer.from(usagePart.data).toString("utf-8")) as {
                completion_tokens: number;
                completion_tokens_details?: { tool_tokens?: number };
            };
            assert.ok(payload.completion_tokens > 0);
            assert.ok((payload.completion_tokens_details?.tool_tokens ?? 0) > 0);
        }
        sinon.assert.calledWithMatch(
            telemetrySpy,
            sinon.match((metric: unknown) => {
                const typedMetric = metric as { tokensOut?: number; toolTokens?: number };
                return (typedMetric.tokensOut ?? 0) > 0 && (typedMetric.toolTokens ?? 0) > 0;
            })
        );
    });

    test("provideLanguageModelChatResponse handles empty stream without emitting parts", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
        });
        seedDiscoveredBackend(sandbox, provider, "model-1");

        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.close();
                },
            })
        );

        const reported: vscode.LanguageModelResponsePart[] = [];
        await provider.provideLanguageModelChatResponse(
            {
                id: "model-1",
                name: "model-1",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
            },
            [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("hi")],
                },
            ],
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-api-key" } as unknown as Record<
                    string,
                    unknown
                >,
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: (part) => reported.push(part) },
            new vscode.CancellationTokenSource().token
        );

        // Empty stream should not emit any parts (including usage data)
        // flushUsage() checks for empty token counts and skips emission
        assert.deepStrictEqual(reported.length, 0, "Expected no parts to be emitted for empty stream");
    });
});
