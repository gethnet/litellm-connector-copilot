import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { LiteLLMCommitMessageProvider } from "../liteLLMCommitProvider";
import { LiteLLMClient } from "../../adapters/litellmClient";
import type { ConfigManager } from "../../config/configManager";

suite("LiteLLMCommitMessageProvider Unit Tests", () => {
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
            return undefined;
        },
        store: async () => {},
        delete: async () => {},
        onDidChange: (_listener: (e: vscode.SecretStorageChangeEvent) => unknown) => ({ dispose() {} }),
    } as unknown as vscode.SecretStorage;

    const userAgent = "test-agent";

    test("provideCommitMessage generates a commit message from a diff", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);

        // Seed model list
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const providerAny = provider as any;
        providerAny._lastModelList = [
            {
                id: "test-model",
                name: "Test Model",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
                tags: ["scm-generator"],
            } as unknown as vscode.LanguageModelChatInformation,
        ];

        // Mock config
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const configManager = (provider as any)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            key: "test-key",
        });

        // Mock LiteLLMClient.chat
        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        chatStub.callsFake(async () => {
            const encoder = new TextEncoder();
            const frames = [
                'data: {"choices":[{"delta":{"content":"feat: "}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"add thing"}}]}\n\n',
                "data: [DONE]\n\n",
            ].join("");

            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(frames));
                    controller.close();
                },
            });
        });

        const diff = "staged changes diff";
        const result = await provider.provideCommitMessage(
            diff,
            { modelOptions: {} } as vscode.LanguageModelChatRequestOptions,
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(result, "feat: add thing");
        assert.strictEqual(chatStub.calledOnce, true);
    });

    test("resolveCommitModel uses commitModelIdOverride if present", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const providerAny = provider as any;
        providerAny._lastModelList = [
            { id: "m1", tags: [] } as unknown as vscode.LanguageModelChatInformation,
            { id: "m2", tags: ["scm-generator"] } as unknown as vscode.LanguageModelChatInformation,
        ];

        const config = { commitModelIdOverride: "m1" };
        const resolved = await providerAny.resolveCommitModel(config, new vscode.CancellationTokenSource().token);
        assert.strictEqual(resolved.id, "m1");
    });

    test("resolveCommitModel prefers scm-generator tag", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const providerAny = provider as any;
        providerAny._lastModelList = [
            { id: "m1", tags: [] } as unknown as vscode.LanguageModelChatInformation,
            { id: "m2", tags: ["scm-generator"] } as unknown as vscode.LanguageModelChatInformation,
        ];

        const config = {};
        const resolved = await providerAny.resolveCommitModel(config, new vscode.CancellationTokenSource().token);
        assert.strictEqual(resolved.id, "m2");
    });

    test("resolveCommitModel returns undefined if no match or tag found", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const providerAny = provider as any;
        providerAny._lastModelList = [{ id: "m1", tags: [] } as unknown as vscode.LanguageModelChatInformation];

        const config = {};
        const resolved = await providerAny.resolveCommitModel(config, new vscode.CancellationTokenSource().token);
        assert.strictEqual(resolved, undefined);
    });

    test("provideCommitMessage strips markdown code blocks from the generated message", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);

        // Seed model list
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const providerAny = provider as any;
        providerAny._lastModelList = [
            {
                id: "test-model",
                name: "Test Model",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
                tags: ["scm-generator"],
            } as unknown as vscode.LanguageModelChatInformation,
        ];

        // Mock config
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const configManager = (provider as any)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            key: "test-key",
        });

        // Mock LiteLLMClient.chat with markdown code blocks
        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        chatStub.callsFake(async () => {
            const encoder = new TextEncoder();
            const frames = [
                'data: {"choices":[{"delta":{"content":"```markdown\\n"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"feat: "}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"add thing\\n"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"```"}}]}\n\n',
                "data: [DONE]\n\n",
            ].join("");

            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(frames));
                    controller.close();
                },
            });
        });

        const diff = "staged changes diff";
        const result = await provider.provideCommitMessage(
            diff,
            { modelOptions: {} } as vscode.LanguageModelChatRequestOptions,
            new vscode.CancellationTokenSource().token
        );

        // The expected result should have the backticks and "markdown" language tag stripped
        assert.strictEqual(result, "feat: add thing");
    });

    test("provideCommitMessage handles API error during generation", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
        const providerAny = provider as unknown as {
            _lastModelList: vscode.LanguageModelChatInformation[];
            _configManager: ConfigManager;
        };
        providerAny._lastModelList = [
            { id: "m1", tags: ["scm-generator"] } as unknown as vscode.LanguageModelChatInformation,
        ];

        sandbox.stub(providerAny._configManager, "getConfig").resolves({ url: "u", key: "k" });
        sandbox.stub(LiteLLMClient.prototype, "chat").rejects(new Error("API failure"));

        await assert.rejects(
            () =>
                provider.provideCommitMessage(
                    "diff",
                    {} as unknown as vscode.LanguageModelChatRequestOptions,
                    new vscode.CancellationTokenSource().token
                ),
            /API failure/
        );
    });

    test("provideCommitMessage handles empty stream response", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
        const providerAny = provider as unknown as {
            _lastModelList: vscode.LanguageModelChatInformation[];
            _configManager: ConfigManager;
        };
        providerAny._lastModelList = [
            { id: "m1", tags: ["scm-generator"] } as unknown as vscode.LanguageModelChatInformation,
        ];

        sandbox.stub(providerAny._configManager, "getConfig").resolves({ url: "u", key: "k" });
        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(
            new ReadableStream({
                start(controller) {
                    controller.close();
                },
            })
        );

        const result = await provider.provideCommitMessage(
            "diff",
            {} as unknown as vscode.LanguageModelChatRequestOptions,
            new vscode.CancellationTokenSource().token
        );
        assert.strictEqual(result, "");
    });

    test("resolveCommitModel falls back to first scm-generator tagged model", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);

        (provider as unknown as { _lastModelList: vscode.LanguageModelChatInformation[] })._lastModelList = [
            {
                id: "plain-model",
                name: "plain-model",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 100,
                maxOutputTokens: 100,
                capabilities: { toolCalling: true, imageInput: false },
                tags: [],
            } as unknown as vscode.LanguageModelChatInformation,
            {
                id: "commit-model",
                name: "commit-model",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 100,
                maxOutputTokens: 100,
                capabilities: { toolCalling: true, imageInput: false },
                tags: ["scm-generator"],
            } as unknown as vscode.LanguageModelChatInformation,
        ];

        const resolved = await (
            provider as unknown as {
                resolveCommitModel: (cfg: unknown) => Promise<vscode.LanguageModelChatInformation | undefined>;
            }
        ).resolveCommitModel({});

        assert.strictEqual(resolved?.id, "commit-model");
    });

    test("provideCommitMessage returns empty string when stream contains no text frames", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
        const configManager = (provider as unknown as { _configManager: { getConfig: () => Promise<unknown> } })
            ._configManager;
        sandbox.stub(configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            commitModelIdOverride: "commit-model",
        });
        (provider as unknown as { _lastModelList: vscode.LanguageModelChatInformation[] })._lastModelList = [
            {
                id: "commit-model",
                name: "commit-model",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 100,
                maxOutputTokens: 100,
                capabilities: { toolCalling: true, imageInput: false },
                tags: ["scm-generator"],
            } as unknown as vscode.LanguageModelChatInformation,
        ];

        const encoder = new TextEncoder();
        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            })
        );

        const result = await provider.provideCommitMessage(
            "diff --git a/file b/file",
            {} as unknown as vscode.LanguageModelChatRequestOptions,
            new vscode.CancellationTokenSource().token
        );
        assert.strictEqual(result, "");
    });

    test("provideCommitMessage throws when config URL is missing", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const configManager = (provider as any)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "" });

        await assert.rejects(
            () =>
                provider.provideCommitMessage(
                    "diff",
                    {} as unknown as vscode.LanguageModelChatRequestOptions,
                    new vscode.CancellationTokenSource().token
                ),
            /configuration not found/
        );
    });

    test("provideCommitMessage throws when no model available", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const configManager = (provider as any)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://url" });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (provider as any)._lastModelList = [];
        sandbox.stub(provider, "discoverModels").resolves([]);

        await assert.rejects(
            () =>
                provider.provideCommitMessage(
                    "diff",
                    {} as unknown as vscode.LanguageModelChatRequestOptions,
                    new vscode.CancellationTokenSource().token
                ),
            /No model available/
        );
    });

    test("extractTextFromStream calls onProgress and handles invalid JSON", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
                controller.enqueue(encoder.encode("data: invalid\n\n"));
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"b"}}]}\n\n'));
                controller.close();
            },
        });

        const progress: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (provider as any).extractTextFromStream(
            stream,
            new vscode.CancellationTokenSource().token,
            (text: string) => progress.push(text)
        );

        assert.strictEqual(result, "ab");
        assert.deepStrictEqual(progress, ["a", "b"]);
    });

    test("resolveCommitModel triggers discovery if list is empty", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (provider as any)._lastModelList = [];
        const discoverStub = sandbox.stub(provider, "discoverModels").callsFake(async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (provider as any)._lastModelList = [
                { id: "m1", tags: ["scm-generator"] } as unknown as vscode.LanguageModelChatInformation,
            ];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (provider as any)._lastModelList;
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const resolved = await (provider as any).resolveCommitModel({}, new vscode.CancellationTokenSource().token);
        assert.strictEqual(discoverStub.calledOnce, true);
        assert.strictEqual(resolved?.id, "m1");
    });
});
