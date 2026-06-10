import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { ConfigManager } from "../../../config/configManager";
import { DiscoveryBackoffController, sharedDiscoveryBackoff, type DiscoveryBackoffDecision } from "../discoveryBackoff";
import { LiteLLMProviderRegistry } from "../../liteLLMProviderRegistry";

/**
 * Tests for the shared discovery backoff controller and its integration
 * with the BackendRegistry. The backoff lives at the discovery boundary:
 * when an HTTP `/model/info` request fails, the registry consults
 * `sharedDiscoveryBackoff.recordFailure(...)` and either sleeps for the
 * computed delay or surfaces a `vscode.LanguageModelError.Blocked` once
 * the failure threshold is exceeded.
 *
 * The `clearCaches()` method on the registry resets the shared controller
 * so a user-initiated reload starts from a clean slate.
 */
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

    test("LiteLLMProviderRegistry shares the process-global backoff controller", async () => {
        // This test verifies that when multiple discovery attempts fail,
        // they share a global backoff controller that eventually blocks
        // further discovery attempts.

        const recordFailureStub = sandbox.stub(sharedDiscoveryBackoff, "recordFailure").callsFake(() => ({
            attempt: 1,
            delayMs: 500,
            shouldBlock: true,
        }));

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

        const registry = new LiteLLMProviderRegistry({
            configManager: configManager as unknown as ConfigManager,
            userAgent: "test",
            onModernConfigurationDetected: () => {},
        });

        const token = new vscode.CancellationTokenSource().token;

        // First discovery should trigger backoff and block
        const promise = registry.discoverModels(
            {
                silent: false,
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-key" },
            },
            token
        );
        await assert.rejects(promise, /Discovery blocked/);

        // recordFailure should have been called at least once
        assert.ok(recordFailureStub.calledOnce);
    });

    test("clearCaches resets the shared backoff state", () => {
        const registry = new LiteLLMProviderRegistry({
            configManager: configManager as unknown as ConfigManager,
            userAgent: "test",
            onModernConfigurationDetected: () => {},
        });

        sharedDiscoveryBackoff.recordFailure(0);
        sharedDiscoveryBackoff.recordFailure(1_000);

        registry.clearCaches();

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
