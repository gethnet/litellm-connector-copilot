import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import {
    registerManageConfigCommand,
    registerReloadModelsCommand,
    registerShowModelsCommand,
} from "../../commands/manageConfig";
import { ConfigManager } from "../../config/configManager";
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

    test("manage command opens Language Models view", async () => {
        const executeCommandStub = sandbox.stub(vscode.commands, "executeCommand").resolves(undefined);
        // Simulate the user clicking "Open Language Models" so the handler proceeds to execute the command.
        sandbox
            .stub(vscode.window, "showInformationMessage")
            .resolves("Open Language Models" as unknown as vscode.MessageItem);

        let commandHandler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, handler) => {
            if (id === "litellm-connector.manage") {
                commandHandler = handler as () => Promise<void>;
            }
            return { dispose: sandbox.stub() } as vscode.Disposable;
        });

        registerManageConfigCommand(mockContext, mockConfigManager as unknown as ConfigManager);
        await commandHandler?.();

        assert.strictEqual(executeCommandStub.called, true);
    });

    test("reloadModels triggers provider discovery and shows info", async () => {
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");

        const provider = {
            clearModelCache: sandbox.stub(),
            getLastKnownModels: () => [],
            provideLanguageModelChatInformation: sandbox.stub().resolves([]),
        } as unknown as LiteLLMChatProvider;

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
        // The `vscode.env.clipboard.writeText` property is non-configurable in the
        // extension host test environment, so we cannot stub it directly. Instead we
        // assert the user-visible side-effect: the "Copied model id:" information
        // message includes the model id the user selected. The clipboard write itself
        // is exercised manually in development.
        const provider = {
            getLastKnownModels: () => [
                {
                    id: "backend/model",
                    name: "backend/model",
                    tooltip: "t",
                    isUserSelectable: true,
                },
            ],
        } as unknown as LiteLLMChatProvider;

        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");
        const quickPickStub = sandbox.stub(vscode.window, "showQuickPick");
        quickPickStub.resolves({ modelId: "backend/model" } as unknown as vscode.QuickPickItem);

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
        assert.ok(
            String(infoStub.firstCall.args[0]).includes("Copied model id: backend/model"),
            "Information message should announce the copied model id"
        );
    });
});
