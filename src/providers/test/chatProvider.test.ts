import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { ResponsesClient } from "../../adapters/responsesClient";
import { Logger } from "../../utils/logger";

suite("LiteLLM Chat Provider Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    const mockSecrets: vscode.SecretStorage = {
        get: async (key: string) => {
            if (key === "litellm-connector.baseUrl") {
                return "http://localhost:4000";
            }
            if (key === "litellm-connector.apiKey") {
                return "test-api-key";
            }
            return undefined;
        },
        store: async () => {},
        delete: async () => {},
        onDidChange: (_listener: unknown) => ({ dispose() {} }),
    } as unknown as vscode.SecretStorage;

    const userAgent = "GitHubCopilotChat/test VSCode/test";

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
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
                    },
                    { report: () => {} },
                    new vscode.CancellationTokenSource().token
                ),
            /LiteLLM configuration not found/
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
                        read: async () => {
                            const { done, value } = await reader.next();
                            return { done, value };
                        },
                        releaseLock: () => {},
                    };
                };
            }
            return stream;
        });

        sandbox.stub(ResponsesClient.prototype, "sendResponsesRequest").resolves();

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
            },
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

        sandbox.stub(ResponsesClient.prototype, "sendResponsesRequest").resolves();

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
            },
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
                    },
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
                    },
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
                    },
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
                    },
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

    test("provideLanguageModelChatResponse emits experimental usage data part after streaming", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const debugStub = sandbox.stub(Logger, "debug");

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string; experimentalEmitUsageData?: boolean }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox
            .stub(providerWithConfig._configManager, "getConfig")
            .resolves({ url: "http://localhost:4000", experimentalEmitUsageData: true });

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
        sandbox.stub(ResponsesClient.prototype, "sendResponsesRequest").resolves();

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
            },
            { report: (part) => reported.push(part) },
            new vscode.CancellationTokenSource().token
        );

        const usagePart = reported.find((part) => part instanceof vscode.LanguageModelDataPart);
        assert.ok(usagePart, "Expected a usage LanguageModelDataPart to be emitted");

        const dataPart = usagePart as vscode.LanguageModelDataPart;
        assert.strictEqual(dataPart.mimeType, "application/vnd.litellm.usage+json");
        const payload = JSON.parse(Buffer.from(dataPart.data).toString("utf-8")) as {
            kind: string;
            promptTokens: number;
            completionTokens: number;
        };
        assert.strictEqual(payload.kind, "usage");
        assert.ok(payload.promptTokens > 0);
        assert.ok(payload.completionTokens > 0);
        assert.ok(debugStub.calledWithMatch(sinon.match(/experimental usage data part/i)));
    });

    test("provideLanguageModelChatResponse handles empty stream without emitting parts", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string; experimentalEmitUsageData?: boolean }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            experimentalEmitUsageData: false,
        });

        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.close();
                },
            })
        );
        sandbox.stub(ResponsesClient.prototype, "sendResponsesRequest").resolves();

        const reported: unknown[] = [];
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
            },
            { report: (part) => reported.push(part) },
            new vscode.CancellationTokenSource().token
        );

        assert.deepStrictEqual(reported, []);
    });
});
