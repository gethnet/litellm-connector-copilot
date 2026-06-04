import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { LiteLLMCommitMessageProvider } from "../liteLLMCommitProvider";
import { LiteLLMClient } from "../../adapters/litellmClient";
import type { ConfigManager } from "../../config/configManager";
import { createTelemetryMocks } from "../../test/utils/telemetryMock";

/**
 * Typed view of the commit-message provider's private surface so tests
 * can stub/inspect internals without scattering `as any` casts.
 */
interface CommitProviderInternals {
    _configManager: ConfigManager;
    _lastModelList: vscode.LanguageModelChatInformation[];
    extractTextFromStream: (
        stream: ReadableStream<Uint8Array>,
        token: vscode.CancellationToken,
        onProgress?: (text: string) => void
    ) => Promise<string>;
    resolveCommitModel: (
        options: Record<string, unknown>,
        token: vscode.CancellationToken
    ) => Promise<vscode.LanguageModelChatInformation | undefined>;
}

function commitInternals(p: LiteLLMCommitMessageProvider): CommitProviderInternals {
    return p as unknown as CommitProviderInternals;
}

suite("LiteLLMCommitMessageProvider Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;
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

    const mockSecrets: vscode.SecretStorage = {
        get: async (key: string) => {
            if (key === "litellm-connector.baseUrl") {
                return "http://localhost:4000";
            }
            return undefined;
        },
        store: async () => undefined,
        delete: async () => undefined,
        onDidChange: (_listener: (e: vscode.SecretStorageChangeEvent) => unknown) => ({ dispose: () => undefined }),
    } as unknown as vscode.SecretStorage;

    const userAgent = "test-agent";

    test("provideCommitMessage generates a commit message from a diff", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);

        // Seed model list
        const providerWithCache = provider as unknown as {
            _lastModelList: vscode.LanguageModelChatInformation[];
            _configManager: { getConfig: () => Promise<{ url: string; key?: string }> };
            _modelDiscovery: {
                getLastModels: () => vscode.LanguageModelChatInformation[];
                getDiscoveredModelBackend: (
                    modelId: string
                ) => { backendName: string; url: string; apiKey: string } | undefined;
            };
        };
        providerWithCache._lastModelList = [
            {
                id: "test-model",
                name: "Test Model",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
                tags: ["scm-generator"],
                _backendName: "localhost:4000",
                _backendUrl: "http://localhost:4000",
                _apiKey: "test-key",
            } as unknown as vscode.LanguageModelChatInformation,
        ];
        sandbox.stub(providerWithCache._modelDiscovery, "getLastModels").returns(providerWithCache._lastModelList);
        sandbox
            .stub(providerWithCache._modelDiscovery, "getDiscoveredModelBackend")
            .returns({ backendName: "localhost:4000", url: "http://localhost:4000", apiKey: "test-key" });

        // Mock config
        const configManager = providerWithCache._configManager;
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
        const providerWithCache = provider as unknown as {
            _lastModelList: vscode.LanguageModelChatInformation[];
            resolveCommitModel: (
                config: { commitModelIdOverride?: string },
                token: vscode.CancellationToken
            ) => Promise<vscode.LanguageModelChatInformation>;
        };
        providerWithCache._lastModelList = [
            {
                id: "m1",
                name: "m1",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
                tags: [],
            } as vscode.LanguageModelChatInformation,
            {
                id: "m2",
                name: "m2",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
                tags: ["scm-generator"],
            } as vscode.LanguageModelChatInformation,
        ];

        const config = { commitModelIdOverride: "m1" };
        const resolved = await providerWithCache.resolveCommitModel(config, new vscode.CancellationTokenSource().token);
        assert.strictEqual(resolved.id, "m1");
    });

    test("resolveCommitModel prefers scm-generator tag", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
        const providerWithCache = provider as unknown as {
            _lastModelList: vscode.LanguageModelChatInformation[];
            resolveCommitModel: (
                config: Record<string, never>,
                token: vscode.CancellationToken
            ) => Promise<vscode.LanguageModelChatInformation>;
        };
        providerWithCache._lastModelList = [
            {
                id: "m1",
                name: "m1",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
                tags: [],
            } as vscode.LanguageModelChatInformation,
            {
                id: "m2",
                name: "m2",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
                tags: ["scm-generator"],
            } as vscode.LanguageModelChatInformation,
        ];

        const config: Record<string, never> = {};
        const resolved = await providerWithCache.resolveCommitModel(config, new vscode.CancellationTokenSource().token);
        assert.strictEqual(resolved.id, "m2");
    });

    test("resolveCommitModel returns undefined if no match or tag found", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);

        const providerWithCache = provider as unknown as {
            _lastModelList: vscode.LanguageModelChatInformation[];
            resolveCommitModel: (
                config: Record<string, never>,
                token: vscode.CancellationToken
            ) => Promise<vscode.LanguageModelChatInformation | undefined>;
        };
        providerWithCache._lastModelList = [
            {
                id: "m1",
                name: "m1",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
                tags: [],
            } as vscode.LanguageModelChatInformation,
        ];

        const config: Record<string, never> = {};
        const resolved = await providerWithCache.resolveCommitModel(config, new vscode.CancellationTokenSource().token);
        assert.strictEqual(resolved, undefined);
    });

    test("provideCommitMessage strips markdown code blocks from the generated message", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);

        // Seed model list
        const providerWithCache = provider as unknown as {
            _lastModelList: vscode.LanguageModelChatInformation[];
            _configManager: { getConfig: () => Promise<{ url: string; key?: string }> };
            _modelDiscovery: {
                getLastModels: () => vscode.LanguageModelChatInformation[];
                getDiscoveredModelBackend: (
                    modelId: string
                ) => { backendName: string; url: string; apiKey: string } | undefined;
            };
        };
        providerWithCache._lastModelList = [
            {
                id: "test-model",
                name: "Test Model",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1000,
                maxOutputTokens: 1000,
                capabilities: { toolCalling: true, imageInput: false },
                tags: ["scm-generator"],
                _backendName: "localhost:4000",
                _backendUrl: "http://localhost:4000",
                _apiKey: "test-key",
            } as unknown as vscode.LanguageModelChatInformation,
        ];
        sandbox.stub(providerWithCache._modelDiscovery, "getLastModels").returns(providerWithCache._lastModelList);
        sandbox
            .stub(providerWithCache._modelDiscovery, "getDiscoveredModelBackend")
            .returns({ backendName: "localhost:4000", url: "http://localhost:4000", apiKey: "test-key" });

        // Mock config
        const configManager = providerWithCache._configManager;
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
        const providerWithCacheAndConfig = provider as unknown as {
            _lastModelList: vscode.LanguageModelChatInformation[];
            _configManager: ConfigManager;
            _modelDiscovery: {
                getLastModels: () => vscode.LanguageModelChatInformation[];
                getDiscoveredModelBackend: (
                    modelId: string
                ) => { backendName: string; url: string; apiKey: string } | undefined;
            };
        };
        providerWithCacheAndConfig._lastModelList = [
            { id: "m1", tags: ["scm-generator"] } as unknown as vscode.LanguageModelChatInformation,
        ];
        // Seed backend metadata for the new per-group routing path.
        const seededModel = {
            id: "m1",
            tags: ["scm-generator"],
            _backendName: "localhost:4000",
            _backendUrl: "http://localhost:4000",
            _apiKey: "k",
        } as unknown as vscode.LanguageModelChatInformation;
        providerWithCacheAndConfig._lastModelList = [seededModel];
        sandbox.stub(providerWithCacheAndConfig._modelDiscovery, "getLastModels").returns([seededModel]);
        sandbox
            .stub(providerWithCacheAndConfig._modelDiscovery, "getDiscoveredModelBackend")
            .returns({ backendName: "localhost:4000", url: "http://localhost:4000", apiKey: "k" });

        sandbox.stub(providerWithCacheAndConfig._configManager, "getConfig").resolves({ url: "u", key: "k" });
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
        const providerWithCacheAndConfig = provider as unknown as {
            _lastModelList: vscode.LanguageModelChatInformation[];
            _configManager: ConfigManager;
            _modelDiscovery: {
                getLastModels: () => vscode.LanguageModelChatInformation[];
                getDiscoveredModelBackend: (
                    modelId: string
                ) => { backendName: string; url: string; apiKey: string } | undefined;
            };
        };
        const seededModel = {
            id: "m1",
            tags: ["scm-generator"],
            _backendName: "localhost:4000",
            _backendUrl: "http://localhost:4000",
            _apiKey: "k",
        } as unknown as vscode.LanguageModelChatInformation;
        providerWithCacheAndConfig._lastModelList = [seededModel];
        sandbox.stub(providerWithCacheAndConfig._modelDiscovery, "getLastModels").returns([seededModel]);
        sandbox
            .stub(providerWithCacheAndConfig._modelDiscovery, "getDiscoveredModelBackend")
            .returns({ backendName: "localhost:4000", url: "http://localhost:4000", apiKey: "k" });

        sandbox.stub(providerWithCacheAndConfig._configManager, "getConfig").resolves({ url: "u", key: "k" });
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
        const seededModel = {
            id: "commit-model",
            name: "commit-model",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 100,
            maxOutputTokens: 100,
            capabilities: { toolCalling: true, imageInput: false },
            tags: ["scm-generator"],
            _backendName: "localhost:4000",
            _backendUrl: "http://localhost:4000",
            _apiKey: "k",
        } as unknown as vscode.LanguageModelChatInformation;
        (provider as unknown as { _lastModelList: vscode.LanguageModelChatInformation[] })._lastModelList = [
            seededModel,
        ];
        const providerInternals = provider as unknown as {
            _modelDiscovery: {
                getLastModels: () => vscode.LanguageModelChatInformation[];
                getDiscoveredModelBackend: (
                    modelId: string
                ) => { backendName: string; url: string; apiKey: string } | undefined;
            };
        };
        sandbox.stub(providerInternals._modelDiscovery, "getLastModels").returns([seededModel]);
        sandbox
            .stub(providerInternals._modelDiscovery, "getDiscoveredModelBackend")
            .returns({ backendName: "localhost:4000", url: "http://localhost:4000", apiKey: "k" });

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
        const configManager = commitInternals(provider)._configManager;
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
        const configManager = commitInternals(provider)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://url" });
        commitInternals(provider)._lastModelList = [];
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
        const result = await commitInternals(provider).extractTextFromStream(
            stream,
            new vscode.CancellationTokenSource().token,
            (text: string) => progress.push(text)
        );

        assert.strictEqual(result, "ab");
        assert.deepStrictEqual(progress, ["a", "b"]);
    });

    test("resolveCommitModel triggers discovery if list is empty", async () => {
        const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
        commitInternals(provider)._lastModelList = [];
        const discoverStub = sandbox.stub(provider, "discoverModels").callsFake(async () => {
            commitInternals(provider)._lastModelList = [
                { id: "m1", tags: ["scm-generator"] } as unknown as vscode.LanguageModelChatInformation,
            ];
            return commitInternals(provider)._lastModelList;
        });

        const resolved = await commitInternals(provider).resolveCommitModel(
            {},
            new vscode.CancellationTokenSource().token
        );
        assert.strictEqual(discoverStub.calledOnce, true);
        assert.strictEqual(resolved?.id, "m1");
    });
});
