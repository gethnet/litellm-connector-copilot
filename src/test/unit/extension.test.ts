import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";

import * as extension from "../../extension";
import { ConfigManager } from "../../config/configManager";
import { LiteLLMChatProvider } from "../../providers";
import { InlineCompletionsRegistrar } from "../../inlineCompletions/registerInlineCompletions";

suite("Extension Activation Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("activate registers providers and commands", async () => {
        const context = {
            subscriptions: [],
            secrets: {} as vscode.SecretStorage,
        } as unknown as vscode.ExtensionContext;

        // Avoid touching real output channels.
        sandbox.stub(vscode.window, "createOutputChannel").returns({
            info() {},
            warn() {},
            error() {},
            debug() {},
            trace() {},
            show() {},
            dispose() {},
        } as unknown as vscode.LogOutputChannel);

        // UA builder.
        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        // vscode.version is a non-configurable property in the test host; don't stub it.

        // Inline registrar should be created+initialized.
        const initStub = sandbox.stub(InlineCompletionsRegistrar.prototype, "initialize");

        // Migration path should not throw.
        sandbox.stub(ConfigManager.prototype, "migrateToProviderConfiguration").resolves(false);

        // Config prompt path: treat as configured.
        sandbox.stub(ConfigManager.prototype, "isConfigured").resolves(true);

        // Provider registration.
        const lmReg = { dispose() {} } as vscode.Disposable;
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns(lmReg);

        // Commands registration.
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        // Ensure chat provider can be constructed without side effects.
        sandbox.stub(LiteLLMChatProvider.prototype, "getLastKnownModels").returns([]);

        extension.activate(context);

        assert.ok(initStub.calledOnce);
        // Should have pushed registrar + lm registration + multiple command disposables.
        assert.ok(context.subscriptions.length >= 2);
    });

    test("deactivate cleans up configuration when initialized", async () => {
        // Ensure Logger doesn't explode if used during deactivate.
        sandbox.stub(vscode.window, "createOutputChannel").returns({
            info() {},
            warn() {},
            error() {},
            debug() {},
            trace() {},
            show() {},
            dispose() {},
        } as unknown as vscode.LogOutputChannel);

        const context = {
            subscriptions: [],
            secrets: {} as vscode.SecretStorage,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        // vscode.version is a non-configurable property in the test host; don't stub it.
        sandbox.stub(InlineCompletionsRegistrar.prototype, "initialize");
        sandbox.stub(ConfigManager.prototype, "migrateToProviderConfiguration").resolves(false);
        sandbox.stub(ConfigManager.prototype, "isConfigured").resolves(true);
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns({ dispose() {} } as vscode.Disposable);
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        const cleanupStub = sandbox.stub(ConfigManager.prototype, "cleanupAllConfiguration").resolves();

        extension.activate(context);
        await extension.deactivate();

        assert.strictEqual(cleanupStub.calledOnce, true);
    });
});
