import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { showModelPicker } from "../modelPicker";
import { LiteLLMProviderBase } from "../../providers/liteLLMProviderBase";
import type { ConfigManager } from "../../config/configManager";
import type { LiteLLMConfig } from "../../types";

suite("ModelPicker Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;
    let mockProvider: sinon.SinonStubbedInstance<LiteLLMProviderBase>;

    setup(() => {
        sandbox = sinon.createSandbox();
        // LiteLLMProviderBase is abstract, so we need a concrete mock or stub its methods on a dummy
        mockProvider = sandbox.createStubInstance(LiteLLMProviderBase as unknown as new () => LiteLLMProviderBase);
    });

    teardown(() => {
        sandbox.restore();
    });

    test("showModelPicker reports warning when no models available", async () => {
        mockProvider.discoverModels.resolves([]);
        const warnStub = sandbox.stub(vscode.window, "showWarningMessage");

        await showModelPicker(mockProvider as unknown as LiteLLMProviderBase, {
            title: "Test Picker",
            settingKey: "testKey",
        });

        assert.strictEqual(warnStub.calledOnce, true);
        assert.strictEqual(warnStub.firstCall.args[0].includes("No models available"), true);
    });

    test("showModelPicker updates configuration on selection", async () => {
        const mockModels = [
            { id: "model-1", name: "model-1", backendName: "LiteLLM" },
            { id: "model-2", name: "model-2", backendName: "cloud" },
        ];
        mockProvider.discoverModels.resolves(mockModels as unknown as vscode.LanguageModelChatInformation[]);
        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ testKey: undefined }) as unknown as LiteLLMConfig,
        } as unknown as ConfigManager);

        const quickPickStub = sandbox
            .stub(vscode.window, "showQuickPick")
            .resolves({ label: "model-1" } as unknown as vscode.QuickPickItem);
        const configUpdateStub = sandbox.stub();
        sandbox.stub(vscode.workspace, "getConfiguration").callsFake(
            () =>
                ({
                    get: sandbox.stub().returns(undefined),
                    update: configUpdateStub,
                }) as unknown as vscode.WorkspaceConfiguration
        );

        const onSelectSpy = sandbox.spy();

        await showModelPicker(mockProvider as unknown as LiteLLMProviderBase, {
            title: "Test Picker",
            settingKey: "testKey",
            onSelect: onSelectSpy,
        });

        assert.strictEqual(quickPickStub.calledOnce, true);
        const quickPickItems = quickPickStub.firstCall.args[0] as vscode.QuickPickItem[];
        assert.strictEqual(quickPickItems[0].description, "LiteLLM");
        assert.strictEqual(quickPickItems[1].description, "cloud");
        assert.strictEqual(configUpdateStub.calledOnce, true);
        assert.strictEqual(configUpdateStub.firstCall.args[0], "testKey");
        assert.strictEqual(configUpdateStub.firstCall.args[1], "model-1");
        assert.strictEqual(configUpdateStub.firstCall.args[2], vscode.ConfigurationTarget.Global);
        assert.strictEqual(onSelectSpy.calledWith("model-1"), true);
    });

    test("showModelPicker clears configuration on 'Clear Selection'", async () => {
        mockProvider.discoverModels.resolves([{ id: "model-1" }] as unknown as vscode.LanguageModelChatInformation[]);
        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ testKey: "existing-model" }) as unknown as LiteLLMConfig,
        } as unknown as ConfigManager);

        sandbox
            .stub(vscode.window, "showQuickPick")
            .resolves({ label: "$(clear-all) Clear Selection" } as unknown as vscode.QuickPickItem);
        const configUpdateStub = sandbox.stub();
        sandbox.stub(vscode.workspace, "getConfiguration").callsFake(
            () =>
                ({
                    get: sandbox.stub().returns("existing-model"),
                    update: configUpdateStub,
                }) as unknown as vscode.WorkspaceConfiguration
        );

        const onClearSpy = sandbox.spy();

        await showModelPicker(mockProvider as unknown as LiteLLMProviderBase, {
            title: "Test Picker",
            settingKey: "testKey",
            onClear: onClearSpy,
        });

        assert.strictEqual(configUpdateStub.calledOnce, true);
        assert.strictEqual(configUpdateStub.firstCall.args[0], "testKey");
        assert.strictEqual(configUpdateStub.firstCall.args[1], undefined);
        assert.strictEqual(configUpdateStub.firstCall.args[2], vscode.ConfigurationTarget.Global);
        assert.strictEqual(onClearSpy.calledOnce, true);
    });

    test("showModelPicker does nothing if picker dismissed", async () => {
        mockProvider.discoverModels.resolves([{ id: "model-1" }] as unknown as vscode.LanguageModelChatInformation[]);
        sandbox.stub(vscode.window, "showQuickPick").resolves(undefined);
        const configUpdateStub = sandbox.stub();
        sandbox.stub(vscode.workspace, "getConfiguration").returns({
            get: sandbox.stub().returns(undefined),
            update: configUpdateStub,
        } as unknown as vscode.WorkspaceConfiguration);

        await showModelPicker(mockProvider as unknown as LiteLLMProviderBase, {
            title: "Test Picker",
            settingKey: "testKey",
        });

        assert.strictEqual(configUpdateStub.called, false);
    });

    test("showModelPicker handles unresolved model", async () => {
        mockProvider.discoverModels.resolves([
            { id: "m1", name: "m1" },
        ] as unknown as vscode.LanguageModelChatInformation[]);
        mockProvider.getConfigManager.returns({
            getConfig: async () => ({}) as unknown as LiteLLMConfig,
        } as unknown as ConfigManager);
        sandbox.stub(vscode.window, "showQuickPick").resolves({ label: "unknown" } as unknown as vscode.QuickPickItem);
        const errorStub = sandbox.stub(vscode.window, "showErrorMessage");

        await showModelPicker(mockProvider as unknown as LiteLLMProviderBase, { title: "T", settingKey: "k" });
        assert.ok(errorStub.calledWith(sinon.match("could not be resolved")));
    });

    test("showModelPicker handles errors gracefully", async () => {
        mockProvider.discoverModels.rejects(new Error("fail"));
        const errorStub = sandbox.stub(vscode.window, "showErrorMessage");

        await showModelPicker(mockProvider as unknown as LiteLLMProviderBase, { title: "T", settingKey: "k" });
        assert.ok(errorStub.calledWith(sinon.match("Failed to load models")));
    });
});
