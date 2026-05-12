import * as assert from "assert";
import type * as vscode from "vscode";

import { ConfigManager } from "../config/configManager";

suite("ConfigManager", () => {
    test("convertProviderConfiguration returns a backend session when baseUrl is provided", async () => {
        const secrets = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            keys: async () => [],
            onDidChange: () => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const manager = new ConfigManager(secrets);
        const session = manager.convertProviderConfiguration("group-a", {
            baseUrl: "http://localhost:4000",
            apiKey: "secret",
        });

        assert.ok(session);
        assert.strictEqual(session?.backendName, "group-a");
        assert.strictEqual(session?.baseUrl, "http://localhost:4000");
        assert.strictEqual(session?.apiKey, "secret");
    });

    test("convertProviderConfiguration returns undefined without a baseUrl", async () => {
        const secrets = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            keys: async () => [],
            onDidChange: () => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const manager = new ConfigManager(secrets);
        assert.strictEqual(manager.convertProviderConfiguration("group-a", { apiKey: "secret" }), undefined);
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
