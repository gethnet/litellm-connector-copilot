import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";

import * as extension from "../../extension";
import { ConfigManager } from "../../config/configManager";
import { LiteLLMChatProvider } from "../../providers";
import { InlineCompletionsRegistrar } from "../../inlineCompletions/registerInlineCompletions";
import { createMockSecrets, createMockOutputChannel } from "../utils/testMocks";

suite("Extension Activation Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("activate registers providers and commands", async () => {
        const mockSecrets = createMockSecrets();

        const context = {
            subscriptions: [],
            secrets: mockSecrets,
        } as unknown as vscode.ExtensionContext;

        // Avoid touching real output channels.
        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());

        // UA builder.
        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        // vscode.version is a non-configurable property in the test host; don't stub it.

        // Inline registrar should be created+initialized.
        const initStub = sandbox.stub(InlineCompletionsRegistrar.prototype, "initialize");

        // Config prompt path: treat as configured.
        sandbox.stub(ConfigManager.prototype, "isConfigured").resolves(true);

        // Avoid unexpected UI prompts.
        sandbox.stub(vscode.window, "showInformationMessage");

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

    test("activate prompts classic config flow when not configured", async () => {
        const mockSecrets = createMockSecrets();

        const context = {
            subscriptions: [],
            secrets: mockSecrets,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());

        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        sandbox.stub(InlineCompletionsRegistrar.prototype, "initialize");

        // Not configured => show prompt.
        sandbox.stub(ConfigManager.prototype, "isConfigured").resolves(false);

        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns({ dispose() {} } as vscode.Disposable);
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        const execStub = sandbox.stub(vscode.commands, "executeCommand").resolves(undefined);
        sandbox.stub(vscode.window, "showInformationMessage").resolves("Configure" as never);

        extension.activate(context);

        // Wait a tick for the isConfigured promise chain and the selection handler.
        await new Promise((r) => setTimeout(r, 0));

        assert.strictEqual(execStub.calledWith("litellm-connector.manage"), true);
    });

    test("deactivate does not clear configuration", async () => {
        // Ensure Logger doesn't explode if used during deactivate.
        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());

        const context = {
            subscriptions: [],
            secrets: {} as vscode.SecretStorage,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        // vscode.version is a non-configurable property in the test host; don't stub it.
        sandbox.stub(InlineCompletionsRegistrar.prototype, "initialize");
        sandbox.stub(ConfigManager.prototype, "isConfigured").resolves(true);
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns({ dispose() {} } as vscode.Disposable);
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        extension.activate(context);
        await extension.deactivate();
        // No cleanup should be triggered on deactivate; settings/secrets should persist.
    });

    test("activate skips classic configuration prompt when provider is already configured", async () => {
        const mockSecrets = createMockSecrets();

        const context = {
            subscriptions: [],
            secrets: mockSecrets,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());

        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        sandbox.stub(InlineCompletionsRegistrar.prototype, "initialize");

        const executeCommandStub = sandbox.stub(vscode.commands, "executeCommand").resolves(undefined);
        const isConfiguredStub = sandbox.stub(ConfigManager.prototype, "isConfigured").resolves(true);

        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns({ dispose() {} } as vscode.Disposable);
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        extension.activate(context);

        // Wait a tick
        await new Promise((r) => setTimeout(r, 0));

        assert.strictEqual(isConfiguredStub.called, true);
        assert.strictEqual(executeCommandStub.calledWith("litellm-connector.manage"), false);
    });

    test("deactivate tolerates repeated disposal", async () => {
        const mockSecrets = createMockSecrets();

        const context = {
            subscriptions: [],
            secrets: mockSecrets,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());

        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        sandbox.stub(InlineCompletionsRegistrar.prototype, "initialize");
        sandbox.stub(ConfigManager.prototype, "isConfigured").resolves(true);
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns({ dispose() {} } as vscode.Disposable);
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        extension.activate(context);
        await extension.deactivate();
        await extension.deactivate();
        assert.ok(true, "Repeated deactivate should not throw");
    });

    test("activate handles missing extension object gracefully", async () => {
        const mockSecrets = createMockSecrets();

        const context = {
            subscriptions: [],
            secrets: mockSecrets,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());

        // Extension not found.
        sandbox.stub(vscode.extensions, "getExtension").returns(undefined);
        sandbox.stub(InlineCompletionsRegistrar.prototype, "initialize");
        sandbox.stub(ConfigManager.prototype, "isConfigured").resolves(true);
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns({ dispose() {} } as vscode.Disposable);
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        extension.activate(context);
        assert.ok(context.subscriptions.length > 0);
    });

    test("activate handles registration failure gracefully", async () => {
        const mockSecrets = createMockSecrets();

        const context = {
            subscriptions: [],
            secrets: mockSecrets,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());

        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        sandbox.stub(InlineCompletionsRegistrar.prototype, "initialize");
        sandbox.stub(ConfigManager.prototype, "isConfigured").resolves(true);

        // Throw during registration.
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").throws(new Error("reg failed"));
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        extension.activate(context);
        // Should not throw and continue activation.
        assert.ok(context.subscriptions.length > 0);
    });

    test("activate handles configuration prompt dismissal", async () => {
        const mockSecrets = createMockSecrets();

        const context = {
            subscriptions: [],
            secrets: mockSecrets,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());

        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        sandbox.stub(InlineCompletionsRegistrar.prototype, "initialize");

        sandbox.stub(ConfigManager.prototype, "isConfigured").resolves(false);
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns({ dispose() {} } as vscode.Disposable);
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        const execStub = sandbox.stub(vscode.commands, "executeCommand").resolves(undefined);
        // Dismiss prompt.
        sandbox.stub(vscode.window, "showInformationMessage").resolves(undefined);

        extension.activate(context);

        await new Promise((r) => setTimeout(r, 0));

        assert.strictEqual(execStub.calledWith("litellm-connector.manage"), false);
    });
});
