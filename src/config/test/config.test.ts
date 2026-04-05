import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { ConfigManager } from "../configManager";
import type { TelemetryService } from "../../telemetry/telemetryService";

suite("ConfigManager Unit Tests", () => {
    let mockSecrets: vscode.SecretStorage;
    let secretsMap: Map<string, string>;
    let getConfigurationStub: sinon.SinonStub;
    let configGetStub: sinon.SinonStub;
    let settingsMap: Map<string, unknown>;

    setup(() => {
        settingsMap = new Map<string, unknown>();
        secretsMap = new Map<string, string>();
        mockSecrets = {
            get: async (key: string) => secretsMap.get(key),
            store: async (key: string, value: string) => {
                secretsMap.set(key, value);
            },
            delete: async (key: string) => {
                secretsMap.delete(key);
            },
            onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
        } as unknown as vscode.SecretStorage;

        // Stub workspace configuration reads so tests are deterministic and don't depend on VS Code defaults.
        // We return explicit values for the keys ConfigManager reads.
        configGetStub = sinon.stub();
        configGetStub.callsFake((key: string, defaultValue?: unknown) => {
            if (settingsMap.has(key)) {
                return settingsMap.get(key);
            }
            switch (key) {
                case "litellm-connector.baseUrl":
                    return "";
                case "litellm-connector.apiKeySecretRef":
                    return "default";
                case "litellm-connector.inactivityTimeout":
                    return 60;
                case "litellm-connector.disableCaching":
                    return true;
                case "litellm-connector.emitUsageData":
                    return false;
                case "litellm-connector.disableQuotaToolRedaction":
                    return false;
                case "litellm-connector.modelOverrides":
                    return {};
                case "litellm-connector.modelIdOverride":
                    return "";
                default:
                    return defaultValue;
            }
        });

        getConfigurationStub = sinon.stub(vscode.workspace, "getConfiguration").returns({
            get: configGetStub,
            update: async (key: string, value: unknown) => {
                if (value === undefined) {
                    settingsMap.delete(key);
                } else {
                    settingsMap.set(key, value);
                }
            },
            has: () => false,
        } as unknown as vscode.WorkspaceConfiguration);
    });

    teardown(() => {
        getConfigurationStub?.restore();
    });

    test("getConfig returns empty values when nothing is stored", async () => {
        const manager = new ConfigManager(mockSecrets);
        const config = await manager.getConfig();
        assert.strictEqual(config.url, "");
        assert.strictEqual(config.key, undefined);
        assert.strictEqual(config.modelIdOverride, undefined);
    });

    test("setConfig and getConfig roundtrip", async () => {
        const manager = new ConfigManager(mockSecrets);
        const testConfig = { url: "https://api.example.com", key: "sk-123" };

        await manager.setConfig(testConfig);
        const config = await manager.getConfig();

        assert.strictEqual(config.url, "https://api.example.com");
        assert.strictEqual(config.key, "sk-123");
    });

    test("setConfig deletes keys when values are missing", async () => {
        const manager = new ConfigManager(mockSecrets);
        await manager.setConfig({ url: "https://api.example.com", key: "sk-123" });

        await manager.setConfig({ url: "", key: "" });
        const config = await manager.getConfig();

        assert.strictEqual(config.url, "");
        assert.strictEqual(config.key, undefined);
        // baseUrl is stored in settings; only the API key secret should be deleted.
        assert.strictEqual(secretsMap.size, 0);
    });

    test("isConfigured returns true when url or backends are present", async () => {
        const manager = new ConfigManager(mockSecrets);

        assert.strictEqual(await manager.isConfigured(), false);

        await manager.setConfig({ url: "https://api.example.com" });
        assert.strictEqual(await manager.isConfigured(), true);

        await manager.setConfig({ url: "" });
        assert.strictEqual(await manager.isConfigured(), false);

        settingsMap.set("litellm-connector.backends", [{ name: "cloud", url: "http://cloud:4000" }]);
        assert.strictEqual(await manager.isConfigured(), true);
    });

    test("getConfig migrates legacy url to backends[0]", async () => {
        settingsMap.set("litellm-connector.baseUrl", "http://localhost:4000");
        secretsMap.set("litellm-connector.apiKey.default", "sk-test");

        const manager = new ConfigManager(mockSecrets);
        const config = await manager.getConfig();

        assert.strictEqual(config.url, "http://localhost:4000");
        assert.ok(config.backends);
        assert.strictEqual(config.backends.length, 1);
        assert.strictEqual(config.backends[0].name, "default");
        assert.strictEqual(config.backends[0].url, "http://localhost:4000");
    });

    test("getConfig uses backends array when configured", async () => {
        settingsMap.set("litellm-connector.baseUrl", "http://old:4000");
        settingsMap.set("litellm-connector.backends", [
            { name: "cloud", url: "http://cloud:4000" },
            { name: "local", url: "http://local:4000" },
        ]);

        const manager = new ConfigManager(mockSecrets);
        const config = await manager.getConfig();

        assert.ok(config.backends);
        assert.strictEqual(config.backends.length, 2);
        assert.strictEqual(config.backends[0].name, "cloud");
        assert.strictEqual(config.backends[1].name, "local");
    });

    test("resolveBackends returns resolved backends with API keys", async () => {
        settingsMap.set("litellm-connector.backends", [
            { name: "cloud", url: "http://cloud:4000", apiKeySecretRef: "cloud" },
        ]);
        secretsMap.set("litellm-connector.apiKey.cloud", "sk-cloud");

        const manager = new ConfigManager(mockSecrets);
        const resolved = await manager.resolveBackends();

        assert.strictEqual(resolved.length, 1);
        assert.strictEqual(resolved[0].name, "cloud");
        assert.strictEqual(resolved[0].apiKey, "sk-cloud");
    });

    test("resolveBackends skips disabled backends", async () => {
        settingsMap.set("litellm-connector.backends", [
            { name: "cloud", url: "http://cloud:4000", enabled: true },
            { name: "local", url: "http://local:4000", enabled: false },
        ]);

        const manager = new ConfigManager(mockSecrets);
        const resolved = await manager.resolveBackends();

        assert.strictEqual(resolved.length, 1);
        assert.strictEqual(resolved[0].name, "cloud");
    });

    test("addBackend stores backend and API key", async () => {
        const manager = new ConfigManager(mockSecrets);
        await manager.addBackend({ name: "new-backend", url: "http://new:4000" }, "sk-new");

        const backends = await manager.listBackends();
        assert.ok(backends.some((b) => b.name === "new-backend"));
        assert.strictEqual(secretsMap.get("litellm-connector.apiKey.new-backend"), "sk-new");
    });

    test("addBackend throws on duplicate name", async () => {
        settingsMap.set("litellm-connector.backends", [{ name: "existing", url: "http://existing:4000" }]);

        const manager = new ConfigManager(mockSecrets);
        await assert.rejects(
            () => manager.addBackend({ name: "existing", url: "http://other:4000" }),
            /already exists/
        );
    });

    test("removeBackend removes backend and cleans up secret", async () => {
        settingsMap.set("litellm-connector.backends", [{ name: "to-remove", url: "http://remove:4000" }]);
        secretsMap.set("litellm-connector.apiKey.to-remove", "sk-remove");

        const manager = new ConfigManager(mockSecrets);
        await manager.removeBackend("to-remove");

        const backends = await manager.listBackends();
        assert.strictEqual(backends.length, 0);
        assert.strictEqual(secretsMap.has("litellm-connector.apiKey.to-remove"), false);
    });

    test("reportFeatureToggles calls telemetry service with correct toggles", async () => {
        const manager = new ConfigManager(mockSecrets);
        const captureStub = sinon.stub();
        const telemetryMock = {
            captureFeatureToggled: captureStub,
        } as unknown as TelemetryService;
        manager.setTelemetryService(telemetryMock);

        settingsMap.set("litellm-connector.inlineCompletions.enabled", true);
        settingsMap.set("litellm-connector.enableResponsesApi", true);
        settingsMap.set("litellm-connector.commitModelIdOverride", "gpt-4");
        settingsMap.set("litellm-connector.emitUsageData", true);
        settingsMap.set("litellm-connector.disableCaching", false);
        settingsMap.set("litellm-connector.disableQuotaToolRedaction", false);

        await manager.reportFeatureToggles("test_source");

        assert.strictEqual(captureStub.callCount, 6);
        assert.ok(captureStub.calledWith("inline-completions", true, "test_source"));
        assert.ok(captureStub.calledWith("responses-api", true, "test_source"));
        assert.ok(captureStub.calledWith("commit-message", true, "test_source"));
        assert.ok(captureStub.calledWith("usage-data", true, "test_source"));
        assert.ok(captureStub.calledWith("caching", true, "test_source"));
        assert.ok(captureStub.calledWith("quota-tool-redaction", true, "test_source"));
    });

    test("getConfig reads modelIdOverride and trims whitespace", async () => {
        // Override the stubbed config value for this test.
        configGetStub.callsFake((key: string, defaultValue?: unknown) => {
            if (key === "litellm-connector.baseUrl") {
                return "";
            }
            if (key === "litellm-connector.apiKeySecretRef") {
                return "default";
            }
            if (key === "litellm-connector.modelIdOverride") {
                return "  gpt-4o  ";
            }
            switch (key) {
                case "litellm-connector.inactivityTimeout":
                    return 60;
                case "litellm-connector.disableCaching":
                    return true;
                case "litellm-connector.disableQuotaToolRedaction":
                    return false;
                case "litellm-connector.modelOverrides":
                    return {};
                default:
                    return defaultValue;
            }
        });

        const manager = new ConfigManager(mockSecrets);
        const cfg = await manager.getConfig();
        assert.strictEqual(cfg.modelIdOverride, "gpt-4o");
    });

    test("getConfig treats whitespace-only modelIdOverride as unset", async () => {
        configGetStub.callsFake((key: string, defaultValue?: unknown) => {
            if (key === "litellm-connector.baseUrl") {
                return "";
            }
            if (key === "litellm-connector.apiKeySecretRef") {
                return "default";
            }
            if (key === "litellm-connector.modelIdOverride") {
                return "   ";
            }
            switch (key) {
                case "litellm-connector.inactivityTimeout":
                    return 60;
                case "litellm-connector.disableCaching":
                    return true;
                case "litellm-connector.disableQuotaToolRedaction":
                    return false;
                case "litellm-connector.modelOverrides":
                    return {};
                default:
                    return defaultValue;
            }
        });

        const manager = new ConfigManager(mockSecrets);
        const cfg = await manager.getConfig();
        assert.strictEqual(cfg.modelIdOverride, undefined);
    });

    test("getConfig reads experimental usage emission flag", async () => {
        settingsMap.set("litellm-connector.emitUsageData", true);

        const manager = new ConfigManager(mockSecrets);
        const cfg = await manager.getConfig();

        assert.strictEqual(cfg.experimentalEmitUsageData, true);
    });

    test("cleanupAllConfiguration removes all stored configuration", async () => {
        const manager = new ConfigManager(mockSecrets);

        // Set up initial config
        await manager.setConfig({ url: "https://api.example.com", key: "sk-123" });

        // Sanity check precondition
        const before = await manager.getConfig();
        assert.strictEqual(before.url, "https://api.example.com");
        assert.strictEqual(before.key, "sk-123");

        // Clean up all configuration
        await manager.cleanupAllConfiguration();

        // Verify configuration is cleared
        const clearedConfig = await manager.getConfig();
        assert.strictEqual(clearedConfig.url, "");
        assert.strictEqual(clearedConfig.key, undefined);
    });

    test("updateBackend updates existing entry and key", async () => {
        settingsMap.set("litellm-connector.backends", [{ name: "b1", url: "u1", enabled: true }]);
        const manager = new ConfigManager(mockSecrets);

        await manager.updateBackend("b1", { url: "u2" }, "new-key");
        const backends = await manager.listBackends();
        assert.strictEqual(backends[0].url, "u2");
        assert.strictEqual(secretsMap.get("litellm-connector.apiKey.b1"), "new-key");
    });

    test("updateBackend and removeBackend throw if not found", async () => {
        const manager = new ConfigManager(mockSecrets);
        await assert.rejects(() => manager.updateBackend("none", {}), /not found/);
        await assert.rejects(() => manager.removeBackend("none"), /not found/);
    });

    test("reportFeatureToggles is a no-op without telemetry service", async () => {
        const manager = new ConfigManager(mockSecrets);
        // This should not throw
        await manager.reportFeatureToggles("test");
    });
});
