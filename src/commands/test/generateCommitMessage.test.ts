import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { registerGenerateCommitMessageCommand } from "../generateCommitMessage";
import { LiteLLMCommitMessageProvider } from "../../providers/liteLLMCommitProvider";
import { GitUtils } from "../../utils/gitUtils";
import type { ConfigManager } from "../../config/configManager";
import type { LiteLLMModelInfo, LiteLLMConfig } from "../../types";

suite("GenerateCommitMessage Command Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;
    let mockProvider: sinon.SinonStubbedInstance<LiteLLMCommitMessageProvider>;

    setup(() => {
        sandbox = sinon.createSandbox();
        mockProvider = sandbox.createStubInstance(LiteLLMCommitMessageProvider);
        sandbox.stub(vscode.lm, "selectChatModels").resolves([]);
    });

    teardown(() => {
        sandbox.restore();
    });

    test("registerGenerateCommitMessageCommand registers the command", () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        registerGenerateCommitMessageCommand(mockProvider as unknown as LiteLLMCommitMessageProvider);
        assert.strictEqual(registerStub.calledWith("litellm-connector.generateCommitMessage"), true);
    });

    test("handler prompts for model if not configured", async () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        registerGenerateCommitMessageCommand(mockProvider as unknown as LiteLLMCommitMessageProvider);
        const handler = registerStub.firstCall.args[1] as () => Promise<void>;

        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: undefined }),
        } as unknown as ConfigManager);

        const infoMsgStub = sandbox.stub(vscode.window, "showInformationMessage").resolves(undefined);

        await handler();

        assert.strictEqual(infoMsgStub.calledOnce, true);
        assert.strictEqual(infoMsgStub.firstCall.args[0].includes("No model configured"), true);
    });

    test("handler generates commit message and updates input box", async () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        registerGenerateCommitMessageCommand(mockProvider as unknown as LiteLLMCommitMessageProvider);
        const handler = registerStub.firstCall.args[1] as () => Promise<void>;

        // Mock configuration
        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "test-model" }),
        } as unknown as ConfigManager);

        // Mock GitUtils
        sandbox.stub(GitUtils, "getStagedDiff").resolves("test-diff");
        const mockInputBox = { value: "", placeholder: "", enabled: true };
        const mockRepo = { inputBox: mockInputBox };
        sandbox.stub(GitUtils, "getGitAPI").resolves({ repositories: [mockRepo] } as unknown as never);

        // Mock Provider methods
        mockProvider.getModelInfo.returns({ max_input_tokens: 1000 } as unknown as LiteLLMModelInfo);
        // The handler now goes through `vscode.lm.selectChatModels` exclusively. Provide a
        // mock chat model that streams the expected commit message so the input box is
        // updated via the VS Code route.
        const model = {
            sendRequest: sandbox.stub().resolves({
                stream: (async function* () {
                    yield new vscode.LanguageModelTextPart("feat: ");
                    yield new vscode.LanguageModelTextPart("test");
                })(),
            }),
        };
        const selectModelsStub = vscode.lm.selectChatModels as unknown as sinon.SinonStub;
        selectModelsStub.resolves([model as unknown as vscode.LanguageModelChat]);

        // Mock Progress
        sandbox.stub(vscode.window, "withProgress").callsFake(async (_options, task) => {
            return await task(
                { report: sandbox.stub() } as vscode.Progress<{ message?: string; increment?: number }>,
                new vscode.CancellationTokenSource().token
            );
        });

        await handler();

        assert.strictEqual(mockInputBox.value, "feat: test");
        assert.strictEqual(mockInputBox.enabled, true);
    });

    test("handler prefers VS Code model request route when model is available", async () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        registerGenerateCommitMessageCommand(mockProvider as unknown as LiteLLMCommitMessageProvider);
        const handler = registerStub.firstCall.args[1] as () => Promise<void>;

        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "test-model" }),
        } as unknown as ConfigManager);

        sandbox.stub(GitUtils, "getStagedDiff").resolves("test-diff");
        const mockInputBox = { value: "", placeholder: "", enabled: true };
        const mockRepo = { inputBox: mockInputBox };
        sandbox.stub(GitUtils, "getGitAPI").resolves({ repositories: [mockRepo] } as unknown as never);
        mockProvider.getModelInfo.returns({ max_input_tokens: 1000 } as unknown as LiteLLMModelInfo);

        const model = {
            sendRequest: sandbox.stub().resolves({
                stream: (async function* () {
                    yield new vscode.LanguageModelTextPart("feat: ");
                    yield new vscode.LanguageModelTextPart("from vscode route");
                })(),
            }),
        };
        const selectModelsStub = vscode.lm.selectChatModels as unknown as sinon.SinonStub;
        selectModelsStub.resolves([model as unknown as vscode.LanguageModelChat]);

        sandbox.stub(vscode.window, "withProgress").callsFake(async (_options, task) => {
            return await task(
                { report: sandbox.stub() } as vscode.Progress<{ message?: string; increment?: number }>,
                new vscode.CancellationTokenSource().token
            );
        });

        await handler();

        assert.strictEqual(mockInputBox.value, "feat: from vscode route");
        assert.strictEqual(mockProvider.provideCommitMessage.called, false);
        assert.strictEqual((model.sendRequest as sinon.SinonStub).calledOnce, true);
    });

    test("shows error and does not fall back to provider when VS Code route fails", async () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        registerGenerateCommitMessageCommand(mockProvider as unknown as LiteLLMCommitMessageProvider);
        const handler = registerStub.firstCall.args[1] as () => Promise<void>;

        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "test-model" }),
        } as unknown as ConfigManager);

        sandbox.stub(GitUtils, "getStagedDiff").resolves("test-diff");
        const mockInputBox = { value: "", placeholder: "", enabled: true };
        const mockRepo = { inputBox: mockInputBox };
        sandbox.stub(GitUtils, "getGitAPI").resolves({ repositories: [mockRepo] } as unknown as never);
        mockProvider.getModelInfo.returns({ max_input_tokens: 1000 } as unknown as LiteLLMModelInfo);

        const selectModelsStub = vscode.lm.selectChatModels as unknown as sinon.SinonStub;
        selectModelsStub.rejects(new Error("vscode route failed"));

        const errorStub = sandbox.stub(vscode.window, "showErrorMessage");
        sandbox.stub(vscode.window, "withProgress").callsFake(async (_options, task) => {
            return await task(
                { report: sandbox.stub() } as vscode.Progress<{ message?: string; increment?: number }>,
                new vscode.CancellationTokenSource().token
            );
        });

        await handler();

        assert.ok(errorStub.called);
        assert.ok(mockProvider.provideCommitMessage.notCalled);
    });

    test("handler reports error if diff retrieval fails", async () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        registerGenerateCommitMessageCommand(mockProvider as unknown as LiteLLMCommitMessageProvider);
        const handler = registerStub.firstCall.args[1] as () => Promise<void>;

        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "test-model" }),
        } as unknown as ConfigManager);

        sandbox.stub(GitUtils, "getStagedDiff").resolves(undefined);
        const errorMsgStub = sandbox.stub(vscode.window, "showErrorMessage");

        await handler();

        assert.strictEqual(errorMsgStub.calledOnce, true);
        assert.strictEqual(errorMsgStub.firstCall.args[0].includes("No staged changes found"), true);
    });

    test("handler shows warning when diff is truncated", async () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        registerGenerateCommitMessageCommand(mockProvider as unknown as LiteLLMCommitMessageProvider);
        const handler = registerStub.firstCall.args[1] as () => Promise<void>;

        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "test-model" }),
        } as unknown as ConfigManager);

        sandbox.stub(GitUtils, "getStagedDiff").resolves("a".repeat(10000));
        mockProvider.getModelInfo.returns({ max_input_tokens: 100 } as unknown as LiteLLMModelInfo);

        const warnStub = sandbox.stub(vscode.window, "showWarningMessage");
        sandbox.stub(vscode.window, "withProgress").resolves();
        sandbox
            .stub(GitUtils, "getGitAPI")
            .resolves({ repositories: [{ inputBox: { value: "" } }] } as unknown as never);

        await handler();

        assert.ok(warnStub.calledWith(sinon.match("truncated")));
    });

    test("handler handles empty diff correctly", async () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        registerGenerateCommitMessageCommand(mockProvider as unknown as LiteLLMCommitMessageProvider);
        const handler = registerStub.firstCall.args[1] as () => Promise<void>;

        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "m" }),
        } as unknown as ConfigManager);

        sandbox.stub(GitUtils, "getStagedDiff").resolves("");
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");

        await handler();

        assert.ok(infoStub.calledWith("No staged changes found."));
    });

    test("handler reports error on provider failure", async () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        registerGenerateCommitMessageCommand(mockProvider as unknown as LiteLLMCommitMessageProvider);
        const handler = registerStub.firstCall.args[1] as () => Promise<void>;

        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "m" }),
        } as unknown as ConfigManager);

        sandbox.stub(GitUtils, "getStagedDiff").resolves("diff");
        mockProvider.getModelInfo.returns({ max_input_tokens: 1000 } as unknown as LiteLLMModelInfo);
        // The handler now exclusively uses the VS Code `selectChatModels` route. Reject
        // `sendRequest` to simulate an upstream provider failure and assert the user sees
        // an error message.
        const model = {
            sendRequest: sandbox.stub().rejects(new Error("provider fail")),
        };
        const selectModelsStub = vscode.lm.selectChatModels as unknown as sinon.SinonStub;
        selectModelsStub.resolves([model as unknown as vscode.LanguageModelChat]);

        const errorStub = sandbox.stub(vscode.window, "showErrorMessage");
        sandbox.stub(vscode.window, "withProgress").callsFake(async (_o, task) => {
            return await task(
                { report: sandbox.stub() } as vscode.Progress<{ message?: string; increment?: number }>,
                new vscode.CancellationTokenSource().token
            );
        });
        sandbox
            .stub(GitUtils, "getGitAPI")
            .resolves({ repositories: [{ inputBox: { value: "" } }] } as unknown as never);

        await handler();

        assert.ok(errorStub.calledWith(sinon.match("provider fail")));
    });

    test("handler handles missing git API or repositories", async () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        registerGenerateCommitMessageCommand(mockProvider as unknown as LiteLLMCommitMessageProvider);
        const handler = registerStub.firstCall.args[1] as () => Promise<void>;

        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "m" }) as unknown as LiteLLMConfig,
        } as unknown as ConfigManager);

        sandbox.stub(GitUtils, "getStagedDiff").resolves("diff");
        sandbox.stub(GitUtils, "getGitAPI").resolves(undefined);

        await handler();
        // Should return early
    });

    test("handler handles missing SCM input box", async () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        registerGenerateCommitMessageCommand(mockProvider as unknown as LiteLLMCommitMessageProvider);
        const handler = registerStub.firstCall.args[1] as () => Promise<void>;

        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "m" }) as unknown as LiteLLMConfig,
        } as unknown as ConfigManager);

        sandbox.stub(GitUtils, "getStagedDiff").resolves("diff");
        sandbox.stub(GitUtils, "getGitAPI").resolves({ repositories: [{}] } as unknown as never);

        await handler();
        // Should return early
    });

    test("handler uses diff from correct repository when multiple repos are open", async () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        registerGenerateCommitMessageCommand(mockProvider as unknown as LiteLLMCommitMessageProvider);
        const handler = registerStub.firstCall.args[1] as (scm: unknown) => Promise<void>;

        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "test-model" }),
        } as unknown as ConfigManager);

        const repoAInput = { value: "", placeholder: "", enabled: true };
        const repoBInput = { value: "", placeholder: "", enabled: true };
        const repoA = {
            rootUri: vscode.Uri.file("/workspace/repo-a"),
            inputBox: repoAInput,
            state: { indexChanges: [] },
            diffIndexWithHEAD: async () => [],
            diff: async () => "diff-a",
        };
        const repoB = {
            rootUri: vscode.Uri.file("/workspace/repo-b"),
            inputBox: repoBInput,
            state: { indexChanges: [{ uri: vscode.Uri.file("/workspace/repo-b/file.ts"), status: 1 }] },
            diffIndexWithHEAD: async () => [{ uri: vscode.Uri.file("/workspace/repo-b/file.ts"), status: 1 }],
            diff: async () => "diff-b-content",
        };

        const mockApi = { repositories: [repoA, repoB] } as unknown as never;
        sandbox.stub(GitUtils, "getGitAPI").resolves(mockApi);
        // getStagedDiff is called with rootUri now — stub to verify it receives the right URI
        const getDiffStub = sandbox.stub(GitUtils, "getStagedDiff").resolves("diff-b-content");

        mockProvider.getModelInfo.returns({ max_input_tokens: 1000 } as unknown as LiteLLMModelInfo);
        // The handler now uses VS Code's `selectChatModels` route. Stream the commit message
        // through the mock model so the input box is updated.
        const model = {
            sendRequest: sandbox.stub().resolves({
                stream: (async function* () {
                    yield new vscode.LanguageModelTextPart("fix: update file");
                })(),
            }),
        };
        const selectModelsStub = vscode.lm.selectChatModels as unknown as sinon.SinonStub;
        selectModelsStub.resolves([model as unknown as vscode.LanguageModelChat]);

        sandbox.stub(vscode.window, "withProgress").callsFake(async (_options, task) => {
            return await task(
                { report: sandbox.stub() } as vscode.Progress<{ message?: string; increment?: number }>,
                new vscode.CancellationTokenSource().token
            );
        });

        // Simulate invoking from repo-b's SCM context
        const scmContext = { rootUri: vscode.Uri.file("/workspace/repo-b") };
        await handler(scmContext);

        // Verify getStagedDiff was called with repo-b's rootUri
        // Using getCall(0).args[0] for more robust verification
        assert.strictEqual(getDiffStub.getCall(0).args[0]?.fsPath, vscode.Uri.file("/workspace/repo-b").fsPath);
        // Verify the commit message was written to repo-b's input box, not repo-a's
        assert.strictEqual(repoBInput.value, "fix: update file");
        assert.strictEqual(repoAInput.value, "");
    });

    test("handler falls back to first repo when scm has no rootUri", async () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        registerGenerateCommitMessageCommand(mockProvider as unknown as LiteLLMCommitMessageProvider);
        const handler = registerStub.firstCall.args[1] as (scm: unknown) => Promise<void>;

        mockProvider.getConfigManager.returns({
            getConfig: async () => ({ commitModelIdOverride: "test-model" }),
        } as unknown as ConfigManager);

        const repoAInput = { value: "", placeholder: "", enabled: true };
        const repoA = {
            rootUri: vscode.Uri.file("/workspace/repo-a"),
            inputBox: repoAInput,
            state: { indexChanges: [] },
            diffIndexWithHEAD: async () => [],
            diff: async () => "diff-a",
        };

        const mockApi = { repositories: [repoA] } as unknown as never;
        sandbox.stub(GitUtils, "getGitAPI").resolves(mockApi);
        const getDiffStub = sandbox.stub(GitUtils, "getStagedDiff").resolves("diff-a");

        mockProvider.getModelInfo.returns({ max_input_tokens: 1000 } as unknown as LiteLLMModelInfo);
        // The handler uses VS Code's `selectChatModels` route. Stream the commit message
        // through the mock model so the input box is updated.
        const model = {
            sendRequest: sandbox.stub().resolves({
                stream: (async function* () {
                    yield new vscode.LanguageModelTextPart("chore: update");
                })(),
            }),
        };
        const selectModelsStub = vscode.lm.selectChatModels as unknown as sinon.SinonStub;
        selectModelsStub.resolves([model as unknown as vscode.LanguageModelChat]);

        sandbox.stub(vscode.window, "withProgress").callsFake(async (_options, task) => {
            return await task(
                { report: sandbox.stub() } as vscode.Progress<{ message?: string; increment?: number }>,
                new vscode.CancellationTokenSource().token
            );
        });

        // Simulate invoking with no scm context (undefined)
        await handler(undefined);

        // getStagedDiff called without rootUri (backward compat)
        assert.ok(getDiffStub.calledWith(undefined));
        assert.strictEqual(repoAInput.value, "chore: update");
    });
});
