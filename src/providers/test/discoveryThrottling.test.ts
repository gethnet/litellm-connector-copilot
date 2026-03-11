import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { LiteLLMChatProvider } from "../";
import { LiteLLMClient } from "../../adapters/litellmClient";

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
    let clock: sinon.SinonFakeTimers;

    function createProvider() {
        return new LiteLLMChatProvider(mockSecrets, userAgent);
    }

    setup(() => {
        sandbox = sinon.createSandbox();
        clock = sandbox.useFakeTimers();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("discoverModels should deduplicate in-flight requests", async () => {
        const provider = createProvider();
        let resolveRequest: (value: unknown) => void;
        const requestPromise = new Promise((resolve) => {
            resolveRequest = resolve;
        });

        const getModelInfoStub = sandbox
            .stub(LiteLLMClient.prototype, "getModelInfo")
            .returns(requestPromise as Promise<{ data: { model_name: string }[] }>);

        // Fire multiple concurrent discovery requests
        const p1 = provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        const p2 = provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);

        // Resolve the underlying request
        resolveRequest!({ data: [{ model_name: "test-model" }] });

        await Promise.all([p1, p2]);

        assert.strictEqual(getModelInfoStub.callCount, 1, "Should only call LiteLLM once for concurrent requests");
    });

    test("discoverModels should respect TTL for subsequent calls", async () => {
        const provider = createProvider();
        const getModelInfoStub = sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({
            data: [{ model_name: "test-model" }],
        });

        // First call
        await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        assert.strictEqual(getModelInfoStub.callCount, 1, "First call should hit LiteLLM");

        // Advance clock by 10 seconds (well within 30s TTL)
        clock.tick(10000);

        // Second call immediately after
        await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        assert.strictEqual(getModelInfoStub.callCount, 1, "Second call should return cached models within TTL");

        // Advance clock past TTL (31 seconds)
        clock.tick(21000);

        await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        assert.strictEqual(getModelInfoStub.callCount, 2, "Call after TTL should hit LiteLLM again");
    });
});
