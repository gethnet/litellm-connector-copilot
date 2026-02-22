import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { registerGenerateCommitMessageCommand } from "../generateCommitMessage";
import { LiteLLMCommitMessageProvider } from "../../providers/liteLLMCommitProvider";
import { GitUtils } from "../../utils/gitUtils";

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

        sandbox.stub(vscode.workspace, "getConfiguration").returns({
            get: sandbox.stub().withArgs("commitModelIdOverride").returns(undefined),
        } as unknown as vscode.WorkspaceConfiguration);

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
        sandbox.stub(vscode.workspace, "getConfiguration").returns({
            get: sandbox.stub().withArgs("commitModelIdOverride").returns("test-model"),
        } as unknown as vscode.WorkspaceConfiguration);

        // Mock GitUtils
        sandbox.stub(GitUtils, "getStagedDiff").resolves("test-diff");
        const mockInputBox = { value: "", placeholder: "", enabled: true };
        const mockRepo = { inputBox: mockInputBox };
        sandbox
            .stub(GitUtils, "getGitAPI")
            .resolves({ repositories: [mockRepo] } as unknown as { repositories: unknown[] } as unknown as never);

        // Mock Provider methods
        mockProvider.getModelInfo.returns({ max_input_tokens: 1000 } as unknown as {
            max_input_tokens: number;
        } as unknown as never);
        mockProvider.provideCommitMessage.callsFake(async (_diff, _options, _token, onProgress) => {
            if (onProgress) {
                onProgress("feat: ");
                onProgress("test");
            }
            return "feat: test";
        });

        // Mock Progress
        sandbox.stub(vscode.window, "withProgress").callsFake(async (_options, task) => {
            return await task({ report: () => {} }, new vscode.CancellationTokenSource().token);
        });

        await handler();

        assert.strictEqual(mockInputBox.value, "feat: test");
        assert.strictEqual(mockInputBox.enabled, true);
    });

    test("handler reports error if diff retrieval fails", async () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        registerGenerateCommitMessageCommand(mockProvider as unknown as LiteLLMCommitMessageProvider);
        const handler = registerStub.firstCall.args[1] as () => Promise<void>;

        sandbox.stub(vscode.workspace, "getConfiguration").returns({
            get: sandbox.stub().withArgs("commitModelIdOverride").returns("test-model"),
        } as unknown as vscode.WorkspaceConfiguration);

        sandbox.stub(GitUtils, "getStagedDiff").resolves(undefined);
        const errorMsgStub = sandbox.stub(vscode.window, "showErrorMessage");

        await handler();

        assert.strictEqual(errorMsgStub.calledOnce, true);
        assert.strictEqual(errorMsgStub.firstCall.args[0].includes("No staged changes found"), true);
    });
});
