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
        const providerAny = provider as unknown as { _lastModelList: vscode.LanguageModelChatInformation[] };
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
        const configManager = (provider as unknown as { _configManager: unknown })._configManager as {
            getConfig: () => Promise<{ url: string; key: string }>;
        };
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
        const providerAny = provider as unknown as {
            _lastModelList: vscode.LanguageModelChatInformation[];
            resolveCommitModel: (
                config: unknown,
                token: vscode.CancellationToken
            ) => Promise<vscode.LanguageModelChatInformation>;
        };
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
        const providerAny = provider as unknown as {
            _lastModelList: vscode.LanguageModelChatInformation[];
            resolveCommitModel: (
                config: unknown,
                token: vscode.CancellationToken
            ) => Promise<vscode.LanguageModelChatInformation>;
        };
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
        const providerAny = provider as unknown as {
            _lastModelList: vscode.LanguageModelChatInformation[];
            resolveCommitModel: (
                config: unknown,
                token: vscode.CancellationToken
            ) => Promise<vscode.LanguageModelChatInformation | undefined>;
        };
        providerAny._lastModelList = [{ id: "m1", tags: [] } as unknown as vscode.LanguageModelChatInformation];

        const config = {};
        const resolved = await providerAny.resolveCommitModel(config, new vscode.CancellationTokenSource().token);
        assert.strictEqual(resolved, undefined);
    });

    test("provideCommitMessage strips markdown code blocks from the generated message", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);

        // Seed model list
        const providerAny = provider as unknown as { _lastModelList: vscode.LanguageModelChatInformation[] };
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
        const configManager = (provider as unknown as { _configManager: unknown })._configManager as {
            getConfig: () => Promise<{ url: string; key: string }>;
        };
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
});
