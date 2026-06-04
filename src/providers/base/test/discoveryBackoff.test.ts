import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { ConfigManager } from "../../../config/configManager";
import { DiscoveryBackoffController, sharedDiscoveryBackoff, type DiscoveryBackoffDecision } from "../discoveryBackoff";
import { ModelDiscovery } from "../modelDiscovery";

suite("Discovery backoff", () => {
    let sandbox: sinon.SinonSandbox;
    let configManager: sinon.SinonStubbedInstance<ConfigManager>;

    setup(() => {
        sandbox = sinon.createSandbox();
        sharedDiscoveryBackoff.reset();
        configManager = sandbox.createStubInstance(ConfigManager);
        configManager.getConfig.resolves({} as never);
    });

    teardown(() => {
        sharedDiscoveryBackoff.reset();
        sandbox.restore();
    });

    test("controller escalates delay and blocks on the 10th failure", () => {
        const backoff = new DiscoveryBackoffController();

        const decisions: DiscoveryBackoffDecision[] = [];
        for (let i = 0; i < 9; i++) {
            const decision = backoff.recordFailure(i * 1_000);
            decisions.push(decision);
            assert.strictEqual(decision.attempt, i + 1);
            assert.strictEqual(decision.delayMs, (i + 1) * 500);
            assert.strictEqual(decision.shouldBlock, false);
        }

        const ninth = decisions[8];
        assert.strictEqual(ninth.attempt, 9);
        assert.strictEqual(ninth.delayMs, 4_500);
        assert.strictEqual(ninth.shouldBlock, false);
        assert.strictEqual(ninth.delayMs, Math.min(7_500, 4_500));

        const tenth = backoff.recordFailure(9_000);
        assert.strictEqual(tenth.attempt, 10);
        assert.strictEqual(tenth.delayMs, 5_000);
        assert.strictEqual(tenth.shouldBlock, true);

        const blockedWhileCoolingDown = backoff.recordFailure(9_500);
        assert.strictEqual(blockedWhileCoolingDown.attempt, 10);
        assert.strictEqual(blockedWhileCoolingDown.delayMs, 0);
        assert.strictEqual(blockedWhileCoolingDown.shouldBlock, true);
    });

    test("controller resets after 5 seconds without a new failure", () => {
        const backoff = new DiscoveryBackoffController();

        backoff.recordFailure(0);
        backoff.recordFailure(1_000);

        const resetDecision = backoff.recordFailure(6_001);
        assert.strictEqual(resetDecision.attempt, 1);
        assert.strictEqual(resetDecision.delayMs, 500);
        assert.strictEqual(resetDecision.shouldBlock, false);
    });

    test("ModelDiscovery shares the process-global backoff controller", async () => {
        // This test verifies that when multiple discovery attempts fail,
        // they share a global backoff controller that eventually blocks
        // further discovery attempts.

        const recordFailureStub = sandbox.stub(sharedDiscoveryBackoff, "recordFailure").callsFake(() => ({
            attempt: 1,
            delayMs: 500,
            shouldBlock: true,
        }));

        // Note: With the legacy discovery path disabled, backoff is triggered
        // when HTTP requests to the model endpoint fail. To test backoff behavior,
        // we need to:
        // 1. Return a valid session from convertProviderConfiguration
        // 2. Make the LiteLLMClient.getModelInfo call fail

        // Create a stub client that rejects on getModelInfo
        const stubClient = {
            getModelInfo: sandbox.stub().rejects(new Error("HTTP request failed")),
            getEndpoint: sandbox.stub().returns("http://localhost:4000/v1/chat/completions"),
        };

        (configManager.convertProviderConfiguration as sinon.SinonStub).returns({
            backendName: "test-backend",
            baseUrl: "http://localhost:4000",
            apiKey: "test-key",
            client: stubClient,
        });

        const discoveryA = new ModelDiscovery({
            configManager,
            userAgent: "test",
            onModernConfigurationDetected: () => {},
        });

        const tokenA = new vscode.CancellationTokenSource().token;

        // First discovery should trigger backoff and block
        const promise = discoveryA.discover({
            options: {
                silent: false,
                configuration: { providerName: "test-group", baseUrl: "http://localhost:4000", apiKey: "test-key" },
            },
            token: tokenA,
        });
        await assert.rejects(promise, /Discovery blocked/);

        // recordFailure should have been called at least once
        assert.ok(recordFailureStub.calledOnce);
    });

    test("clearCaches resets the shared backoff state", () => {
        const discovery = new ModelDiscovery({
            configManager,
            userAgent: "test",
            onModernConfigurationDetected: () => {},
        });

        sharedDiscoveryBackoff.recordFailure(0);
        sharedDiscoveryBackoff.recordFailure(1_000);

        discovery.clearCaches();

        const decision = sharedDiscoveryBackoff.recordFailure(0);
        assert.strictEqual(decision.attempt, 1);
        assert.strictEqual(decision.delayMs, 500);
        assert.strictEqual(decision.shouldBlock, false);
    });

    test("controller resets after 5 seconds without a new failure (regression)", () => {
        const backoff = new DiscoveryBackoffController();

        backoff.recordFailure(0);
        backoff.recordFailure(1_000);

        const resetDecision = backoff.recordFailure(6_001);
        assert.strictEqual(resetDecision.attempt, 1);
        assert.strictEqual(resetDecision.delayMs, 500);
        assert.strictEqual(resetDecision.shouldBlock, false);
    });
});
