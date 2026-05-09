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
});
