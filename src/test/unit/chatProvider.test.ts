import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProvider } from "../../providers";
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
                id: "m1",
                name: "m1",
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

        assert.strictEqual(stringCount, 2);

        const message: vscode.LanguageModelChatRequestMessage = {
            role: vscode.LanguageModelChatMessageRole.User,
            name: undefined,
            content: [new vscode.LanguageModelTextPart("1234"), new vscode.LanguageModelTextPart("abc")],
        };

        const messageCount = await provider.provideTokenCount(
            {
                id: "m1",
                name: "m1",
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

        assert.strictEqual(messageCount, 2);
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
                convertProviderConfiguration: (c: Record<string, unknown>) => { url: string };
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        sandbox.stub(providerWithConfig._configManager, "convertProviderConfiguration").returns({
            url: "http://localhost:4000",
        });

        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        const encoder = new TextEncoder();
        chatStub.onFirstCall().rejects(new Error("LiteLLM API error\nunsupported parameter"));
        chatStub.onSecondCall().callsFake(async (request: { temperature?: number; top_p?: number }) => {
            assert.strictEqual(request.temperature, undefined);
            assert.strictEqual(request.top_p, undefined);
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
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
                configuration: { baseUrl: "http://localhost:4000" },
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
                convertProviderConfiguration: (c: Record<string, unknown>) => { url: string };
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        sandbox.stub(providerWithConfig._configManager, "convertProviderConfiguration").returns({
            url: "http://localhost:4000",
        });

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
                        configuration: { baseUrl: "http://localhost:4000" },
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
                convertProviderConfiguration: (c: Record<string, unknown>) => { url: string };
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });
        sandbox.stub(providerWithConfig._configManager, "convertProviderConfiguration").returns({
            url: "http://localhost:4000",
        });

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
                        configuration: { baseUrl: "http://localhost:4000" },
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
                    },
                    { report: () => {} },
                    new vscode.CancellationTokenSource().token
                ),
            /boom/
        );
    });

    test("processDelta emits text and tool calls for streaming formats", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderForStreaming {
            processDelta: (
                delta: Record<string, unknown>,
                progress: vscode.Progress<vscode.LanguageModelResponsePart>
            ) => Promise<boolean>;
            resetStreamingState: () => void;
        }
        const providerForStreaming = provider as unknown as ProviderForStreaming;
        providerForStreaming.resetStreamingState();

        const parts: vscode.LanguageModelResponsePart[] = [];
        const progress = { report: (part: vscode.LanguageModelResponsePart) => parts.push(part) };

        await providerForStreaming.processDelta({ type: "response.output_text.delta", delta: "hello" }, progress);

        await providerForStreaming.processDelta(
            {
                type: "response.output_item.done",
                item: { type: "function_call", call_id: "call-1", name: "doThing", arguments: '{"x":1}' },
            },
            progress
        );

        const textParts = parts.filter((part) => part instanceof vscode.LanguageModelTextPart);
        const toolParts = parts.filter((part) => part instanceof vscode.LanguageModelToolCallPart);

        assert.strictEqual(textParts.length, 1);
        assert.strictEqual(toolParts.length, 1);
    });

    test("processDelta handles output_text content and no-choice cases", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderForStreaming {
            processDelta: (
                delta: Record<string, unknown>,
                progress: vscode.Progress<vscode.LanguageModelResponsePart>
            ) => Promise<boolean>;
            resetStreamingState: () => void;
        }
        const providerForStreaming = provider as unknown as ProviderForStreaming;
        providerForStreaming.resetStreamingState();

        const parts: vscode.LanguageModelResponsePart[] = [];
        const progress = { report: (part: vscode.LanguageModelResponsePart) => parts.push(part) };

        await providerForStreaming.processDelta(
            {
                output: [
                    {
                        content: [{ type: "output_text", text: "hello" }],
                        finish_reason: "stop",
                    },
                ],
            },
            progress
        );

        const noChoice = await providerForStreaming.processDelta({ foo: "bar" }, progress);
        assert.strictEqual(noChoice, false);
        assert.ok(parts.some((part) => part instanceof vscode.LanguageModelTextPart));
    });

    test("processDelta suppresses repeated text beyond threshold", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderForStreaming {
            processDelta: (
                delta: Record<string, unknown>,
                progress: vscode.Progress<vscode.LanguageModelResponsePart>
            ) => Promise<boolean>;
            resetStreamingState: () => void;
        }
        const providerForStreaming = provider as unknown as ProviderForStreaming;
        providerForStreaming.resetStreamingState();

        const parts: vscode.LanguageModelResponsePart[] = [];
        const progress = { report: (part: vscode.LanguageModelResponsePart) => parts.push(part) };

        for (let i = 0; i < 22; i++) {
            await providerForStreaming.processDelta({ type: "response.output_text.delta", delta: "repeat" }, progress);
        }

        const textParts = parts.filter((part) => part instanceof vscode.LanguageModelTextPart);
        assert.ok(textParts.length < 22);
    });

    test("processDelta buffers and emits OpenAI tool calls", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderForStreaming {
            processDelta: (
                delta: Record<string, unknown>,
                progress: vscode.Progress<vscode.LanguageModelResponsePart>
            ) => Promise<boolean>;
            resetStreamingState: () => void;
        }
        const providerForStreaming = provider as unknown as ProviderForStreaming;
        providerForStreaming.resetStreamingState();

        const parts: vscode.LanguageModelResponsePart[] = [];
        const progress = { report: (part: vscode.LanguageModelResponsePart) => parts.push(part) };

        await providerForStreaming.processDelta(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [{ index: 0, id: "call-1", function: { name: "tool", arguments: '{"a":1}' } }],
                        },
                        finish_reason: "tool_calls",
                    },
                ],
            },
            progress
        );

        const toolParts = parts.filter((part) => part instanceof vscode.LanguageModelToolCallPart);
        assert.strictEqual(toolParts.length, 1);
    });

    test("processTextContent parses text-encoded tool calls", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderForTextTools {
            processTextContent: (
                input: string,
                progress: vscode.Progress<vscode.LanguageModelResponsePart>
            ) => { emittedText: boolean; emittedAny: boolean };
            resetStreamingState: () => void;
        }
        const providerForTextTools = provider as unknown as ProviderForTextTools;
        providerForTextTools.resetStreamingState();

        const parts: vscode.LanguageModelResponsePart[] = [];
        const progress = { report: (part: vscode.LanguageModelResponsePart) => parts.push(part) };

        const input = 'Hello <|tool_call_begin|>tool:1<|tool_call_argument_begin|>{"x":1}<|tool_call_end|>';
        const result = providerForTextTools.processTextContent(input, progress);

        assert.strictEqual(result.emittedAny, true);
        assert.ok(parts.some((part) => part instanceof vscode.LanguageModelTextPart));
        assert.ok(parts.some((part) => part instanceof vscode.LanguageModelToolCallPart));
    });

    test("processTextContent handles partial tool call tokens", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderForTextTools {
            processTextContent: (
                input: string,
                progress: vscode.Progress<vscode.LanguageModelResponsePart>
            ) => { emittedText: boolean; emittedAny: boolean };
            resetStreamingState: () => void;
        }
        const providerForTextTools = provider as unknown as ProviderForTextTools;
        providerForTextTools.resetStreamingState();

        const parts: vscode.LanguageModelResponsePart[] = [];
        const progress = { report: (part: vscode.LanguageModelResponsePart) => parts.push(part) };

        const first = providerForTextTools.processTextContent("<|tool_call_be", progress);
        assert.strictEqual(first.emittedText, true);

        const second = providerForTextTools.processTextContent(
            "gin|>tool:1<|tool_call_argument_begin|>{}<|tool_call_end|>",
            progress
        );
        assert.strictEqual(second.emittedAny, true);

        assert.strictEqual(
            parts.some((part) => part instanceof vscode.LanguageModelToolCallPart),
            false
        );
    });

    test("processStreamingResponse handles non-data lines and done signal", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderForStream {
            processStreamingResponse: (
                responseBody: ReadableStream<Uint8Array>,
                progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                token: vscode.CancellationToken
            ) => Promise<void>;
            resetStreamingState: () => void;
            _configManager: { getConfig: () => Promise<{ inactivityTimeout?: number }> };
        }
        const providerForStream = provider as unknown as ProviderForStream;
        providerForStream.resetStreamingState();
        sandbox.stub(providerForStream._configManager, "getConfig").resolves({ inactivityTimeout: 60 });

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode("not-data\n"));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            },
        });

        const parts: vscode.LanguageModelResponsePart[] = [];
        const progress = { report: (part: vscode.LanguageModelResponsePart) => parts.push(part) };

        await providerForStream.processStreamingResponse(stream, progress, new vscode.CancellationTokenSource().token);

        assert.strictEqual(parts.length, 0);
    });

    test("processStreamingResponse appends truncation notice and handles parse errors", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderForStream {
            processStreamingResponse: (
                responseBody: ReadableStream<Uint8Array>,
                progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                token: vscode.CancellationToken
            ) => Promise<void>;
            resetStreamingState: () => void;
            _configManager: { getConfig: () => Promise<{ inactivityTimeout?: number }> };
        }
        const providerForStream = provider as unknown as ProviderForStream;
        providerForStream.resetStreamingState();
        sandbox.stub(providerForStream._configManager, "getConfig").resolves({ inactivityTimeout: 60 });

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode("data: {not-json}\n\n"));
                controller.enqueue(
                    encoder.encode('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"length"}]}\n\n')
                );
                controller.close();
            },
        });

        const parts: vscode.LanguageModelResponsePart[] = [];
        const progress = { report: (part: vscode.LanguageModelResponsePart) => parts.push(part) };

        await providerForStream.processStreamingResponse(stream, progress, new vscode.CancellationTokenSource().token);

        const textParts = parts.filter((part) => part instanceof vscode.LanguageModelTextPart);
        assert.ok(
            textParts.some((part) => (part as vscode.LanguageModelTextPart).value.includes("Response truncated"))
        );
    });

    test("processStreamingResponse cancels on inactivity timeout and token cancellation", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderForStream {
            processStreamingResponse: (
                responseBody: ReadableStream<Uint8Array>,
                progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                token: vscode.CancellationToken
            ) => Promise<void>;
            resetStreamingState: () => void;
            _configManager: { getConfig: () => Promise<{ inactivityTimeout?: number }> };
        }
        const providerForStream = provider as unknown as ProviderForStream;
        providerForStream.resetStreamingState();
        sandbox.stub(providerForStream._configManager, "getConfig").resolves({ inactivityTimeout: 0 });

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            },
        });

        const token: vscode.CancellationToken = {
            isCancellationRequested: true,
            onCancellationRequested: (handler: () => void) => {
                handler();
                return { dispose() {} };
            },
        } as vscode.CancellationToken;

        const clock = sandbox.useFakeTimers({ shouldClearNativeTimers: true });
        const parts: vscode.LanguageModelResponsePart[] = [];
        const progress = { report: (part: vscode.LanguageModelResponsePart) => parts.push(part) };

        const promise = providerForStream.processStreamingResponse(stream, progress, token);
        await clock.runAllAsync();
        await promise;
    });

    test("emitTextToolCallIfValid and tryEmitBufferedToolCall emit tool calls", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderInternals {
            emitTextToolCallIfValid: (
                progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                call: { name?: string; index?: number; argBuffer: string; emitted?: boolean },
                argText: string
            ) => boolean;
            tryEmitBufferedToolCall: (
                index: number,
                progress: vscode.Progress<vscode.LanguageModelResponsePart>
            ) => Promise<void>;
            resetStreamingState: () => void;
        }
        const providerInternals = provider as unknown as ProviderInternals;
        providerInternals.resetStreamingState();

        const parts: vscode.LanguageModelResponsePart[] = [];
        const progress = { report: (part: vscode.LanguageModelResponsePart) => parts.push(part) };

        const didEmit = providerInternals.emitTextToolCallIfValid(progress, { name: "tool", argBuffer: "" }, "{}");
        assert.strictEqual(didEmit, true);

        interface ProviderBuffers {
            _toolCallBuffers: Map<number, { id?: string; name?: string; args: string }>;
        }
        const providerBuffers = provider as unknown as ProviderBuffers;
        providerBuffers._toolCallBuffers.set(0, { id: "call-1", name: "tool", args: '{"ok":true}' });
        await providerInternals.tryEmitBufferedToolCall(0, progress);

        const toolParts = parts.filter((part) => part instanceof vscode.LanguageModelToolCallPart);
        assert.strictEqual(toolParts.length, 2);
    });

    test("emitTextToolCallIfValid rejects duplicates and invalid JSON", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderInternals {
            emitTextToolCallIfValid: (
                progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                call: { name?: string; index?: number; argBuffer: string; emitted?: boolean },
                argText: string
            ) => boolean;
            resetStreamingState: () => void;
        }
        const providerInternals = provider as unknown as ProviderInternals;
        providerInternals.resetStreamingState();

        const parts: vscode.LanguageModelResponsePart[] = [];
        const progress = { report: (part: vscode.LanguageModelResponsePart) => parts.push(part) };

        const first = providerInternals.emitTextToolCallIfValid(
            progress,
            { name: "tool", index: 1, argBuffer: "" },
            "{}"
        );
        const second = providerInternals.emitTextToolCallIfValid(
            progress,
            { name: "tool", index: 1, argBuffer: "" },
            "{}"
        );
        const invalid = providerInternals.emitTextToolCallIfValid(progress, { name: "tool", argBuffer: "" }, "{");

        assert.strictEqual(first, true);
        assert.strictEqual(second, false);
        assert.strictEqual(invalid, false);
    });

    test("tryEmitBufferedToolCall ignores invalid JSON and flushToolCallBuffers throws on invalid", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderInternals {
            tryEmitBufferedToolCall: (
                index: number,
                progress: vscode.Progress<vscode.LanguageModelResponsePart>
            ) => Promise<void>;
            flushToolCallBuffers: (
                progress: vscode.Progress<vscode.LanguageModelResponsePart>,
                throwOnInvalid: boolean
            ) => Promise<void>;
            resetStreamingState: () => void;
        }
        const providerInternals = provider as unknown as ProviderInternals;
        providerInternals.resetStreamingState();

        interface ProviderBuffers {
            _toolCallBuffers: Map<number, { id?: string; name?: string; args: string }>;
        }
        const providerBuffers = provider as unknown as ProviderBuffers;
        providerBuffers._toolCallBuffers.set(1, { id: "call-1", name: "tool", args: "{" });

        const parts: vscode.LanguageModelResponsePart[] = [];
        const progress = { report: (part: vscode.LanguageModelResponsePart) => parts.push(part) };

        await providerInternals.tryEmitBufferedToolCall(1, progress);
        assert.strictEqual(parts.length, 0);

        await assert.rejects(() => providerInternals.flushToolCallBuffers(progress, true), /Invalid JSON/);
    });

    test("stripControlTokens removes tool and section markers", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderInternals {
            stripControlTokens: (text: string) => string;
        }
        const providerInternals = provider as unknown as ProviderInternals;

        const cleaned = providerInternals.stripControlTokens(
            "hello <|tool_call_begin|>x<|tool_call_end|> <|analysis_section_begin|>y<|analysis_section_end|>"
        );

        assert.strictEqual(cleaned.includes("tool_call"), false);
        assert.strictEqual(cleaned.includes("analysis_section"), false);
    });
});
