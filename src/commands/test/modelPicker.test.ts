import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { showModelPicker } from "../modelPicker";
import { LiteLLMProviderBase } from "../../providers/liteLLMProviderBase";

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
            { id: "model-1", name: "Model 1" },
            { id: "model-2", name: "Model 2" },
        ];
        mockProvider.discoverModels.resolves(mockModels as unknown as vscode.LanguageModelChatInformation[]);

        const quickPickStub = sandbox
            .stub(vscode.window, "showQuickPick")
            .resolves({ label: "model-1" } as unknown as vscode.QuickPickItem);
        const configUpdateStub = sandbox.stub();
        sandbox.stub(vscode.workspace, "getConfiguration").returns({
            get: sandbox.stub().returns(undefined),
            update: configUpdateStub,
        } as unknown as vscode.WorkspaceConfiguration);

        const onSelectSpy = sandbox.spy();

        await showModelPicker(mockProvider as unknown as LiteLLMProviderBase, {
            title: "Test Picker",
            settingKey: "testKey",
            onSelect: onSelectSpy,
        });

        assert.strictEqual(quickPickStub.calledOnce, true);
        assert.strictEqual(configUpdateStub.calledWith("testKey", "model-1", vscode.ConfigurationTarget.Global), true);
        assert.strictEqual(onSelectSpy.calledWith("model-1"), true);
    });

    test("showModelPicker clears configuration on 'Clear Selection'", async () => {
        mockProvider.discoverModels.resolves([{ id: "model-1" }] as unknown as vscode.LanguageModelChatInformation[]);

        sandbox
            .stub(vscode.window, "showQuickPick")
            .resolves({ label: "$(clear-all) Clear Selection" } as unknown as vscode.QuickPickItem);
        const configUpdateStub = sandbox.stub();
        sandbox.stub(vscode.workspace, "getConfiguration").returns({
            get: sandbox.stub().returns("existing-model"),
            update: configUpdateStub,
        } as unknown as vscode.WorkspaceConfiguration);

        const onClearSpy = sandbox.spy();

        await showModelPicker(mockProvider as unknown as LiteLLMProviderBase, {
            title: "Test Picker",
            settingKey: "testKey",
            onClear: onClearSpy,
        });

        assert.strictEqual(configUpdateStub.calledWith("testKey", undefined, vscode.ConfigurationTarget.Global), true);
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
});
