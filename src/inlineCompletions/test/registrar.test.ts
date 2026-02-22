import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";

import { InlineCompletionsRegistrar } from "..//registerInlineCompletions";
import { LiteLLMTelemetry } from "../../utils/telemetry";

suite("InlineCompletionsRegistrar Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("initialize does not register provider when disabled", () => {
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

        const getStub = sandbox
            .stub(vscode.workspace, "getConfiguration")
            .returns({ get: () => false } as unknown as vscode.WorkspaceConfiguration);
        void getStub;

        const registerStub = sandbox.stub(vscode.languages, "registerInlineCompletionItemProvider");
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");

        const registrar = new InlineCompletionsRegistrar({} as vscode.SecretStorage, "ua", context);

        registrar.initialize();

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

    test("initialize registers provider when enabled", () => {
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

        sandbox
            .stub(vscode.workspace, "getConfiguration")
            .returns({ get: () => true } as unknown as vscode.WorkspaceConfiguration);

        const disposable = { dispose: sandbox.stub() } as unknown as vscode.Disposable;
        const registerStub = sandbox.stub(vscode.languages, "registerInlineCompletionItemProvider").returns(disposable);
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");

        const registrar = new InlineCompletionsRegistrar({} as vscode.SecretStorage, "ua", context);

        registrar.initialize();

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

    test("configuration change toggles registration", () => {
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

        let enabled = false;
        sandbox
            .stub(vscode.workspace, "getConfiguration")
            .callsFake(() => ({ get: () => enabled }) as unknown as vscode.WorkspaceConfiguration);

        let changeHandler: ((e: vscode.ConfigurationChangeEvent) => void) | undefined;
        sandbox.stub(vscode.workspace, "onDidChangeConfiguration").callsFake((cb) => {
            changeHandler = cb;
            return { dispose() {} } as vscode.Disposable;
        });

        const disposable = { dispose: sandbox.stub() } as unknown as vscode.Disposable;
        const registerStub = sandbox.stub(vscode.languages, "registerInlineCompletionItemProvider").returns(disposable);

        const registrar = new InlineCompletionsRegistrar({} as vscode.SecretStorage, "ua", context);
        registrar.initialize();

        // Initially disabled -> not registered
        assert.strictEqual(registerStub.called, false);

        // Enable and trigger configuration event
        enabled = true;
        changeHandler?.({
            affectsConfiguration: (key: string) => key === "litellm-connector.inlineCompletions.enabled",
        } as unknown as vscode.ConfigurationChangeEvent);

        assert.strictEqual(registerStub.calledOnce, true);

        // Disable and trigger configuration event -> should dispose
        enabled = false;
        changeHandler?.({
            affectsConfiguration: (key: string) => key === "litellm-connector.inlineCompletions.enabled",
        } as unknown as vscode.ConfigurationChangeEvent);

        assert.strictEqual((disposable as unknown as { dispose: sinon.SinonStub }).dispose.calledOnce, true);
    });
});
