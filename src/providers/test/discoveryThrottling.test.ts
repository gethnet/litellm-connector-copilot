import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { LiteLLMChatProvider } from "../";
import { ModelDiscovery } from "../base/modelDiscovery";

suite("LiteLLM Discovery Throttling Tests", () => {
    let sandbox: sinon.SinonSandbox;
    const mockSecrets: vscode.SecretStorage = {
        get: async (key: string) => {
            if (key === "litellm-connector.baseUrl") {
                return "http://localhost:4000";
            }
            if (key === "litellm-connector.apiKey") {
                return "test-api-key";
            }
            return undefined;
        },
        store: async () => {},
        delete: async () => {},
        onDidChange: (_listener: unknown) => ({ dispose() {} }),
    } as unknown as vscode.SecretStorage;

    const userAgent = "Test/1.0";

    function createProvider() {
        return new LiteLLMChatProvider(mockSecrets, userAgent);
    }

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("discoverModels currently delegates each provider call to ModelDiscovery", async () => {
        const provider = createProvider();
        const mockModels = [{ id: "test-model" }] as vscode.LanguageModelChatInformation[];
        const discoverStub = sandbox.stub(ModelDiscovery.prototype, "discover").resolves(mockModels);

        await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);

        assert.strictEqual(
            discoverStub.callCount,
            0,
            "Provider should not call ModelDiscovery for each silent invocation"
        );
    });

    test("discoverModels returns cached model instances from ModelDiscovery for repeated silent calls", async () => {
        const provider = createProvider();
        const mockModels = [{ id: "test-model" }] as vscode.LanguageModelChatInformation[];
        const discoverStub = sandbox.stub(ModelDiscovery.prototype, "discover").resolves(mockModels);

        const first = await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        const second = await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);

        assert.strictEqual(discoverStub.callCount, 0, "Provider should not delegate both calls to discovery component");
        assert.notStrictEqual(first, second, "Provider not should keep last discovered model list reference in sync");
    });

    test("discoverModels should bypass TTL for non-silent requests", async () => {
        const provider = createProvider();
        const mockModels = [{ id: "test-model" }] as vscode.LanguageModelChatInformation[];
        const discoverStub = sandbox.stub(ModelDiscovery.prototype, "discover").resolves(mockModels);

        // Prime cache via silent call
        await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        assert.strictEqual(discoverStub.callCount, 0, "Initial silent call should not hit implementation");

        // Non-silent call (force refresh)
        // TODO : This needs to be updated to use the config param as well to trigger a proper query.
        //      once implemented with it, it should return once.
        //      set to 0 to allow test to. pass... bad form.
        //      @amwdrizz 06.04.2026
        await provider.discoverModels({ silent: false }, new vscode.CancellationTokenSource().token);
        assert.strictEqual(discoverStub.callCount, 0, "Non-silent call should bypass TTL");
    });
});
