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

    test("updates config when input is provided", async () => {
        mockConfigManager.getConfig.resolves({ url: "old-url", key: "old-key" });
        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        // Select "Configure Single Backend (Legacy)"
        showQuickPickStub
            .onFirstCall()
            .resolves({ label: "Configure Single Backend (Legacy)" } as vscode.QuickPickItem);

        const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
        showInputBoxStub.onFirstCall().resolves("new-url");
        showInputBoxStub.onSecondCall().resolves("new-key");
        const showInfoStub = sandbox.stub(vscode.window, "showInformationMessage");

        const provider = {
            clearModelCache: () => {},
            discoverModels: async () => [],
            refreshModelInformation: () => {},
        } as unknown as LiteLLMChatProvider;

        const refreshStub = sandbox.stub(provider, "refreshModelInformation");

        // Get the registered command handler
        let commandHandler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, handler) => {
            if (id === "litellm-connector.manage") {
                commandHandler = handler as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerManageConfigCommand(mockContext, mockConfigManager as unknown as ConfigManager, provider);

        if (commandHandler) {
            await commandHandler();
        }

        assert.strictEqual(
            mockConfigManager.setConfig.calledWith({
                url: "new-url",
                key: "new-key",
            }),
            true
        );
        assert.strictEqual(showInfoStub.calledOnce, true);
        assert.strictEqual(refreshStub.calledOnce, true);
    });

    test("aborts if URL input is cancelled", async () => {
        mockConfigManager.getConfig.resolves({ url: "", key: "" });
        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        // Select "Configure Single Backend (Legacy)"
        showQuickPickStub
            .onFirstCall()
            .resolves({ label: "Configure Single Backend (Legacy)" } as vscode.QuickPickItem);

        const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
        showInputBoxStub.onFirstCall().resolves(undefined);

        let commandHandler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, handler) => {
            if (id === "litellm-connector.manage") {
                commandHandler = handler as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerManageConfigCommand(mockContext, mockConfigManager as unknown as ConfigManager);

        if (commandHandler) {
            await commandHandler();
        }

        assert.strictEqual(mockConfigManager.setConfig.called, false);
    });

    test("shows unmasked API key when 'thisisunsafe' is entered with existing key", async () => {
        mockConfigManager.getConfig.resolves({ url: "my-url", key: "secret-api-key" });
        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        // Select "Configure Single Backend (Legacy)"
        showQuickPickStub
            .onFirstCall()
            .resolves({ label: "Configure Single Backend (Legacy)" } as vscode.QuickPickItem);

        const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
        showInputBoxStub.onFirstCall().resolves("my-url"); // URL
        showInputBoxStub.onSecondCall().resolves("thisisunsafe"); // Magic string
        showInputBoxStub.onThirdCall().resolves("secret-api-key"); // Unmasked key (user didn't change it)
        const showInfoStub = sandbox.stub(vscode.window, "showInformationMessage");

        let commandHandler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, handler) => {
            if (id === "litellm-connector.manage") {
                commandHandler = handler as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerManageConfigCommand(mockContext, mockConfigManager as unknown as ConfigManager);

        if (commandHandler) {
            await commandHandler();
        }

        // Should have called showInputBox 3 times: URL, masked key, then unmasked key
        assert.strictEqual(showInputBoxStub.callCount, 3);

        // The second call should have password: true
        const secondCall = showInputBoxStub.getCall(1);
        assert.strictEqual(secondCall.args[0]?.password, true);

        // The third call should have password: false
        const thirdCall = showInputBoxStub.getCall(2);
        assert.strictEqual(thirdCall.args[0]?.password, false);
        assert.strictEqual(thirdCall.args[0]?.value, "secret-api-key");

        // Should save the key unchanged
        assert.strictEqual(
            mockConfigManager.setConfig.calledWith({
                url: "my-url",
                key: "secret-api-key",
            }),
            true
        );
        assert.strictEqual(showInfoStub.calledOnce, true);
    });

    test("does not show unmasked key if 'thisisunsafe' is entered without existing key", async () => {
        mockConfigManager.getConfig.resolves({ url: "my-url", key: undefined });
        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        // Select "Configure Single Backend (Legacy)"
        showQuickPickStub
            .onFirstCall()
            .resolves({ label: "Configure Single Backend (Legacy)" } as vscode.QuickPickItem);

        const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
        showInputBoxStub.onFirstCall().resolves("my-url"); // URL
        showInputBoxStub.onSecondCall().resolves("thisisunsafe"); // Magic string but no existing key
        const showInfoStub = sandbox.stub(vscode.window, "showInformationMessage");

        let commandHandler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, handler) => {
            if (id === "litellm-connector.manage") {
                commandHandler = handler as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerManageConfigCommand(mockContext, mockConfigManager as unknown as ConfigManager);

        if (commandHandler) {
            await commandHandler();
        }

        // Should only call showInputBox 2 times (URL and masked key)
        assert.strictEqual(showInputBoxStub.callCount, 2);

        // Should save "thisisunsafe" as the key since there's no existing key to reveal
        assert.strictEqual(
            mockConfigManager.setConfig.calledWith({
                url: "my-url",
                key: "thisisunsafe",
            }),
            true
        );
        assert.strictEqual(showInfoStub.calledOnce, true);
    });

    test("allows editing API key in unmasked mode", async () => {
        mockConfigManager.getConfig.resolves({ url: "my-url", key: "old-secret" });
        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        // Select "Configure Single Backend (Legacy)"
        showQuickPickStub
            .onFirstCall()
            .resolves({ label: "Configure Single Backend (Legacy)" } as vscode.QuickPickItem);

        const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
        showInputBoxStub.onFirstCall().resolves("my-url"); // URL
        showInputBoxStub.onSecondCall().resolves("thisisunsafe"); // Magic string
        showInputBoxStub.onThirdCall().resolves("new-secret"); // Changed key in unmasked mode
        const showInfoStub = sandbox.stub(vscode.window, "showInformationMessage");

        let commandHandler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, handler) => {
            if (id === "litellm-connector.manage") {
                commandHandler = handler as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerManageConfigCommand(mockContext, mockConfigManager as unknown as ConfigManager);

        if (commandHandler) {
            await commandHandler();
        }

        // Should have called showInputBox 3 times
        assert.strictEqual(showInputBoxStub.callCount, 3);

        // Should save the new key
        assert.strictEqual(
            mockConfigManager.setConfig.calledWith({
                url: "my-url",
                key: "new-secret",
            }),
            true
        );
        assert.strictEqual(showInfoStub.calledOnce, true);
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
            return { dispose: () => {} } as vscode.Disposable;
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
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerManageBackendsCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

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
            return { dispose: () => {} } as vscode.Disposable;
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
            return { dispose: () => {} } as vscode.Disposable;
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
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerShowModelsCommand(provider);
        await handler?.();

        assert.strictEqual(qpStub.calledOnce, true);
        assert.strictEqual(clipStub.calledWith("gpt-4o"), true);
        assert.strictEqual(infoStub.calledOnce, true);
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
                { report: () => {} } as unknown as vscode.Progress<unknown>,
                new vscode.CancellationTokenSource().token
            );
        });
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.reloadModels") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerReloadModelsCommand(provider);
        await handler?.();

        assert.strictEqual(clearStub.calledOnce, true);
        assert.strictEqual(provideStub.calledOnce, true);
        assert.strictEqual(infoStub.calledOnce, true);
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
                { report: () => {} } as unknown as vscode.Progress<unknown>,
                new vscode.CancellationTokenSource().token
            );
        });
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.checkConnection") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerCheckConnectionCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.strictEqual(checkStub.calledOnce, true);
        assert.strictEqual(infoStub.calledOnce, true);
        assert.ok(String(infoStub.firstCall.args[0]).includes("connections successful"));
    });

    test("checkConnection: reports error on failed connection", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        configManagerStub.resolveBackends.resolves([
            { name: "default", url: "http://localhost:4000", apiKey: "k", enabled: true },
        ]);

        const checkStub = sandbox
            .stub(MultiBackendClient.prototype, "checkConnectionAll")
            .resolves([{ backendName: "default", latencyMs: -1, modelCount: 0, error: "Network Error" }]);

        sandbox.stub(vscode.window, "withProgress").callsFake(async (_opts, task) => {
            return task(
                { report: () => {} } as unknown as vscode.Progress<unknown>,
                new vscode.CancellationTokenSource().token
            );
        });
        const warnStub = sandbox.stub(vscode.window, "showWarningMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.checkConnection") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerCheckConnectionCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.strictEqual(checkStub.calledOnce, true);
        assert.strictEqual(warnStub.calledOnce, true);
        assert.ok(String(warnStub.firstCall.args[0]).includes("0/1 connections successful"));
    });

    test("reset: cleans up config and cache upon confirmation", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        const clearStub = sandbox.stub();
        const provider = { clearModelCache: clearStub } as unknown as LiteLLMChatProvider;

        sandbox.stub(vscode.window, "showWarningMessage").resolves("Reset All" as unknown as vscode.MessageItem);
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.reset") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerResetConfigCommand(configManagerStub as unknown as ConfigManager, provider);
        await handler?.();

        assert.ok(configManagerStub.cleanupAllConfiguration.calledOnce);
        assert.ok(clearStub.calledOnce);
        assert.ok(infoStub.calledWith("LiteLLM configuration has been reset."));
    });

    test("manage: handles add backend flow", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        configManagerStub.getConfig.resolves({ url: "", key: "" });
        configManagerStub.listBackends.resolves([]);

        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        showQuickPickStub.onFirstCall().resolves({ label: "$(add) Add Backend" } as vscode.QuickPickItem);

        const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
        showInputBoxStub.onCall(0).resolves("NewBackend");
        showInputBoxStub.onCall(1).resolves("http://new-url");
        showInputBoxStub.onCall(2).resolves("new-key");

        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.manageBackends") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerManageBackendsCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.ok(
            configManagerStub.addBackend.calledWith(
                { name: "NewBackend", url: "http://new-url", enabled: true },
                "new-key"
            )
        );
        assert.ok(infoStub.calledWith('Backend "NewBackend" added.'));
    });

    test("manage: handles remove backend flow", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        const backend = { name: "ToRemove", url: "url", enabled: true };
        configManagerStub.listBackends.resolves([backend]);

        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        showQuickPickStub.onFirstCall().resolves({ label: "ToRemove", backend } as unknown as vscode.QuickPickItem);
        showQuickPickStub.onSecondCall().resolves({ id: "remove" } as unknown as vscode.QuickPickItem);

        sandbox.stub(vscode.window, "showWarningMessage").resolves("Remove" as unknown as vscode.MessageItem);

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.manageBackends") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerManageBackendsCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.ok(configManagerStub.removeBackend.calledWith("ToRemove"));
    });

    test("manage: handles toggle backend flow", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        const backend = { name: "ToToggle", url: "url", enabled: true };
        configManagerStub.listBackends.resolves([backend]);

        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        showQuickPickStub.onFirstCall().resolves({ label: "ToToggle", backend } as unknown as vscode.QuickPickItem);
        showQuickPickStub.onSecondCall().resolves({ id: "toggle" } as unknown as vscode.QuickPickItem);

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.manageBackends") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerManageBackendsCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.ok(configManagerStub.updateBackend.calledWith("ToToggle", { enabled: false }));
    });

    test("reloadModels: surfaces warning when refresh fails", async () => {
        const provider = {
            clearModelCache: sandbox.stub(),
            provideLanguageModelChatInformation: sandbox.stub().rejects(new Error("reload failed")),
            getLastKnownModels: sandbox.stub().returns([]),
        } as unknown as LiteLLMChatProvider;

        sandbox.stub(vscode.window, "withProgress").callsFake(async (_opts, task) => {
            return task(
                { report: () => {} } as unknown as vscode.Progress<unknown>,
                new vscode.CancellationTokenSource().token
            );
        });
        const warningStub = sandbox.stub(vscode.window, "showWarningMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.reloadModels") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerReloadModelsCommand(provider);
        await handler?.();

        assert.strictEqual(warningStub.calledOnce, true);
        assert.ok(String(warningStub.firstCall.args[0]).includes("reload failed"));
    });

    test("reloadModels: handles zero models found", async () => {
        const provider = {
            clearModelCache: sandbox.stub(),
            provideLanguageModelChatInformation: sandbox.stub().resolves([]),
            getLastKnownModels: sandbox.stub().returns([]),
        } as unknown as LiteLLMChatProvider;

        sandbox.stub(vscode.window, "withProgress").callsFake(async (_opts, task) => {
            return task(
                { report: () => {} } as unknown as vscode.Progress<unknown>,
                new vscode.CancellationTokenSource().token
            );
        });
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.reloadModels") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerReloadModelsCommand(provider);
        await handler?.();

        assert.ok(String(infoStub.firstCall.args[0]).includes("Reloaded 0 models"));
    });

    test("checkConnection: warns when no enabled backends are configured", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        configManagerStub.resolveBackends.resolves([]);

        sandbox.stub(vscode.window, "withProgress").callsFake(async (_opts, task) => {
            return task(
                { report: () => {} } as unknown as vscode.Progress<unknown>,
                new vscode.CancellationTokenSource().token
            );
        });
        const warningStub = sandbox.stub(vscode.window, "showWarningMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.checkConnection") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerCheckConnectionCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.strictEqual(warningStub.calledOnce, true);
        assert.ok(String(warningStub.firstCall.args[0]).includes("No enabled backends"));
    });

    test("checkConnection: handles unexpected error in withProgress", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        sandbox.stub(vscode.window, "withProgress").callsFake(async () => {
            throw new Error("progress crash");
        });

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.checkConnection") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerCheckConnectionCommand(configManagerStub as unknown as ConfigManager);
        // withProgress throws, but registerCommand handler doesn't catch it internally if it leaks.
        // Actually checkConnection implementation does NOT have a try-catch around withProgress.
        // Wait, checkConnection HAS a try-catch INSIDE the task passed to withProgress.
        // But if withProgress itself throws, it's not caught.
        try {
            await handler?.();
        } catch {
            /* expected */
        }
    });

    test("manage: handles add backend cancellation", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        configManagerStub.listBackends.resolves([]);

        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        showQuickPickStub.onFirstCall().resolves({ label: "$(add) Add Backend" } as vscode.QuickPickItem);

        const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
        showInputBoxStub.onCall(0).resolves(undefined); // Cancel name

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.manageBackends") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerManageBackendsCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.strictEqual(configManagerStub.addBackend.called, false);
    });

    test("manage: handles edit URL action", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        const backend = { name: "ToEdit", url: "old-url", enabled: true };
        configManagerStub.listBackends.resolves([backend]);

        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        showQuickPickStub.onFirstCall().resolves({ label: "ToEdit", backend } as unknown as vscode.QuickPickItem);
        showQuickPickStub.onSecondCall().resolves({ id: "edit_url" } as unknown as vscode.QuickPickItem);

        const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
        showInputBoxStub.onFirstCall().resolves("new-url");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.manageBackends") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerManageBackendsCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.ok(configManagerStub.updateBackend.calledWith("ToEdit", { url: "new-url" }));
    });

    test("manage: handles edit API key action", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        const backend = { name: "ToEditKey", url: "url", enabled: true };
        configManagerStub.listBackends.resolves([backend]);

        const showQuickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        showQuickPickStub.onFirstCall().resolves({ label: "ToEditKey", backend } as unknown as vscode.QuickPickItem);
        showQuickPickStub.onSecondCall().resolves({ id: "edit_key" } as unknown as vscode.QuickPickItem);

        const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
        showInputBoxStub.onFirstCall().resolves("new-key");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.manageBackends") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerManageBackendsCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.ok(configManagerStub.updateBackend.calledWith("ToEditKey", {}, "new-key"));
    });
});
