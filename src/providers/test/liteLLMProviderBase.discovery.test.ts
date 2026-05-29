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
        sandbox.stub(configManager, "convertProviderConfiguration").resolves({
            backendName: "b1",
            baseUrl: "http://b1",
            apiKey: "k",
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
});
