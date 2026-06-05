import * as assert from "assert";
import type * as vscode from "vscode";

import { ConfigManager } from "../config/configManager";

suite("ConfigManager", () => {
    test("convertProviderConfiguration returns a backend session when provider config is complete", async () => {
        const secrets = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            keys: async () => [],
            onDidChange: () => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const manager = new ConfigManager(secrets);
        const session = manager.convertProviderConfiguration("group-a", {
            providerName: "group-a",
            baseUrl: "http://localhost:4000",
            apiKey: "secret",
        });

        assert.ok(session);
        assert.strictEqual(session?.backendName, "group-a");
        assert.strictEqual(session?.baseUrl, "http://localhost:4000");
        assert.strictEqual(session?.apiKey, "secret");
    });

    test("uses groupName directly as backendName (ignores providerName in config)", async () => {
        const secrets = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            keys: async () => [],
            onDidChange: () => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const manager = new ConfigManager(secrets);
        const session = manager.convertProviderConfiguration("llmapi.wolfram.com", {
            baseUrl: "https://llmapi.wolfram.com",
            apiKey: "sk-test",
            providerName: "should-be-ignored",
        });

        assert.ok(session);
        assert.strictEqual(session?.backendName, "llmapi.wolfram.com");
    });

    test("getConfig no longer exposes legacy url/key/backends", async () => {
        const secrets = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            keys: async () => [],
            onDidChange: () => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const manager = new ConfigManager(secrets);
        const config = await manager.getConfig();

        // url, key, and backends are no longer part of LiteLLMConfig (VS Code 1.120+ per-group configuration)
        assert.strictEqual(config.modelIdOverride, undefined);
    });

    // resolveBackends test removed - method no longer exists (VS Code 1.120+ per-group configuration)

    test("convertProviderConfiguration returns undefined without a baseUrl", async () => {
        const secrets = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            keys: async () => [],
            onDidChange: () => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const manager = new ConfigManager(secrets);
        assert.strictEqual(
            manager.convertProviderConfiguration("group-a", { providerName: "group-a", apiKey: "secret" }),
            undefined
        );
    });

    test("convertProviderConfiguration returns undefined when baseUrl is not http(s)", async () => {
        const secrets = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            keys: async () => [],
            onDidChange: () => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const manager = new ConfigManager(secrets);
        assert.strictEqual(
            manager.convertProviderConfiguration("group-a", {
                providerName: "group-a",
                baseUrl: "localhost:4000",
                apiKey: "secret",
            }),
            undefined
        );
    });

    test("convertProviderConfiguration returns undefined without apiKey", async () => {
        const secrets = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            keys: async () => [],
            onDidChange: () => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const manager = new ConfigManager(secrets);
        assert.strictEqual(
            manager.convertProviderConfiguration("group-a", {
                providerName: "group-a",
                baseUrl: "http://localhost:4000",
            }),
            undefined
        );
    });

    test("dispose resolves cleanly", async () => {
        const secrets = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            keys: async () => [],
            onDidChange: () => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const manager = new ConfigManager(secrets);
        await assert.doesNotReject(async () => manager.dispose());
        await assert.doesNotReject(async () => manager.dispose());
    });

    test("getSecret exposes stored values", async () => {
        const secrets = {
            get: async (key: string) => (key === "litellm-connector.apiKey.default" ? "abc" : undefined),
            store: async () => {},
            delete: async () => {},
            keys: async () => [],
            onDidChange: () => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const manager = new ConfigManager(secrets);
        const secret = await manager.getSecret("litellm-connector.apiKey.default");
        assert.strictEqual(secret, "abc");
    });
});
