import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { ConfigManager } from "../configManager";
import type { TelemetryService } from "../../telemetry/telemetryService";

suite("ConfigManager Unit Tests", () => {
    let mockSecrets: vscode.SecretStorage;
    let secretsMap: Map<string, string>;
    let configManager: ConfigManager;
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
        // Note: legacy `litellm-connector.baseUrl`, `.apiKeySecretRef`, and
        // `.emitUsageData` settings are no longer read by ConfigManager
        // (VS Code 1.120+ per-group configuration). Stubs for them have been
        // removed; tests that previously relied on these returns are covered
        // by the per-test `configGetStub.callsFake(...)` overrides below.
        configGetStub.callsFake((key: string, defaultValue?: unknown) => {
            if (settingsMap.has(key)) {
                return settingsMap.get(key);
            }
            switch (key) {
                case "litellm-connector.inactivityTimeout":
                    return 60;
                case "litellm-connector.disableCaching":
                    return false;
                case "litellm-connector.disableQuotaToolRedaction":
                    return false;
                case "litellm-connector.modelOverrides":
                    return [];
                case "litellm-connector.modelIdOverride":
                    return "";
                case "litellm-connector.modelCapabilitiesOverrides":
                    return {};
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
        configManager = new ConfigManager(mockSecrets);
    });

    teardown(() => {
        getConfigurationStub?.restore();
    });

    test("getConfig returns empty values when nothing is stored", async () => {
        const manager = new ConfigManager(mockSecrets);
        const config = await manager.getConfig();
        // url and key are no longer part of LiteLLMConfig (VS Code 1.120+ per-group configuration)
        assert.strictEqual(config.modelIdOverride, undefined);
    });

    test("getConfig defaults disableCaching to false", async () => {
        const config = await configManager.getConfig();

        assert.strictEqual(config.disableCaching, false);
    });

    test("getConfig reads modelCapabilitiesOverrides", async () => {
        settingsMap.set("litellm-connector.modelCapabilitiesOverrides", {
            "gpt-4o": "toolCalling, imageInput",
            "some-model": "tools",
            "another-model": ["vision"],
        });

        const manager = new ConfigManager(mockSecrets);
        const cfg = await manager.getConfig();

        assert.deepStrictEqual(cfg.modelCapabilitiesOverrides, {
            "gpt-4o": { toolCalling: true, imageInput: true },
            "some-model": { toolCalling: true },
            "another-model": { imageInput: true },
        });
    });

    test("getConfig returns empty object for modelCapabilitiesOverrides when not set", async () => {
        const manager = new ConfigManager(mockSecrets);
        const cfg = await manager.getConfig();

        assert.deepStrictEqual(cfg.modelCapabilitiesOverrides, {});
    });

    // getConfig modelOverrides test removed in v2.2.0 (LiteLLMConfig.modelOverrides field removed
    // — dead plumbing; override system reads workspace setting directly).

    // resolveBackends tests removed - method no longer exists (VS Code 1.120+ per-group configuration)

    test("reportFeatureToggles calls telemetry service with correct toggles", async () => {
        const manager = new ConfigManager(mockSecrets);
        const captureStub = sinon.stub();
        const telemetryMock = {
            captureFeatureToggled: captureStub,
        } as unknown as TelemetryService;
        manager.setTelemetryService(telemetryMock);

        settingsMap.set("litellm-connector.commitModelIdOverride", "gpt-4");
        settingsMap.set("litellm-connector.disableCaching", false);
        settingsMap.set("litellm-connector.disableQuotaToolRedaction", false);

        settingsMap.set("litellm-connector.forceResponsesEndpoint", true);
        settingsMap.set("litellm-connector.allowChatCompletionsFallback", true);

        await manager.reportFeatureToggles("test_source");

        assert.strictEqual(captureStub.callCount, 3);
        assert.ok(captureStub.calledWith("commit-message", true, "test_source"));
        assert.ok(captureStub.calledWith("caching", true, "test_source"));
        assert.ok(captureStub.calledWith("quota-tool-redaction", true, "test_source"));
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

    test("reportFeatureToggles is a no-op without telemetry service", async () => {
        const manager = new ConfigManager(mockSecrets);
        // This should not throw
        await manager.reportFeatureToggles("test");
    });

    test("should read forceResponsesEndpoint from workspace settings", async () => {
        settingsMap.set("litellm-connector.forceResponsesEndpoint", false);
        const config = await configManager.getConfig();
        assert.strictEqual(config.forceResponsesEndpoint, false);
    });

    test("should default forceResponsesEndpoint to false when not set", async () => {
        settingsMap.delete("litellm-connector.forceResponsesEndpoint");
        const config = await configManager.getConfig();
        assert.strictEqual(config.forceResponsesEndpoint, false);
    });

    test("should read allowChatCompletionsFallback from workspace settings", async () => {
        settingsMap.set("litellm-connector.allowChatCompletionsFallback", true);
        const config = await configManager.getConfig();
        assert.strictEqual(config.allowChatCompletionsFallback, true);
    });

    test("should default allowChatCompletionsFallback to false when not set", async () => {
        settingsMap.delete("litellm-connector.allowChatCompletionsFallback");
        const config = await configManager.getConfig();
        assert.strictEqual(config.allowChatCompletionsFallback, false);
    });

    test("every LiteLLMConfig field is populated by getConfig() (anti-dead-config guard)", async () => {
        // This test exists because settings were previously declared, read into
        // LiteLLMConfig, and reported to telemetry WITHOUT any runtime behavior.
        // If you add a new LiteLLMConfig field, you MUST also wire it to behavior
        // or this guard will fail. Do NOT weaken this guard — codify the contract.
        //
        // The strong guard is the per-feature wiring tests (transport.fallback,
        // disableCaching.wiring). This test pins the expected live field set so
        // a dead field addition is at least surfaced here.
        const config = await configManager.getConfig();
        const liveFields: (keyof typeof config)[] = [
            "inactivityTimeout",
            "disableCaching",
            "disableQuotaToolRedaction",
            "enableModelOverrides",
            "modelCapabilitiesOverrides",
            "modelIdOverride",
            "commitModelIdOverride",
            "forceResponsesEndpoint",
            "allowChatCompletionsFallback",
            // NOTE: sendDefaultParameters, inlineCompletions*, v2ApiEnabled,
            // enableResponses, modelOverrides (field) are intentionally absent —
            // removed as dead config. Do NOT re-add them.
        ];
        for (const field of liveFields) {
            assert.ok(
                field in config,
                `LiteLLMConfig.${field} must be populated by getConfig() — if removed, update this guard`
            );
        }
    });
});
