import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { registerGenerateCommitMessageCommand } from "../generateCommitMessage";
import { LiteLLMCommitMessageProvider } from "../../providers/liteLLMCommitProvider";
import { GitUtils } from "../../utils/gitUtils";
import type { ConfigManager } from "../../config/configManager";
import type { LiteLLMModelInfo } from "../../types";

suite("GenerateCommitMessage Command Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;
    let mockProvider: sinon.SinonStubbedInstance<LiteLLMCommitMessageProvider>;

    setup(() => {
        sandbox = sinon.createSandbox();
        mockProvider = sandbox.createStubInstance(LiteLLMCommitMessageProvider);
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
        mockProvider.provideCommitMessage.callsFake(async (_diff, _options, _token, onProgress) => {
            if (onProgress) {
                onProgress("feat: ");
                onProgress("test");
            }
            return "feat: test";
        });

        // Mock Progress
        sandbox.stub(vscode.window, "withProgress").callsFake(async (_options, task) => {
            return await task(
                { report: () => {} } as vscode.Progress<{ message?: string; increment?: number }>,
                new vscode.CancellationTokenSource().token
            );
        });

        await handler();

        assert.strictEqual(mockInputBox.value, "feat: test");
        assert.strictEqual(mockInputBox.enabled, true);
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
        mockProvider.provideCommitMessage.rejects(new Error("provider fail"));

        const errorStub = sandbox.stub(vscode.window, "showErrorMessage");
        sandbox.stub(vscode.window, "withProgress").callsFake(async (_o, task) => {
            return await task(
                { report: () => {} } as vscode.Progress<{ message?: string; increment?: number }>,
                new vscode.CancellationTokenSource().token
            );
        });
        sandbox
            .stub(GitUtils, "getGitAPI")
            .resolves({ repositories: [{ inputBox: { value: "" } }] } as unknown as never);

        await handler();

        assert.ok(errorStub.calledWith(sinon.match("provider fail")));
    });
});
