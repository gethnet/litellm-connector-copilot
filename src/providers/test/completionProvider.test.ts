import * as assert from "assert";
import type * as vscode from "vscode";
import * as sinon from "sinon";

import { LiteLLMCompletionProvider } from "../";
import { LiteLLMClient } from "../../adapters/litellmClient";

suite("LiteLLMCompletionProvider Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

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

    test("provideTextCompletion extracts text from SSE stream", async () => {
        const provider = new LiteLLMCompletionProvider(mockSecrets, userAgent);

        // Seed model cache so resolveCompletionModel can pick it up.
        (provider as unknown as { _lastModelList: vscode.LanguageModelChatInformation[] })._lastModelList = [
            {
                id: "m1",
                name: "m1",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 100,
                maxOutputTokens: 100,
                capabilities: { toolCalling: true, imageInput: false },
                tags: ["inline-completions"],
            } as unknown as vscode.LanguageModelChatInformation,
        ];

        // Ensure config is present.
        const configManager = (provider as unknown as { _configManager: unknown })._configManager as {
            convertProviderConfiguration: (c: Record<string, unknown>) => unknown;
        };
        sandbox.stub(configManager, "convertProviderConfiguration").returns({
            url: "http://localhost:4000",
            key: "k",
            disableQuotaToolRedaction: false,
            disableCaching: true,
            inactivityTimeout: 60,
            modelOverrides: {},
            modelIdOverride: undefined,
        });

        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        chatStub.callsFake(async (requestBody: unknown) => {
            const req = requestBody as { model: string };
            assert.strictEqual(req.model, "m1");

            const encoder = new TextEncoder();
            const frames = [
                'data: {"choices":[{"delta":{"content":"hel"}}]}\n',
                'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
                "data: [DONE]\n\n",
            ].join("");

            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(frames));
                    controller.close();
                },
            });
        });

        const res = await provider.provideTextCompletion(
            "prompt",
            {
                modelId: "m1",
                modelOptions: {},
                configuration: { baseUrl: "http://localhost:4000", apiKey: "k" },
            },
            {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose() {} }),
            } as vscode.CancellationToken
        );

        assert.strictEqual(res.insertText, "hello");
    });

    test("resolveCompletionModel prefers modelIdOverride", async () => {
        const provider = new LiteLLMCompletionProvider(mockSecrets, userAgent);

        (provider as unknown as { _lastModelList: vscode.LanguageModelChatInformation[] })._lastModelList = [
            {
                id: "m1",
                name: "m1",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 100,
                maxOutputTokens: 100,
                capabilities: { toolCalling: true, imageInput: false },
            },
            {
                id: "override",
                name: "override",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 100,
                maxOutputTokens: 100,
                capabilities: { toolCalling: true, imageInput: false },
            },
        ];

        // Call private method via reflection for a focused unit test.
        const resolved = await (
            provider as unknown as {
                resolveCompletionModel: (
                    cfg: unknown,
                    token: vscode.CancellationToken
                ) => Promise<vscode.LanguageModelChatInformation | undefined>;
            }
        ).resolveCompletionModel({ modelIdOverride: "override" }, {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose() {} }),
        } as vscode.CancellationToken);

        assert.strictEqual(resolved?.id, "override");
    });

    test("resolveCompletionModel returns undefined if no match or tag found", async () => {
        const provider = new LiteLLMCompletionProvider(mockSecrets, userAgent);

        (provider as unknown as { _lastModelList: vscode.LanguageModelChatInformation[] })._lastModelList = [
            {
                id: "m1",
                name: "m1",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 100,
                maxOutputTokens: 100,
                capabilities: { toolCalling: true, imageInput: false },
                tags: [],
            } as unknown as vscode.LanguageModelChatInformation,
        ];

        const resolved = await (
            provider as unknown as {
                resolveCompletionModel: (
                    cfg: unknown,
                    token: vscode.CancellationToken
                ) => Promise<vscode.LanguageModelChatInformation | undefined>;
            }
        ).resolveCompletionModel({}, {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose() {} }),
        } as vscode.CancellationToken);

        assert.strictEqual(resolved, undefined);
    });
});
