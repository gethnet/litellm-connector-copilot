import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { LiteLLMChatProvider } from "../";

/**
 * Typed view of the private cache fields that throttling tests inspect.
 * Centralizing the shape avoids `(provider as any).<member>` access.
 */
interface DiscoveryThrottlingInternals {
    _modelListFetchedAtMs: number;
    _lastModelList: vscode.LanguageModelChatInformation[];
    _doDiscoverModels: (
        options: { silent?: boolean },
        token: vscode.CancellationToken
    ) => Promise<vscode.LanguageModelChatInformation[]>;
}

function internals(p: LiteLLMChatProvider): DiscoveryThrottlingInternals {
    return p as unknown as DiscoveryThrottlingInternals;
}

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

    test("discoverModels should deduplicate in-flight requests", async () => {
        const provider = createProvider();

        // Use a controlled promise that we resolve manually
        let resolveRequest: (value: vscode.LanguageModelChatInformation[]) => void;
        const requestPromise = new Promise<vscode.LanguageModelChatInformation[]>((resolve) => {
            resolveRequest = resolve;
        });

        // Stub the internal _doDiscoverModels which is what discoverModels calls.
        // This decouples the test from LiteLLMClient and complex async timing.
        const doDiscoverStub = sandbox.stub(internals(provider), "_doDiscoverModels").returns(requestPromise);

        // Fire multiple concurrent discovery requests
        const p1 = provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        const p2 = provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);

        // Resolve the underlying request
        const mockModels = [{ id: "test-model" }] as vscode.LanguageModelChatInformation[];
        resolveRequest!(mockModels);

        const [results1, results2] = await Promise.all([p1, p2]);

        assert.strictEqual(doDiscoverStub.callCount, 1, "Should only call implementation once for concurrent requests");
        assert.strictEqual(results1, results2, "Both calls should return the exact same promise result");
        assert.deepStrictEqual(results1, mockModels);
    });

    test("discoverModels should respect TTL for subsequent calls", async () => {
        const provider = createProvider();
        const mockModels = [{ id: "test-model" }] as vscode.LanguageModelChatInformation[];

        // Stub the internal implementation
        const doDiscoverStub = sandbox.stub(internals(provider), "_doDiscoverModels").resolves(mockModels);

        // First call
        await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        assert.strictEqual(doDiscoverStub.callCount, 1, "First call should hit implementation");

        // Manually set the state to simulate time passing (well within 30s TTL)
        internals(provider)._modelListFetchedAtMs = Date.now() - 10000;
        internals(provider)._lastModelList = mockModels;

        // Second call immediately after
        const results = await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        assert.strictEqual(doDiscoverStub.callCount, 1, "Second call should return cached models within TTL");
        assert.deepStrictEqual(results, mockModels);

        // Manually set the fetched time to 31 seconds ago (past TTL)
        internals(provider)._modelListFetchedAtMs = Date.now() - 31000;

        await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        assert.strictEqual(doDiscoverStub.callCount, 2, "Call after TTL should hit implementation again");
    });

    test("discoverModels should bypass TTL for non-silent requests", async () => {
        const provider = createProvider();
        const mockModels = [{ id: "test-model" }] as vscode.LanguageModelChatInformation[];
        const doDiscoverStub = sandbox.stub(internals(provider), "_doDiscoverModels").resolves(mockModels);

        // Set state to "recently fetched"
        internals(provider)._modelListFetchedAtMs = Date.now() - 5000;
        internals(provider)._lastModelList = mockModels;

        // Non-silent call (force refresh)
        await provider.discoverModels({ silent: false }, new vscode.CancellationTokenSource().token);
        assert.strictEqual(doDiscoverStub.callCount, 1, "Non-silent call should bypass TTL");
    });
});
