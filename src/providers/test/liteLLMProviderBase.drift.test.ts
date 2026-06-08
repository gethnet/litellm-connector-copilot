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

    test("consecutive calls with same config produce stable model ids (stateless re-fetch)", async () => {
        // The discovery layer is stateless: every call performs a fresh
        // `/model/info` HTTP request. Two calls produce two independent
        // fetches, so the returned `LanguageModelChatInformation` object
        // references differ. The model id and other derived values are
        // stable across calls because the routing identity (derived from
        // the URL hostname) does not change.
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
        // Namespaced id is stable across calls because the routing
        // identity (URL hostname) does not change.
        assert.strictEqual(models1[0].id, models2[0].id, "Model id should be stable across calls (stateless re-fetch)");

        const schema1 = (models1[0] as LanguageModelChatInformation).configurationSchema;
        const schema2 = (models2[0] as LanguageModelChatInformation).configurationSchema;
        assert.deepStrictEqual(schema1, schema2, "Configuration schema should be identical");
    });

    test("calls with different config trigger re-discovery", async () => {
        // Two distinct base URLs → two distinct cache keys → two discovery calls.
        const config1 = {
            baseUrl: "http://localhost:4000",
            apiKey: "key-1",
        };
        const config2 = {
            baseUrl: "http://localhost:4001",
            apiKey: "key-2",
        };

        let callCount = 0;
        const mockSession1: BackendSession = {
            backendName: "localhost:4000",
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
            backendName: "localhost:4001",
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

        // Discovery no longer threads groupName through to convertProviderConfiguration —
        // the URL is the routing identity. The picker's label is derived separately. We
        // match on the configuration payload (second arg) to return the right session.
        sandbox.stub(configManager, "convertProviderConfiguration").callsFake((_groupName, config) => {
            if (config === config1) {
                return mockSession1;
            }
            if (config === config2) {
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

    test("model list only updates on drift (same models, no update event)", async () => {
        // The stateless design re-fetches every call. The change event
        // fires ONLY when the model id set returned for a given baseUrl
        // differs from the prior delivery. Two identical fetches produce
        // identical id sets, so the change event is NOT fired on the
        // second call.
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

        const fired: number[] = [];
        provider.onDidChangeLanguageModelChatInformation(() => fired.push(1));

        await provider.discoverModels(
            { silent: true, configuration: config },
            new vscode.CancellationTokenSource().token
        );
        await provider.discoverModels(
            { silent: true, configuration: config },
            new vscode.CancellationTokenSource().token
        );

        // First call fires; second call with the same model set MUST NOT
        // fire. This is the change-detection invariant the registry
        // owns; the base provider subscribes to it and forwards to VS Code.
        assert.strictEqual(fired.length, 1, "change event should fire only on the first call");
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
