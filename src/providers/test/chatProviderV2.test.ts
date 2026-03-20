import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMChatProviderV2 } from "../liteLLMChatProviderV2";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { normalizeMessagesForV2Pipeline, convertV2MessagesToProviderMessages } from "../../utils";

suite("LiteLLM Chat Provider V2 Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    const mockSecrets: vscode.SecretStorage = {
        get: async () => undefined,
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

    test("provideLanguageModelChatResponse emits text, data, and thinking parts on the V2 pipeline", async () => {
        const provider = new LiteLLMChatProviderV2(mockSecrets, userAgent);

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
                        controller.enqueue(
                            encoder.encode('data: {"type":"response.output_text.delta","delta":"Hello"}\n\n')
                        );
                        controller.enqueue(
                            encoder.encode('data: {"type":"response.output_reasoning.delta","delta":"Thinking..."}\n\n')
                        );
                        controller.enqueue(
                            encoder.encode(
                                'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":4}}}\n\n'
                            )
                        );
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

        const reported: unknown[] = [];
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

        assert.ok(
            reported.some(
                (part) =>
                    part instanceof vscode.LanguageModelTextPart &&
                    (part as vscode.LanguageModelTextPart).value === "Hello"
            ),
            "Expected text part on V2 path"
        );

        const thinkingCtor = (vscode as unknown as { LanguageModelThinkingPart?: new (...args: unknown[]) => unknown })
            .LanguageModelThinkingPart;
        assert.ok(thinkingCtor, "Expected proposed LanguageModelThinkingPart constructor to exist");
        assert.ok(
            reported.some((part) => thinkingCtor && part instanceof thinkingCtor),
            "Expected thinking part on V2 path"
        );

        assert.ok(
            reported.some((part) => part instanceof vscode.LanguageModelDataPart),
            "Expected data part on V2 path"
        );
    });

    test("provideLanguageModelChatResponse falls back to a data usage part instead of thinking metadata", async () => {
        const provider = new LiteLLMChatProviderV2(mockSecrets, userAgent);

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
                        controller.enqueue(
                            encoder.encode('data: {"type":"response.output_text.delta","delta":"Hello"}\n\n')
                        );
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

        const reported: unknown[] = [];
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

        const dataParts = reported.filter((part) => part instanceof vscode.LanguageModelDataPart);
        assert.ok(dataParts.length > 0, "Expected fallback usage data part on V2 path");

        const thinkingCtor = (vscode as unknown as { LanguageModelThinkingPart?: new (...args: unknown[]) => unknown })
            .LanguageModelThinkingPart;
        if (thinkingCtor) {
            assert.ok(
                !reported.some((part) => part instanceof thinkingCtor),
                "Did not expect thinking fallback for usage metadata"
            );
        }
    });

    test("V2 thinking stays distinct until final transport shaping", async () => {
        const provider = new LiteLLMChatProviderV2(mockSecrets, userAgent) as LiteLLMChatProviderV2 & {
            buildV2ChatRequest: (
                messages: ReturnType<typeof normalizeMessagesForV2Pipeline>,
                model: vscode.LanguageModelChatInformation,
                options: vscode.ProvideLanguageModelChatResponseOptions,
                modelInfo?: unknown,
                caller?: string
            ) => Promise<{ messages: Array<{ role: string; content?: unknown }> }>;
        };

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

        const ThinkingPart = (
            vscode as unknown as {
                LanguageModelThinkingPart?: new (
                    value: string | string[],
                    id?: string,
                    metadata?: Record<string, unknown>
                ) => unknown;
            }
        ).LanguageModelThinkingPart;
        assert.ok(ThinkingPart, "Expected proposed LanguageModelThinkingPart constructor to exist");

        const normalized = normalizeMessagesForV2Pipeline([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [new ThinkingPart!("internal reasoning", "t-1")],
            } as unknown as vscode.LanguageModelChatMessage,
        ]);

        assert.strictEqual(normalized[0].content[0].type, "thinking");
        assert.strictEqual(normalized[0].role, "assistant");

        const request = await provider.buildV2ChatRequest(
            normalized,
            model,
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
            },
            undefined,
            "chat-v2"
        );

        assert.strictEqual(request.messages.length, 1);
        assert.ok(
            ["assistant", "system"].includes(request.messages[0].role),
            `Unexpected role: ${request.messages[0].role}`
        );
        assert.strictEqual(request.messages[0].content, "internal reasoning");
    });

    test("V2 data stays distinct until transport shaping and cache_control becomes transport text", () => {
        const normalized = normalizeMessagesForV2Pipeline([
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [
                    new vscode.LanguageModelDataPart(new Uint8Array(Buffer.from("ephemeral")), "cache_control"),
                    vscode.LanguageModelDataPart.text("visible text", "text/plain"),
                ],
            } as unknown as vscode.LanguageModelChatMessage,
        ]);

        assert.strictEqual(normalized[0].content[0].type, "data");
        assert.strictEqual(normalized[0].content[1].type, "data");

        const providerMessages = convertV2MessagesToProviderMessages(normalized);
        assert.strictEqual(providerMessages.length, 1);
        assert.strictEqual(providerMessages[0].content.length, 1);
        assert.ok(providerMessages[0].content[0] instanceof vscode.LanguageModelDataPart);
        assert.strictEqual((providerMessages[0].content[0] as vscode.LanguageModelDataPart).mimeType, "text/plain");

        const provider = new LiteLLMChatProviderV2(mockSecrets, userAgent) as LiteLLMChatProviderV2 & {
            buildV2ChatRequest: (
                messages: ReturnType<typeof normalizeMessagesForV2Pipeline>,
                model: vscode.LanguageModelChatInformation,
                options: vscode.ProvideLanguageModelChatResponseOptions,
                modelInfo?: unknown,
                caller?: string
            ) => Promise<{ messages: Array<{ role: string; content?: unknown }> }>;
        };

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

        return provider
            .buildV2ChatRequest(
                normalized,
                model,
                {
                    modelOptions: {},
                    tools: [],
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                    requestInitiator: "test",
                },
                undefined,
                "chat-v2"
            )
            .then((request) => {
                assert.strictEqual(request.messages.length, 1);
                assert.ok(
                    ["user", "system"].includes(request.messages[0].role),
                    `Unexpected role: ${request.messages[0].role}`
                );
                assert.strictEqual(request.messages[0].content, "ephemeralvisible text");
            });
    });

    test("provideLanguageModelChatResponse resets tool call state on finish_reason=stop", async () => {
        const provider = new LiteLLMChatProviderV2(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string; experimentalEmitUsageData?: boolean }>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({ url: "http://localhost:4000" });

        const encoder = new TextEncoder();
        // Setup a stream that emits a tool call, then a stop, then another tool call with same index
        sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(
            async () =>
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        // Turn 1
                        controller.enqueue(
                            encoder.encode(
                                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"t1","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n'
                            )
                        );
                        // Turn 2: Same index, different ID
                        controller.enqueue(
                            encoder.encode(
                                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2","function":{"name":"t2","arguments":"{}"}}]},"finish_reason":"stop"}]}\n\n'
                            )
                        );
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

        const reported: unknown[] = [];
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

        // Verify both tool calls were reported
        const toolCalls = reported.filter(
            (p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart
        );
        assert.strictEqual(toolCalls.length, 2, "Should have emitted 2 tool calls");
        assert.strictEqual(toolCalls[0].name, "t1");
        assert.strictEqual(toolCalls[1].name, "t2");
    });
});
