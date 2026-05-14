import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import {
    registerManageConfigCommand,
    registerReloadModelsCommand,
    registerShowModelsCommand,
    registerCheckConnectionCommand,
    registerResetConfigCommand,
    registerManageBackendsCommand,
} from "../../commands/manageConfig";
import { ConfigManager } from "../../config/configManager";
import { MultiBackendClient } from "../../adapters/multiBackendClient";
import type { LiteLLMChatProvider } from "../../providers";

suite("ManageConfig Command Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;
    let mockConfigManager: sinon.SinonStubbedInstance<ConfigManager>;
    let mockContext: vscode.ExtensionContext;

    setup(() => {
        sandbox = sinon.createSandbox();
        mockConfigManager = sandbox.createStubInstance(ConfigManager);
        mockContext = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    });

    teardown(() => {
        sandbox.restore();
    });

    test("registers command correctly", () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        registerManageConfigCommand(mockContext, mockConfigManager as unknown as ConfigManager);
        assert.strictEqual(registerStub.calledWith("litellm-connector.manage"), true);
    });

    test("manage command routes directly to manageBackends", async () => {
        const executeCommandStub = sandbox.stub(vscode.commands, "executeCommand").resolves(undefined);
        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");

        let commandHandler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, handler) => {
            if (id === "litellm-connector.manage") {
                commandHandler = handler as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerManageConfigCommand(mockContext, mockConfigManager as unknown as ConfigManager);
        await commandHandler?.();

        assert.strictEqual(executeCommandStub.calledWith("litellm-connector.manageBackends"), true);
        assert.strictEqual(showQuickPickStub.called, false);
        assert.strictEqual(mockConfigManager.setConfig.called, false);
    });

    test("add backend stores trimmed entered backend name", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        configManagerStub.listBackends.resolves([]);

        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        showQuickPickStub
            .onFirstCall()
            .resolves({ label: "$(add) Add Backend", id: "add" } as unknown as vscode.QuickPickItem);

        const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
        showInputBoxStub.onFirstCall().resolves("  Cloud  ");
        showInputBoxStub.onSecondCall().resolves(" http://localhost:4000 ");
        showInputBoxStub.onThirdCall().resolves(" key-123 ");

        sandbox.stub(vscode.window, "showInformationMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.manageBackends") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerManageBackendsCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.strictEqual(configManagerStub.addBackend.calledOnce, true);
        assert.strictEqual(showQuickPickStub.firstCall.args[1]?.ignoreFocusOut, true);
        assert.strictEqual(showInputBoxStub.getCall(0).args[0]?.ignoreFocusOut, true);
        assert.strictEqual(showInputBoxStub.getCall(1).args[0]?.ignoreFocusOut, true);
        assert.strictEqual(showInputBoxStub.getCall(2).args[0]?.ignoreFocusOut, true);
        assert.deepStrictEqual(configManagerStub.addBackend.firstCall.args[0], {
            name: "Cloud",
            url: "http://localhost:4000",
            enabled: true,
        });
        assert.strictEqual(configManagerStub.addBackend.firstCall.args[1], "key-123");
    });

    test("manage: exits when backend picker is dismissed", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        configManagerStub.listBackends.resolves([]);

        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        showQuickPickStub.onFirstCall().resolves(undefined);

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.manageBackends") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerManageBackendsCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.strictEqual(configManagerStub.addBackend.called, false);
        assert.strictEqual(configManagerStub.removeBackend.called, false);
        assert.strictEqual(configManagerStub.updateBackend.called, false);
    });

    test("manage: exits when backend action picker is dismissed", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        const backend = { name: "KeepMe", url: "http://url", enabled: true };
        configManagerStub.listBackends.resolves([backend]);

        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        showQuickPickStub.onFirstCall().resolves({ label: "KeepMe", backend } as unknown as vscode.QuickPickItem);
        showQuickPickStub.onSecondCall().resolves(undefined);

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.manageBackends") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerManageBackendsCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.strictEqual(showQuickPickStub.getCall(0).args[1]?.ignoreFocusOut, true);
        assert.strictEqual(showQuickPickStub.getCall(1).args[1]?.ignoreFocusOut, true);
        assert.strictEqual(configManagerStub.removeBackend.called, false);
        assert.strictEqual(configManagerStub.updateBackend.called, false);
    });

    test("reset: does nothing when confirmation is dismissed", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        const provider = { clearModelCache: sandbox.stub() } as unknown as LiteLLMChatProvider;

        sandbox.stub(vscode.window, "showWarningMessage").resolves(undefined);

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.reset") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerResetConfigCommand(configManagerStub as unknown as ConfigManager, provider);
        await handler?.();

        assert.strictEqual(configManagerStub.cleanupAllConfiguration.called, false);
        assert.strictEqual((provider.clearModelCache as sinon.SinonStub).called, false);
    });
});

suite("Model Commands Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("showModels: prompts to reload when cache is empty", async () => {
        const provider = {
            getLastKnownModels: () => [],
        } as unknown as LiteLLMChatProvider;

        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.showModels") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerShowModelsCommand(provider);
        await handler?.();

        assert.strictEqual(infoStub.calledOnce, true);
        assert.ok(String(infoStub.firstCall.args[0]).includes("No cached models"));
    });

    test("showModels: quick pick copies model id", async () => {
        const provider = {
            getLastKnownModels: () => [
                {
                    id: "gpt-4o",
                    name: "gpt-4o",
                    tooltip: "LiteLLM (chat)",
                    family: "litellm",
                    version: "1.0.0",
                    maxInputTokens: 1,
                    maxOutputTokens: 1,
                    capabilities: { toolCalling: true, imageInput: false },
                },
            ],
        } as unknown as LiteLLMChatProvider;

        const qpStub = sandbox
            .stub(vscode.window, "showQuickPick")
            .resolves({ label: "gpt-4o", modelId: "gpt-4o" } as never);
        const clipStub = sandbox.stub();
        sandbox.stub(vscode.env, "clipboard").value({ writeText: clipStub } as unknown as vscode.Clipboard);
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.showModels") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerShowModelsCommand(provider);
        await handler?.();

        assert.strictEqual(qpStub.calledOnce, true);
        assert.strictEqual(clipStub.calledWith("gpt-4o"), true);
        assert.ok(infoStub.calledOnce);
    });

    test("reloadModels: clears cache and refetches", async () => {
        const clearStub = sandbox.stub();
        const provideStub = sandbox.stub().resolves([]);
        const getStub = sandbox.stub().returns([{ id: "m1" }]);

        const provider = {
            clearModelCache: clearStub,
            provideLanguageModelChatInformation: provideStub,
            getLastKnownModels: getStub,
        } as unknown as LiteLLMChatProvider;

        // Avoid actually showing progress UI; run the callback immediately.
        sandbox.stub(vscode.window, "withProgress").callsFake(async (_opts, task) => {
            return task(
                { report: sandbox.stub() } as unknown as vscode.Progress<unknown>,
                new vscode.CancellationTokenSource().token
            );
        });
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.reloadModels") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerReloadModelsCommand(provider);
        await handler?.();

        assert.strictEqual(clearStub.calledOnce, true);
        assert.strictEqual(provideStub.calledOnce, true);
        assert.ok(String(infoStub.firstCall.args[0]).includes("Reloaded"));
    });

    test("checkConnection: reports success on valid connection", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        configManagerStub.resolveBackends.resolves([
            { name: "default", url: "http://localhost:4000", apiKey: "k", enabled: true },
        ]);

        const checkStub = sandbox
            .stub(MultiBackendClient.prototype, "checkConnectionAll")
            .resolves([{ backendName: "default", latencyMs: 100, modelCount: 5 }]);

        sandbox.stub(vscode.window, "withProgress").callsFake(async (_opts, task) => {
            return task(
                { report: sandbox.stub() } as unknown as vscode.Progress<unknown>,
                new vscode.CancellationTokenSource().token
            );
        });
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.checkConnection") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerCheckConnectionCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.strictEqual(checkStub.calledOnce, true);
        assert.ok(infoStub.calledOnce);
    });

    test("showModels: quick pick copies full model id including provider prefix", async () => {
        const fullModelId = "vertex/gemini-3-flash-preview";
        const provider = {
            getLastKnownModels: () => [
                {
                    id: fullModelId,
                    name: "gemini-3-flash-preview",
                    tooltip: "LiteLLM (chat)",
                    family: "litellm",
                    version: "1.0.0",
                    maxInputTokens: 1,
                    maxOutputTokens: 1,
                    capabilities: { toolCalling: true, imageInput: false },
                    tags: [],
                },
            ],
        } as unknown as LiteLLMChatProvider;

        const qpStub = sandbox.stub(vscode.window, "showQuickPick").resolves({
            label: "gemini-3-flash-preview",
            modelId: fullModelId,
        } as unknown as vscode.QuickPickItem);

        const clipStub = sandbox.stub();
        sandbox.stub(vscode.env, "clipboard").value({ writeText: clipStub } as unknown as vscode.Clipboard);
        sandbox.stub(vscode.window, "showInformationMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.showModels") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerShowModelsCommand(provider);

        if (!handler) {
            throw new Error("Command handler not registered");
        }

        await handler();

        assert.strictEqual(qpStub.calledOnce, true);
        assert.strictEqual(
            clipStub.calledWith(fullModelId),
            true,
            `Expected to copy ${fullModelId} but copied something else`
        );
    });

    test("reloadModels: surfaces warning when refresh fails", async () => {
        const provider = {
            clearModelCache: sandbox.stub(),
            provideLanguageModelChatInformation: sandbox.stub().rejects(new Error("reload failed")),
            getLastKnownModels: sandbox.stub().returns([]),
        } as unknown as LiteLLMChatProvider;

        sandbox.stub(vscode.window, "withProgress").callsFake(async (_opts, task) => {
            return task(
                { report: sandbox.stub() } as unknown as vscode.Progress<unknown>,
                new vscode.CancellationTokenSource().token
            );
        });
        const warnStub = sandbox.stub(vscode.window, "showWarningMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.reloadModels") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerReloadModelsCommand(provider);
        await handler?.();

        assert.ok(warnStub.calledOnce);
    });

    test("reloadModels: handles zero models found", async () => {
        const provider = {
            clearModelCache: sandbox.stub(),
            provideLanguageModelChatInformation: sandbox.stub().resolves([]),
            getLastKnownModels: sandbox.stub().returns([]),
        } as unknown as LiteLLMChatProvider;

        sandbox.stub(vscode.window, "withProgress").callsFake(async (_opts, task) => {
            return task(
                { report: sandbox.stub() } as unknown as vscode.Progress<unknown>,
                new vscode.CancellationTokenSource().token
            );
        });
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.reloadModels") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerReloadModelsCommand(provider);
        await handler?.();

        assert.ok(infoStub.calledOnce);
    });

    test("checkConnection: warns when no enabled backends are configured", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        configManagerStub.resolveBackends.resolves([]);

        const warnStub = sandbox.stub(vscode.window, "showWarningMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.checkConnection") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerCheckConnectionCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.strictEqual(warnStub.calledOnce, true);
        assert.ok(String(warnStub.firstCall.args[0]).includes("No enabled backends"));
    });

    test("checkConnection: handles unexpected error in withProgress", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        configManagerStub.resolveBackends.resolves([{ name: "b1", url: "u", apiKey: "k", enabled: true }]);

        sandbox.stub(vscode.window, "withProgress").callsFake(async (_opts, task) => {
            return task(
                { report: sandbox.stub() } as unknown as vscode.Progress<unknown>,
                new vscode.CancellationTokenSource().token
            );
        });
        sandbox.stub(MultiBackendClient.prototype, "checkConnectionAll").rejects(new Error("unexpected"));
        const errorStub = sandbox.stub(vscode.window, "showErrorMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.checkConnection") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerCheckConnectionCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.ok(errorStub.calledOnce);
    });

    test("manage: handles add backend cancellation", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        configManagerStub.listBackends.resolves([]);

        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        showQuickPickStub
            .onFirstCall()
            .resolves({ label: "$(add) Add Backend", id: "add" } as unknown as vscode.QuickPickItem);

        const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
        showInputBoxStub.resolves(undefined); // Cancel at any prompt

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.manageBackends") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerManageBackendsCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.strictEqual(configManagerStub.addBackend.called, false);
    });

    test("manage: handles edit URL action", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        const backend = { name: "B1", url: "http://old", enabled: true };
        configManagerStub.listBackends.resolves([backend]);

        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        showQuickPickStub.onFirstCall().resolves({ label: "B1", id: "B1", backend } as unknown as vscode.QuickPickItem);
        showQuickPickStub
            .onSecondCall()
            .resolves({ label: "$(edit) Edit URL", id: "edit_url" } as unknown as vscode.QuickPickItem);

        const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
        showInputBoxStub.resolves("http://new");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.manageBackends") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerManageBackendsCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.ok(configManagerStub.updateBackend.calledOnce);
        assert.strictEqual(configManagerStub.updateBackend.firstCall.args[1].url, "http://new");
    });

    test("manage: handles edit API key action", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        const backend = { name: "B1", url: "u", enabled: true };
        configManagerStub.listBackends.resolves([backend]);

        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        showQuickPickStub.onFirstCall().resolves({ label: "B1", id: "B1", backend } as unknown as vscode.QuickPickItem);
        showQuickPickStub
            .onSecondCall()
            .resolves({ label: "$(key) Edit API Key", id: "edit_key" } as unknown as vscode.QuickPickItem);

        const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
        showInputBoxStub.resolves("new-key");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.manageBackends") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerManageBackendsCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.strictEqual(configManagerStub.updateBackend.calledOnce, true);
        assert.ok(configManagerStub.updateBackend.calledWith("B1", {}, "new-key"));
    });
});
