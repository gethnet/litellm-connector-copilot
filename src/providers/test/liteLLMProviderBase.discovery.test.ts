import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { ModelDiscovery } from "../base/modelDiscovery";
import { ConfigManager } from "../../config/configManager";

suite("ModelDiscovery", () => {
    let sandbox: sinon.SinonSandbox;
    let configManager: sinon.SinonStubbedInstance<ConfigManager>;
    let discovery: ModelDiscovery;

    setup(() => {
        sandbox = sinon.createSandbox();
        configManager = sandbox.createStubInstance(ConfigManager);
        discovery = new ModelDiscovery({
            configManager,
            userAgent: "test-agent",
            onModernConfigurationDetected: () => {},
        });
    });

    teardown(() => sandbox.restore());

    test("caches per configuration key", async () => {
        const token = new vscode.CancellationTokenSource().token;
        configManager.getConfig.resolves({} as never);
        configManager.convertProviderConfiguration.returns({
            backendName: "b1",
            baseUrl: "http://b1",
            apiKey: "k",
            client: {
                getModelInfo: async () => ({
                    data: [
                        {
                            model_name: "gpt-4o",
                            model_info: {
                                litellm_provider: "openai",
                                mode: "chat",
                                supports_native_streaming: true,
                            },
                        },
                    ],
                }),
            } as never,
        });

        const first = await discovery.discover({
            options: { silent: true, configuration: { providerName: "p", baseUrl: "http://b1" } },
            token,
        });
        const second = await discovery.discover({
            options: { silent: true, configuration: { providerName: "p", baseUrl: "http://b1" } },
            token,
        });

        assert.strictEqual(first.length, 1);
        assert.strictEqual(second.length, 1);
        assert.strictEqual(first[0], second[0]);
    });

    test("falls back to legacy path when no configuration", async () => {
        const token = new vscode.CancellationTokenSource().token;
        configManager.resolveBackends.resolves([]);

        const models = await discovery.discover({ options: { silent: false }, token });
        assert.deepStrictEqual(models, []);
    });

    test("accumulates models across multiple backends (multi-backend routing fix)", async () => {
        const token = new vscode.CancellationTokenSource().token;
        configManager.getConfig.resolves({} as never);

        // First backend discovery
        configManager.convertProviderConfiguration.onFirstCall().returns({
            backendName: "backend-a",
            baseUrl: "http://backend-a",
            apiKey: "key-a",
            client: {
                getModelInfo: async () => ({
                    data: [
                        {
                            model_name: "gpt-4o",
                            model_info: {
                                litellm_provider: "openai",
                                mode: "chat",
                                supports_native_streaming: true,
                            },
                        },
                    ],
                }),
            } as never,
        });

        // Second backend discovery
        configManager.convertProviderConfiguration.onSecondCall().returns({
            backendName: "backend-b",
            baseUrl: "http://backend-b",
            apiKey: "key-b",
            client: {
                getModelInfo: async () => ({
                    data: [
                        {
                            model_name: "claude-3-sonnet",
                            model_info: {
                                litellm_provider: "anthropic",
                                mode: "chat",
                                supports_native_streaming: true,
                            },
                        },
                    ],
                }),
            } as never,
        });

        // First backend discovery
        const first = await discovery.discover({
            options: { silent: true, configuration: { providerName: "backend-a", baseUrl: "http://backend-a" } },
            token,
        });
        assert.strictEqual(first.length, 1, "Should return 1 model from first backend");
        assert.strictEqual(first[0].id, "backend-a/gpt-4o", "First backend model should be namespaced");

        // Second backend discovery (simulates VS Code calling for second provider group)
        const second = await discovery.discover({
            options: { silent: true, configuration: { providerName: "backend-b", baseUrl: "http://backend-b" } },
            token,
        });
        assert.strictEqual(second.length, 1, "Should return 1 model from second backend");
        assert.strictEqual(second[0].id, "backend-b/claude-3-sonnet", "Second backend model should be namespaced");

        // Verify the routing lookup can find models from BOTH backends
        const backendA = discovery.getDiscoveredModelBackend("backend-a/gpt-4o");
        assert.ok(backendA, "Should find backend-a model");
        assert.strictEqual(backendA?.backendName, "backend-a", "Should route to correct backend name");
        assert.strictEqual(backendA?.url, "http://backend-a", "Should route to correct backend URL");

        const backendB = discovery.getDiscoveredModelBackend("backend-b/claude-3-sonnet");
        assert.ok(backendB, "Should find backend-b model");
        assert.strictEqual(backendB?.backendName, "backend-b", "Should route to correct backend name");
        assert.strictEqual(backendB?.url, "http://backend-b", "Should route to correct backend URL");

        // Verify activeBackendNames tracks both
        const activeBackends = discovery.getActiveBackends();
        assert.ok(activeBackends.includes("backend-a"), "Should include backend-a");
        assert.ok(activeBackends.includes("backend-b"), "Should include backend-b");
    });
});
