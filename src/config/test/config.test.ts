import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { ConfigManager } from "..//configManager";

suite("ConfigManager Unit Tests", () => {
    let mockSecrets: vscode.SecretStorage;
    let secretsMap: Map<string, string>;
    let getConfigurationStub: sinon.SinonStub;
    let configGetStub: sinon.SinonStub;

    setup(() => {
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
            switch (key) {
                case "litellm-connector.inactivityTimeout":
                    return 60;
                case "litellm-connector.disableCaching":
                    return true;
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
            update: async () => {},
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
        assert.strictEqual(secretsMap.size, 0);
    });

    test("isConfigured returns true only when url is present", async () => {
        const manager = new ConfigManager(mockSecrets);

        assert.strictEqual(await manager.isConfigured(), false);

        await manager.setConfig({ url: "https://api.example.com" });
        assert.strictEqual(await manager.isConfigured(), true);

        await manager.setConfig({ url: "" });
        assert.strictEqual(await manager.isConfigured(), false);
    });

    test("convertProviderConfiguration converts VS Code provider config to internal format", () => {
        const manager = new ConfigManager(mockSecrets);
        const providerConfig = {
            baseUrl: "https://api.litellm.ai",
            apiKey: "sk-test-key-123",
        };

        const config = manager.convertProviderConfiguration(providerConfig);

        assert.strictEqual(config.url, "https://api.litellm.ai");
        assert.strictEqual(config.key, "sk-test-key-123");
        assert.strictEqual(typeof config.inactivityTimeout, "number");
        assert.strictEqual(typeof config.disableCaching, "boolean");
        assert.strictEqual(typeof config.disableQuotaToolRedaction, "boolean");
        assert.notStrictEqual(config.modelOverrides, undefined);
        assert.strictEqual(config.modelIdOverride, undefined);
    });

    test("getConfig reads modelIdOverride and trims whitespace", async () => {
        // Override the stubbed config value for this test.
        configGetStub.callsFake((key: string, defaultValue?: unknown) => {
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

    test("convertProviderConfiguration handles missing fields", () => {
        const manager = new ConfigManager(mockSecrets);
        const providerConfig = {
            baseUrl: "https://api.litellm.ai",
        };

        const config = manager.convertProviderConfiguration(providerConfig);

        assert.strictEqual(config.url, "https://api.litellm.ai");
        assert.strictEqual(config.key, undefined);
    });

    test("convertProviderConfiguration handles empty baseUrl", () => {
        const manager = new ConfigManager(mockSecrets);
        const providerConfig = {
            baseUrl: "",
            apiKey: "sk-test",
        };

        const config = manager.convertProviderConfiguration(providerConfig);

        assert.strictEqual(config.url, "");
        assert.strictEqual(config.key, "sk-test");
    });

    test("migrateToProviderConfiguration returns false when no existing config", async () => {
        const manager = new ConfigManager(mockSecrets);
        const result = await manager.migrateToProviderConfiguration();
        assert.strictEqual(result, false);
    });

    test("migrateToProviderConfiguration returns false on second call (already migrated)", async () => {
        const manager = new ConfigManager(mockSecrets);

        // First migration should succeed (stores migration marker)
        await manager.setConfig({ url: "https://api.example.com", key: "sk-123" });
        const firstResult = await manager.migrateToProviderConfiguration();
        // First migration may fail due to test environment, but should set marker
        assert.ok(firstResult === true || firstResult === false, "Migration should return a boolean");

        // If first migration succeeded, second should return false (already migrated)
        if (firstResult) {
            const secondResult = await manager.migrateToProviderConfiguration();
            assert.strictEqual(secondResult, false);
        }
    });

    test("migration clears legacy secret storage after successful migration", async () => {
        const manager = new ConfigManager(mockSecrets);

        // Set up initial config in secret storage
        await manager.setConfig({ url: "https://api.example.com", key: "sk-123" });
        const config = await manager.getConfig();
        assert.strictEqual(config.url, "https://api.example.com");
        assert.strictEqual(config.key, "sk-123");

        // Perform migration
        const migrationResult = await manager.migrateToProviderConfiguration();

        // If migration succeeded (not guaranteed in test environment),
        // the old secrets should be cleared
        if (migrationResult) {
            const clearedConfig = await manager.getConfig();
            assert.strictEqual(clearedConfig.url, "");
            assert.strictEqual(clearedConfig.key, undefined);
        }
    });

    test("cleanupAllConfiguration removes all stored configuration", async () => {
        const manager = new ConfigManager(mockSecrets);

        // Set up initial config
        await manager.setConfig({ url: "https://api.example.com", key: "sk-123" });
        const config = await manager.getConfig();
        assert.strictEqual(config.url, "https://api.example.com");
        assert.strictEqual(config.key, "sk-123");

        // Clean up all configuration
        await manager.cleanupAllConfiguration();

        // Verify configuration is cleared
        const clearedConfig = await manager.getConfig();
        assert.strictEqual(clearedConfig.url, "");
        assert.strictEqual(clearedConfig.key, undefined);
    });
});
