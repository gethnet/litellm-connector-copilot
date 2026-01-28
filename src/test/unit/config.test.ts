import * as assert from "assert";
import * as vscode from "vscode";
import { ConfigManager } from "../../config/configManager";

suite("ConfigManager Unit Tests", () => {
	let mockSecrets: vscode.SecretStorage;
	let secretsMap: Map<string, string>;

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
	});

	test("getConfig returns empty values when nothing is stored", async () => {
		const manager = new ConfigManager(mockSecrets);
		const config = await manager.getConfig();
		assert.strictEqual(config.url, "");
		assert.strictEqual(config.key, undefined);
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
});
