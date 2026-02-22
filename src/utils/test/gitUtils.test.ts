import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { GitUtils } from "../gitUtils";
import type { GitAPI } from "../gitUtils";

suite("GitUtils Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("checkDiffSize returns full diff if within limits", () => {
        const diff = "small diff";
        const maxTokens = 100;
        const result = GitUtils.checkDiffSize(diff, maxTokens);
        assert.strictEqual(result.diff, diff);
        assert.strictEqual(result.isTruncated, false);
    });

    test("checkDiffSize truncates diff if exceeds limits", () => {
        // Create a diff that is roughly 200 tokens (800 characters)
        const diff = "a".repeat(800);
        const maxTokens = 100;
        const result = GitUtils.checkDiffSize(diff, maxTokens);

        assert.strictEqual(result.isTruncated, true);
        assert.strictEqual(result.diff.includes("[... Diff truncated due to context limits ...]"), true);
        // Truncated chars = 100 * 4 * 0.9 = 360
        assert.strictEqual(
            result.diff.length <= 360 + "[... Diff truncated due to context limits ...]".length + 2,
            true
        );
    });

    test("getGitAPI returns undefined if extension missing", async () => {
        sandbox.stub(vscode.extensions, "getExtension").returns(undefined);
        const api = await GitUtils.getGitAPI();
        assert.strictEqual(api, undefined);
    });

    test("getStagedDiff returns undefined if API missing", async () => {
        sandbox.stub(GitUtils, "getGitAPI").resolves(undefined);
        const diff = await GitUtils.getStagedDiff();
        assert.strictEqual(diff, undefined);
    });

    test("getStagedDiff returns full diff from internal repository", async () => {
        const mockRepo = {
            repository: {
                diff: sandbox.stub().resolves("full-diff"),
            },
        };
        sandbox.stub(GitUtils, "getGitAPI").resolves({ repositories: [mockRepo] } as unknown as GitAPI);
        const diff = await GitUtils.getStagedDiff();
        assert.strictEqual(diff, "full-diff");
        assert.strictEqual((mockRepo.repository.diff as sinon.SinonStub).calledWith(true), true);
    });

    test("getStagedDiff falls back to manual diff aggregation", async () => {
        const mockRepo = {
            diffIndexWithHEAD: sandbox.stub().resolves([{ uri: { fsPath: "file1" } }, { uri: { fsPath: "file2" } }]),
            diff: sandbox.stub().callsFake(async (path: string) => `diff-${path}`),
        };
        sandbox.stub(GitUtils, "getGitAPI").resolves({ repositories: [mockRepo] } as unknown as GitAPI);
        const diff = await GitUtils.getStagedDiff();
        assert.strictEqual(diff, "diff-file1\ndiff-file2\n");
    });
});
