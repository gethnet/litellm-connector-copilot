import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { LiteLLMChatProvider } from "../liteLLMChatProvider";
import type { ConfigManager } from "../../config/configManager";
import type { BackendSession } from "../backendSession";
import type { LanguageModelChatInformation } from "vscode";

suite("Model Drift Detection & State Persistence", () => {
    let sandbox: sinon.SinonSandbox;
    let provider: LiteLLMChatProvider;
    let configManager: ConfigManager;
    let mockSecrets: vscode.SecretStorage;

    setup(() => {
        sandbox = sinon.createSandbox();
        mockSecrets = {
            get: sandbox.stub().resolves(undefined),
            store: sandbox.stub().resolves(undefined),
            delete: sandbox.stub().resolves(undefined),
            keys: sandbox.stub().resolves([]),
            onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
        } as unknown as vscode.SecretStorage;

        provider = new LiteLLMChatProvider(mockSecrets, "test-agent");
        configManager = (provider as unknown as { _configManager: ConfigManager })._configManager;
    });

    teardown(() => {
        sandbox.restore();
    });

    test("consecutive calls with same config return cached models (same references)", async () => {
        const config = {
            providerName: "test-group",
            baseUrl: "http://localhost:4000",
            apiKey: "test-key",
        };

        const mockSession: BackendSession = {
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
        };

        sandbox.stub(configManager, "convertProviderConfiguration").returns(mockSession);

        const models1 = await provider.discoverModels(
            { silent: true, configuration: config },
            new vscode.CancellationTokenSource().token
        );

        const models2 = await provider.discoverModels(
            { silent: true, configuration: config },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(models1.length, 1, "Should have 1 model");
        assert.strictEqual(models2.length, 1, "Should have 1 model");
        assert.strictEqual(models1[0], models2[0], "Model objects should be same reference (cached)");

        const schema1 = (models1[0] as LanguageModelChatInformation).configurationSchema;
        const schema2 = (models2[0] as LanguageModelChatInformation).configurationSchema;
        assert.deepStrictEqual(schema1, schema2, "Configuration schema should be identical");
    });

    test("calls with different config trigger re-discovery", async () => {
        const config1 = {
            providerName: "group-1",
            baseUrl: "http://localhost:4000",
            apiKey: "key-1",
        };
        const config2 = {
            providerName: "group-2",
            baseUrl: "http://localhost:4001",
            apiKey: "key-2",
        };

        let callCount = 0;
        const mockSession1: BackendSession = {
            backendName: "group-1",
            baseUrl: "http://localhost:4000",
            apiKey: "key-1",
            client: {
                getModelInfo: sandbox.stub().callsFake(() => {
                    callCount++;
                    return Promise.resolve({
                        data: [
                            {
                                model_name: "gpt-4",
                                model_info: { litellm_provider: "openai", mode: "chat" },
                            },
                        ],
                    });
                }),
            } as unknown as BackendSession["client"],
        };
        const mockSession2: BackendSession = {
            backendName: "group-2",
            baseUrl: "http://localhost:4001",
            apiKey: "key-2",
            client: {
                getModelInfo: sandbox.stub().callsFake(() => {
                    callCount++;
                    return Promise.resolve({
                        data: [
                            {
                                model_name: "claude-3",
                                model_info: { litellm_provider: "anthropic", mode: "chat" },
                            },
                        ],
                    });
                }),
            } as unknown as BackendSession["client"],
        };

        sandbox.stub(configManager, "convertProviderConfiguration").callsFake((groupName) => {
            if (groupName === "group-1") {
                return mockSession1;
            }
            if (groupName === "group-2") {
                return mockSession2;
            }
            return undefined;
        });

        await provider.discoverModels(
            { silent: true, configuration: config1 },
            new vscode.CancellationTokenSource().token
        );

        await provider.discoverModels(
            { silent: true, configuration: config2 },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(callCount, 2, "Should have called discovery twice for different configs");
    });

    test("model list only updates on drift (same models, no update)", async () => {
        const config = {
            providerName: "test-group",
            baseUrl: "http://localhost:4000",
            apiKey: "test-key",
        };

        const mockSession: BackendSession = {
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
                                max_input_tokens: 128000,
                                mode: "chat",
                            },
                        },
                    ],
                }),
            } as unknown as BackendSession["client"],
        };
        sandbox.stub(configManager, "convertProviderConfiguration").returns(mockSession);

        const models1 = await provider.discoverModels(
            { silent: true, configuration: config },
            new vscode.CancellationTokenSource().token
        );

        const models2 = await provider.discoverModels(
            { silent: true, configuration: config },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(models1[0], models2[0], "Should return cached model object (no recreation)");
    });

    test("clearModelCache clears per-config cache", async () => {
        const config = {
            providerName: "test-group",
            baseUrl: "http://localhost:4000",
            apiKey: "test-key",
        };

        const mockSession: BackendSession = {
            backendName: "test-group",
            baseUrl: "http://localhost:4000",
            apiKey: "test-key",
            client: {
                getModelInfo: sandbox.stub().resolves({
                    data: [
                        {
                            model_name: "gpt-4",
                            model_info: { litellm_provider: "openai", mode: "chat" },
                        },
                    ],
                }),
            } as unknown as BackendSession["client"],
        };
        sandbox.stub(configManager, "convertProviderConfiguration").returns(mockSession);

        await provider.discoverModels(
            { silent: true, configuration: config },
            new vscode.CancellationTokenSource().token
        );

        provider.clearModelCache();

        const rediscoverStub = mockSession.client.getModelInfo as sinon.SinonStub;
        rediscoverStub.resetHistory();

        const models2 = await provider.discoverModels(
            { silent: true, configuration: config },
            new vscode.CancellationTokenSource().token
        );

        assert.ok(rediscoverStub.called, "Should re-discover after cache clear");
        assert.strictEqual(models2.length, 1, "Should have rediscovered models");
    });
});
