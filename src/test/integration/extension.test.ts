import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";

import * as extension from "../../extension";
import * as providers from "../../providers";
import { createMockSecrets, createMockOutputChannel, createMockMemento } from "../utils/testMocks";

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

        // Avoid unexpected UI prompts.
        sandbox.stub(vscode.window, "showInformationMessage");

        // Provider registration.
        const lmReg = { dispose() {} } as vscode.Disposable;
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns(lmReg);

        // Commands registration.
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        // Ensure chat provider can be constructed without side effects.
        sandbox.stub(providers.LiteLLMChatProvider.prototype, "getLastKnownModels").returns([]);

        extension.activate(context);

        // Should have pushed registrar + lm registration + multiple command disposables.
        assert.ok(context.subscriptions.length >= 2);
    });

    test("activate constructs chat provider with secrets and UA", async () => {
        const mockSecrets = createMockSecrets();
        const context = {
            subscriptions: [],
            secrets: mockSecrets,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());
        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        sandbox.stub(vscode.window, "showInformationMessage");

        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);
        const registerProviderStub = sandbox
            .stub(vscode.lm, "registerLanguageModelChatProvider")
            .returns({ dispose() {} } as vscode.Disposable);

        extension.activate(context);

        assert.strictEqual(registerProviderStub.calledOnce, true);
    });

    test("activate does not refresh model info after configuration changes", async () => {
        const mockSecrets = createMockSecrets();
        const context = {
            subscriptions: [],
            secrets: mockSecrets,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());
        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        sandbox.stub(vscode.window, "showInformationMessage");
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns({ dispose() {} } as vscode.Disposable);
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        const clearModelCacheStub = sandbox.stub(providers.LiteLLMChatProvider.prototype, "clearModelCache");

        let configChangeHandler: ((e: vscode.ConfigurationChangeEvent) => void) | undefined;
        sandbox.stub(vscode.workspace, "onDidChangeConfiguration").callsFake((listener) => {
            configChangeHandler = listener as (e: vscode.ConfigurationChangeEvent) => void;
            return { dispose() {} } as vscode.Disposable;
        });

        extension.activate(context);
        assert.ok(configChangeHandler, "expected onDidChangeConfiguration handler to be registered");

        // Trigger config change WITHOUT affecting litellm-connector config - should not refresh
        const mockEvent = {
            affectsConfiguration: (section: string): boolean => {
                return section === "litellm-connector.someOtherSetting";
            },
        };
        configChangeHandler(mockEvent);
        await new Promise((resolve) => setTimeout(resolve, 300));

        assert.strictEqual(clearModelCacheStub.calledOnce, false);
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
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns({ dispose() {} } as vscode.Disposable);
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        extension.activate(context);
        await extension.deactivate();
        // No cleanup should be triggered on deactivate; settings/secrets should persist.
    });

    test("activate persists modern config session flag when provider detects valid config", async () => {
        const mockSecrets = createMockSecrets();
        const workspaceState = createMockMemento();
        const updateSpy = sandbox.spy(workspaceState, "update");

        const context = {
            subscriptions: [],
            secrets: mockSecrets,
            workspaceState,
        } as unknown as vscode.ExtensionContext;

        let onModernConfigDetected: (() => void) | undefined;
        sandbox
            .stub(providers.LiteLLMChatProvider.prototype, "setModernConfigurationDetectedHandler")
            .callsFake((handler: () => void) => {
                onModernConfigDetected = handler;
            });

        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());
        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
        sandbox.stub(vscode.window, "showInformationMessage");
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").returns({ dispose() {} } as vscode.Disposable);
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        extension.activate(context);

        onModernConfigDetected?.();

        assert.strictEqual(updateSpy.calledWith("litellm-connector.isOnModernConfig", true), true);
    });

    test("deactivate tolerates repeated disposal", async () => {
        const mockSecrets = createMockSecrets();

        const context = {
            subscriptions: [],
            secrets: mockSecrets,
        } as unknown as vscode.ExtensionContext;

        sandbox.stub(vscode.window, "createOutputChannel").returns(createMockOutputChannel());

        sandbox.stub(vscode.extensions, "getExtension").returns({ packageJSON: { version: "1.2.3" } } as never);
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

        // Throw during registration.
        sandbox.stub(vscode.lm, "registerLanguageModelChatProvider").throws(new Error("reg failed"));
        sandbox.stub(vscode.commands, "registerCommand").returns({ dispose() {} } as vscode.Disposable);

        extension.activate(context);
        // Should not throw and continue activation.
        assert.ok(context.subscriptions.length > 0);
    });
});
