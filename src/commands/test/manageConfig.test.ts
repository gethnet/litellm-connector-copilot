import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import {
    registerManageConfigCommand,
    registerReloadModelsCommand,
    registerShowModelsCommand,
    registerCheckConnectionCommand,
} from "../../commands/manageConfig";
import { ConfigManager } from "../../config/configManager";
import { LiteLLMClient } from "../../adapters/litellmClient";
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
        const showInputBoxStub = sandbox.stub(vscode.window, "showInputBox");
        showInputBoxStub.onFirstCall().resolves("new-url");
        showInputBoxStub.onSecondCall().resolves("new-key");
        const showInfoStub = sandbox.stub(vscode.window, "showInformationMessage");

        // Get the registered command handler
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

        assert.strictEqual(
            mockConfigManager.setConfig.calledWith({
                url: "new-url",
                key: "new-key",
            }),
            true
        );
        assert.strictEqual(showInfoStub.calledOnce, true);
    });

    test("aborts if URL input is cancelled", async () => {
        mockConfigManager.getConfig.resolves({ url: "", key: "" });
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

        const qpStub = sandbox.stub(vscode.window, "showQuickPick").resolves({ label: "gpt-4o" } as never);
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
        configManagerStub.getConfig.resolves({ url: "http://localhost:4000", key: "k" });

        const checkStub = sandbox.stub(LiteLLMClient.prototype, "checkConnection").resolves({
            latencyMs: 100,
            modelCount: 5,
            sampleModelIds: ["m1", "m2"],
        });

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
        assert.ok(String(infoStub.firstCall.args[0]).includes("Connection successful"));
    });

    test("checkConnection: reports error on failed connection", async () => {
        const configManagerStub = sandbox.createStubInstance(ConfigManager);
        configManagerStub.getConfig.resolves({ url: "http://localhost:4000", key: "k" });

        sandbox.stub(LiteLLMClient.prototype, "checkConnection").rejects(new Error("Network Error"));

        sandbox.stub(vscode.window, "withProgress").callsFake(async (_opts, task) => {
            return task(
                { report: () => {} } as unknown as vscode.Progress<unknown>,
                new vscode.CancellationTokenSource().token
            );
        });
        const errorStub = sandbox.stub(vscode.window, "showErrorMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.checkConnection") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerCheckConnectionCommand(configManagerStub as unknown as ConfigManager);
        await handler?.();

        assert.strictEqual(errorStub.calledOnce, true);
        assert.ok(String(errorStub.firstCall.args[0]).includes("Connection failed: Network Error"));
    });
});
