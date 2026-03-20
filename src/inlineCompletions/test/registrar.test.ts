import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";

import { InlineCompletionsRegistrar } from "..//registerInlineCompletions";
import { LiteLLMTelemetry } from "../../utils/telemetry";
import { ConfigManager } from "../../config/configManager";

suite("InlineCompletionsRegistrar Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;
    let mockSecrets: vscode.SecretStorage;

    setup(() => {
        sandbox = sinon.createSandbox();
        // Create a proper mock for SecretStorage
        mockSecrets = {
            get: sandbox.stub().resolves(undefined),
            store: sandbox.stub().resolves(),
            delete: sandbox.stub().resolves(),
            onDidChange: sandbox.stub(),
        } as unknown as vscode.SecretStorage;
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Wait for async operations to complete by polling until a condition is met or timeout.
     */
    async function waitForAsyncOperation(
        condition: () => boolean,
        timeoutMs = 1000,
        pollIntervalMs = 10
    ): Promise<void> {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            if (condition()) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
        // Final check after timeout
        if (!condition()) {
            throw new Error(`Async operation did not complete within ${timeoutMs}ms`);
        }
    }

    test("initialize does not register provider when disabled", async () => {
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

        // Stub ConfigManager.getConfig to return inlineCompletionsEnabled: false
        sandbox.stub(ConfigManager.prototype, "getConfig").resolves({
            inlineCompletionsEnabled: false,
        } as unknown as Awaited<ReturnType<ConfigManager["getConfig"]>>);

        const registerStub = sandbox.stub(vscode.languages, "registerInlineCompletionItemProvider");
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");

        const registrar = new InlineCompletionsRegistrar(mockSecrets, "ua", context);

        registrar.initialize();

        // Wait for async refreshRegistration to complete
        await waitForAsyncOperation(() => metricStub.called);

        assert.strictEqual(registerStub.called, false);
        assert.strictEqual(
            metricStub.calledWithMatch(
                sinon.match({
                    status: "failure",
                    error: "inline_completions_disabled",
                    caller: "inline-completions.registration",
                })
            ),
            true
        );
    });

    test("initialize registers provider when enabled", async () => {
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

        // Stub ConfigManager.getConfig to return inlineCompletionsEnabled: true
        sandbox.stub(ConfigManager.prototype, "getConfig").resolves({
            inlineCompletionsEnabled: true,
        } as unknown as Awaited<ReturnType<ConfigManager["getConfig"]>>);

        const disposable = { dispose: sandbox.stub() } as unknown as vscode.Disposable;
        const registerStub = sandbox.stub(vscode.languages, "registerInlineCompletionItemProvider").returns(disposable);
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");

        const registrar = new InlineCompletionsRegistrar(mockSecrets, "ua", context);

        registrar.initialize();

        // Wait for async refreshRegistration to complete
        await waitForAsyncOperation(() => metricStub.called);

        assert.strictEqual(registerStub.calledOnce, true);
        assert.ok(Array.isArray(context.subscriptions));
        assert.ok(context.subscriptions.includes(disposable));
        assert.strictEqual(
            metricStub.calledWithMatch(
                sinon.match({
                    status: "success",
                    caller: "inline-completions.registration",
                })
            ),
            true
        );
    });

    test("configuration change toggles registration", async () => {
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

        let enabled = false;
        // Stub ConfigManager.getConfig to return dynamic inlineCompletionsEnabled
        sandbox.stub(ConfigManager.prototype, "getConfig").callsFake(
            async () =>
                ({
                    inlineCompletionsEnabled: enabled,
                }) as unknown as Awaited<ReturnType<ConfigManager["getConfig"]>>
        );

        let changeHandler: ((e: vscode.ConfigurationChangeEvent) => void) | undefined;
        sandbox.stub(vscode.workspace, "onDidChangeConfiguration").callsFake((cb) => {
            changeHandler = cb;
            return { dispose() {} } as vscode.Disposable;
        });

        const disposable = { dispose: sandbox.stub() } as unknown as vscode.Disposable;
        const registerStub = sandbox.stub(vscode.languages, "registerInlineCompletionItemProvider").returns(disposable);

        const registrar = new InlineCompletionsRegistrar(mockSecrets, "ua", context);
        registrar.initialize();

        // Wait for async refreshRegistration to complete
        await waitForAsyncOperation(() => !registerStub.called);

        // Initially disabled -> not registered
        assert.strictEqual(registerStub.called, false);

        // Enable and trigger configuration event
        enabled = true;
        changeHandler?.({
            affectsConfiguration: (key: string) => key === "litellm-connector.inlineCompletions.enabled",
        } as unknown as vscode.ConfigurationChangeEvent);

        // Wait for async refreshRegistration to complete
        await waitForAsyncOperation(() => registerStub.calledOnce);

        assert.strictEqual(registerStub.calledOnce, true);

        // Disable and trigger configuration event -> should dispose
        enabled = false;
        changeHandler?.({
            affectsConfiguration: (key: string) => key === "litellm-connector.inlineCompletions.enabled",
        } as unknown as vscode.ConfigurationChangeEvent);

        // Wait for async refreshRegistration to complete
        await waitForAsyncOperation(() => (disposable as unknown as { dispose: sinon.SinonStub }).dispose.calledOnce);

        assert.strictEqual((disposable as unknown as { dispose: sinon.SinonStub }).dispose.calledOnce, true);
    });
});
