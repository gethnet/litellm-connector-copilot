import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { showModelPicker } from "../modelPicker";
import type { LiteLLMProviderBase } from "../../providers/liteLLMProviderBase";
import type { ConfigManager } from "../../config/configManager";
import type { LiteLLMConfig } from "../../types";

suite("ModelPicker Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;
    let mockProvider: {
        discoverModels: sinon.SinonStub;
        getLastKnownModels: sinon.SinonStub;
        getConfigManager: sinon.SinonStub;
    };

    setup(() => {
        sandbox = sinon.createSandbox();
        mockProvider = {
            // The vendor-level discoverModels call is a no-op on modern
            // per-group configs (it returns [] without options.configuration),
            // so the picker must NOT depend on it. Stubbed so tests can fail
            // if the implementation ever calls it again.
            discoverModels: sandbox.stub(),
            getLastKnownModels: sandbox.stub(),
            getConfigManager: sandbox.stub(),
        };
    });

    teardown(() => {
        sandbox.restore();
    });

    test("showModelPicker sources candidates from display models, not vendor-level discovery", async () => {
        mockProvider.getLastKnownModels.returns([
            { id: "backend.example/azure_ai/gpt-5.6-mini", name: "azure_ai/gpt-5.6-mini", backendName: "Work" },
        ] as unknown as vscode.LanguageModelChatInformation[]);
        mockProvider.getConfigManager.returns({
            getConfig: async () => ({}) as unknown as LiteLLMConfig,
        } as unknown as ConfigManager);

        const quickPickStub = sandbox.stub(vscode.window, "showQuickPick").resolves(undefined);

        await showModelPicker(mockProvider as unknown as LiteLLMProviderBase, {
            title: "Test Picker",
            settingKey: "testKey",
        });

        sinon.assert.notCalled(mockProvider.discoverModels);
        sinon.assert.calledOnce(mockProvider.getLastKnownModels);
        assert.strictEqual(quickPickStub.calledOnce, true);
        const items = quickPickStub.firstCall.args[0] as (vscode.QuickPickItem & { modelId?: string })[];
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].label, "Work :: azure_ai/gpt-5.6-mini");
        // The fully qualified id (vendor-prefixed) is the selectable payload.
        assert.strictEqual(items[0].modelId, "litellm-connector/backend.example/azure_ai/gpt-5.6-mini");
    });

    test("showModelPicker copies the selected fully qualified id to the clipboard", async () => {
        mockProvider.getLastKnownModels.returns([
            { id: "backend.example/azure_ai/gpt-5.6-mini", name: "azure_ai/gpt-5.6-mini", backendName: "Work" },
        ] as unknown as vscode.LanguageModelChatInformation[]);
        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ testKey: undefined }) as unknown as LiteLLMConfig,
        } as unknown as ConfigManager);

        sandbox.stub(vscode.window, "showQuickPick").resolves({
            id: "backend.example/azure_ai/gpt-5.6-mini",
            modelId: "litellm-connector/backend.example/azure_ai/gpt-5.6-mini",
        } as unknown as vscode.QuickPickItem);
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");
        // vscode.env.clipboard.writeText is non-configurable in the test host;
        // assert via the announcement message, same approach as the showModels tests.
        const configUpdateStub = sandbox.stub();
        sandbox.stub(vscode.workspace, "getConfiguration").callsFake(
            () =>
                ({
                    get: sandbox.stub().returns(undefined),
                    update: configUpdateStub,
                }) as unknown as vscode.WorkspaceConfiguration
        );

        await showModelPicker(mockProvider as unknown as LiteLLMProviderBase, {
            title: "Test Picker",
            settingKey: "testKey",
        });

        assert.ok(
            String(infoStub.firstCall.args[0]).includes(
                "Copied fully qualified model id: litellm-connector/backend.example/azure_ai/gpt-5.6-mini"
            ),
            "selection must announce the copied fully qualified id"
        );
    });

    test("showModelPicker updates configuration on selection", async () => {
        const mockModels = [
            { id: "model-1", name: "model-1", backendName: "LiteLLM" },
            { id: "model-2", name: "model-2", backendName: "cloud" },
        ];
        mockProvider.getLastKnownModels.returns(mockModels as unknown as vscode.LanguageModelChatInformation[]);
        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ testKey: undefined }) as unknown as LiteLLMConfig,
        } as unknown as ConfigManager);

        const quickPickStub = sandbox.stub(vscode.window, "showQuickPick").resolves({
            id: "model-1",
            modelId: "litellm-connector/model-1",
        } as unknown as vscode.QuickPickItem);
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
        assert.strictEqual(quickPickItems[0].label, "LiteLLM :: model-1");
        assert.strictEqual(quickPickItems[1].label, "cloud :: model-2");
        // Description carries the fully qualified id (the clipboard payload).
        assert.strictEqual(quickPickItems[0].description, "litellm-connector/model-1");
        assert.strictEqual(configUpdateStub.calledOnce, true);
        assert.strictEqual(configUpdateStub.firstCall.args[0], "testKey");
        // The setting keeps storing the namespaced registry id (vendor prefix
        // is stripped by ConfigManager.normalizeModelId on read).
        assert.strictEqual(configUpdateStub.firstCall.args[1], "model-1");
        assert.strictEqual(configUpdateStub.firstCall.args[2], vscode.ConfigurationTarget.Global);
        assert.strictEqual(onSelectSpy.calledWith("model-1"), true);
    });

    test("showModelPicker resolves selection when label includes vendor prefix", async () => {
        const mockModels = [{ id: "backend::gpt-4", name: "gpt-4", vendor: "openai", backendName: "primary" }];
        mockProvider.getLastKnownModels.returns(mockModels as unknown as vscode.LanguageModelChatInformation[]);
        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ testKey: undefined }) as unknown as LiteLLMConfig,
        } as unknown as ConfigManager);

        const configUpdateStub = sandbox.stub();
        sandbox.stub(vscode.workspace, "getConfiguration").callsFake(
            () =>
                ({
                    get: sandbox.stub().returns(undefined),
                    update: configUpdateStub,
                }) as unknown as vscode.WorkspaceConfiguration
        );

        const quickPickStub = sandbox
            .stub(vscode.window, "showQuickPick")
            .callsFake(async (items: readonly vscode.QuickPickItem[] | Thenable<readonly vscode.QuickPickItem[]>) => {
                const resolved = await items;
                return resolved[0];
            });

        await showModelPicker(mockProvider as unknown as LiteLLMProviderBase, {
            title: "Test Picker",
            settingKey: "testKey",
        });

        const quickPickItems = quickPickStub.firstCall.args[0] as vscode.QuickPickItem[];
        assert.strictEqual(quickPickItems[0].label, "primary :: gpt-4");
        assert.strictEqual(configUpdateStub.calledOnce, true);
        assert.strictEqual(configUpdateStub.firstCall.args[1], "backend::gpt-4");
    });

    test("showModelPicker clears configuration on 'Clear Selection'", async () => {
        mockProvider.getLastKnownModels.returns([
            { id: "model-1" },
        ] as unknown as vscode.LanguageModelChatInformation[]);
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
        mockProvider.getLastKnownModels.returns([
            { id: "model-1" },
        ] as unknown as vscode.LanguageModelChatInformation[]);
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
        mockProvider.getLastKnownModels.returns([
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
        mockProvider.getLastKnownModels.throws(new Error("fail"));
        const errorStub = sandbox.stub(vscode.window, "showErrorMessage");

        await showModelPicker(mockProvider as unknown as LiteLLMProviderBase, { title: "T", settingKey: "k" });
        assert.ok(errorStub.calledWith(sinon.match("Failed to load models")));
    });

    test("showModelPicker guides to Reload Models when the display list is empty", async () => {
        // Empty display models means no provider group has resolved yet (fresh
        // window) or the registry was just wiped. The old warning blamed the
        // user's connection, which was misleading — the vendor-level discovery
        // call could never return models on modern configs.
        mockProvider.getLastKnownModels.returns([]);
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");

        await showModelPicker(mockProvider as unknown as LiteLLMProviderBase, { title: "T", settingKey: "k" });

        assert.strictEqual(infoStub.calledOnce, true);
        assert.ok(String(infoStub.firstCall.args[0]).includes("'LiteLLM: Reload Models'"));
    });
});
