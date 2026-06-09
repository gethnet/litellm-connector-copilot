import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { ConfigManager } from "../configManager";
import { LegacyBackendConfig, LegacyConfigMigration } from "../legacyConfigMigration";

type WorkspaceConfigurationStub = Pick<vscode.WorkspaceConfiguration, "get" | "has" | "update"> & {
    keys: () => string[];
};

suite("LegacyConfigMigration", () => {
    const LEGACY_BASE_URL_KEY = "litellm-connector.baseUrl";
    const LEGACY_BACKENDS_KEY = "litellm-connector.backends";
    const LEGACY_API_KEY_PREFIX = "litellm-connector.apiKey.";

    let sandbox: sinon.SinonSandbox;
    let secretsMap: Map<string, string>;
    let workspaceSettings: Map<string, unknown>;
    let globalStateMap: Map<string, unknown>;
    let configManager: ConfigManager;
    let configurationStub: sinon.SinonStub;
    let hasStub: sinon.SinonStub;
    let context: vscode.ExtensionContext;

    setup(() => {
        sandbox = sinon.createSandbox();
        secretsMap = new Map<string, string>();
        workspaceSettings = new Map<string, unknown>();
        globalStateMap = new Map<string, unknown>();

        const mockSecretStorage: vscode.SecretStorage = {
            get: async (key: string) => secretsMap.get(key),
            store: async (key: string, value: string) => {
                secretsMap.set(key, value);
            },
            delete: async (key: string) => {
                secretsMap.delete(key);
            },
            keys: async () => Array.from(secretsMap.keys()),
            onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
        } as unknown as vscode.SecretStorage;

        configManager = new ConfigManager(mockSecretStorage);

        const configuration: WorkspaceConfigurationStub = {
            get: (key: string, defaultValue?: unknown) => {
                if (workspaceSettings.has(key)) {
                    return workspaceSettings.get(key);
                }
                return defaultValue;
            },
            has: (key: string) => workspaceSettings.has(key),
            update: async (key: string, value: unknown) => {
                if (value === undefined) {
                    workspaceSettings.delete(key);
                } else {
                    workspaceSettings.set(key, value);
                }
            },
            keys: () => Array.from(workspaceSettings.keys()),
        };

        configurationStub = sandbox
            .stub(vscode.workspace, "getConfiguration")
            .returns(configuration as unknown as vscode.WorkspaceConfiguration);
        hasStub = sandbox.stub(configuration, "has").callsFake((key: string) => workspaceSettings.has(key));

        context = {
            secrets: mockSecretStorage,
            globalState: {
                get: <T>(key: string, defaultValue?: T): T => {
                    const stored = globalStateMap.get(key);
                    return (stored !== undefined ? stored : defaultValue) as T;
                },
                update: async (key: string, value: unknown) => {
                    globalStateMap.set(key, value);
                },
                keys: () => Array.from(globalStateMap.keys()),
            },
        } as unknown as vscode.ExtensionContext;
    });

    const createMigration = () => new LegacyConfigMigration(context, configManager);

    suite("generateGroupNames", () => {
        test("respects explicit names", () => {
            const migration = createMigration();
            const backends: LegacyBackendConfig[] = [
                { id: "prod", name: "Prod", baseUrl: "https://prod", apiKey: "key" },
                { id: "dev", name: "Dev", baseUrl: "https://dev", apiKey: "key" },
            ];

            const names = migration.generateGroupNames(backends);

            assert.deepStrictEqual(names, ["Prod", "Dev"]);
        });

        test("assigns LiteLLM naming to unnamed backends", () => {
            const migration = createMigration();
            const backends: LegacyBackendConfig[] = [
                { baseUrl: "https://one", apiKey: "key1" },
                { baseUrl: "https://two", apiKey: "key2" },
            ];

            const names = migration.generateGroupNames(backends);

            assert.deepStrictEqual(names, ["LiteLLM", "LiteLLM 1"]);
        });

        test("interleaves named and unnamed entries", () => {
            const migration = createMigration();
            const backends: LegacyBackendConfig[] = [
                { name: "Primary", baseUrl: "https://primary", apiKey: "key" },
                { baseUrl: "https://secondary", apiKey: "key" },
                { name: "Aux", baseUrl: "https://aux", apiKey: "key" },
                { baseUrl: "https://backup", apiKey: "key" },
            ];

            const names = migration.generateGroupNames(backends);

            assert.deepStrictEqual(names, ["Primary", "LiteLLM", "Aux", "LiteLLM 1"]);
        });
    });

    suite("migration detection", () => {
        test("detects when global setting for baseUrl exists", async () => {
            workspaceSettings.set(LEGACY_BASE_URL_KEY, "https://legacy");
            const migration = createMigration();

            assert.strictEqual(await migration.detectLegacyConfig(), true);
        });

        test("detects when legacy Secrets entries exist", async () => {
            await context.secrets.store("litellm-connector.apiKey", "some-key");
            const migration = createMigration();

            assert.strictEqual(await migration.detectLegacyConfig(), true);
        });

        test("returns false when nothing legacy exists", async () => {
            const migration = createMigration();

            assert.strictEqual(await migration.detectLegacyConfig(), false);
        });
    });

    suite("extractLegacyBackends", () => {
        test("reads multi-backends before single entry", async () => {
            workspaceSettings.set(LEGACY_BACKENDS_KEY, [
                { id: "prod", name: "Prod", baseUrl: "https://prod", apiKeySecretRef: "prod-secret" },
                { id: "dev", baseUrl: "https://dev", apiKeySecretRef: "dev-secret" },
            ]);
            await context.secrets.store("prod-secret", "prod-key");
            await context.secrets.store("litellm-connector.apiKey.dev", "dev-key");

            const migration = createMigration();
            const backends = await migration.extractLegacyBackends();

            assert.strictEqual(backends.length, 2);
            assert.deepStrictEqual(backends[0], {
                id: "prod",
                name: "Prod",
                baseUrl: "https://prod",
                apiKey: "prod-key",
            });
            assert.deepStrictEqual(backends[1], {
                id: "dev",
                baseUrl: "https://dev",
                apiKey: "dev-key",
            });
        });

        test("falls back to single baseUrl when no multi backends", async () => {
            workspaceSettings.set(LEGACY_BASE_URL_KEY, "https://singleton");
            await context.secrets.store("litellm-connector.apiKey", "solo-key");

            const migration = createMigration();
            const backends = await migration.extractLegacyBackends();

            assert.strictEqual(backends.length, 1);
            assert.deepStrictEqual(backends[0], {
                baseUrl: "https://singleton",
                apiKey: "solo-key",
            });
        });
    });

    suite("migration state", () => {
        test("reports not completed before tracking", async () => {
            const migration = createMigration();

            assert.strictEqual(await migration.isMigrationCompleted(), false);
        });

        test("respects global state flag", async () => {
            globalStateMap.set("litellm-connector.migrationCompleted.v1", true);
            const migration = createMigration();

            assert.strictEqual(await migration.isMigrationCompleted(), true);
        });
    });

    teardown(() => {
        sandbox.restore();
    });
});
