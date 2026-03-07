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

    test("truncateToTokenLimit returns full text if within limits", () => {
        const text = "small diff";
        const maxTokens = 100;
        const result = GitUtils.truncateToTokenLimit(text, maxTokens);
        assert.strictEqual(result, text);
    });

    test("truncateToTokenLimit truncates text if exceeds limits", () => {
        // Create a diff that is roughly 200 tokens (800 characters)
        const text = "a".repeat(800);
        const maxTokens = 100;
        const result = GitUtils.truncateToTokenLimit(text, maxTokens);

        assert.strictEqual(result.includes("[... Content truncated due to context limits ...]"), true);
        // Truncated chars = 100 * 4 = 400
        assert.strictEqual(result.length <= 400 + "[... Content truncated due to context limits ...]".length + 2, true);
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

    suite("compactDiff", () => {
        test("returns original diff if already small", () => {
            const diff = "--- a/file.ts\n+++ b/file.ts\n@@ -1,1 +1,1 @@\n-old\n+new";
            const result = GitUtils.compactDiff(diff, 100);
            assert.strictEqual(result, diff);
        });

        test("removes context lines to save space", () => {
            const diff = [
                "--- a/file.ts",
                "+++ b/file.ts",
                "@@ -1,10 +1,10 @@",
                " context1",
                " context2",
                "-old",
                "+new",
                " context3",
                " context4",
            ].join("\n");

            // Total length is roughly 100 chars. 50 tokens = 200 chars limit.
            // But we need the input diff to be LARGER than maxChars to trigger compacting.
            //const result = GitUtils.compactDiff(diff, 5); // 20 chars limit

            // Should contain changes, but may be truncated if 20 chars is too small
            // Let's use a more realistic limit for the test
            const result2 = GitUtils.compactDiff(diff, 15); // 60 chars limit
            assert.ok(result2.includes("-old"), `Should include removed line. Result: ${result2}`);
            assert.ok(result2.includes("+new"), `Should include added line. Result: ${result2}`);
            assert.ok(!result2.includes("context1"), "Should NOT include context1");
            assert.ok(!result2.includes("context3"), "Should NOT include context3");
        });

        test("prioritizes hunk headers and changes over context", () => {
            const largeDiff = [
                "--- a/file.ts",
                "+++ b/file.ts",
                "@@ -1,100 +1,100 @@",
                ...Array(50).fill(" context"),
                "-deleted line",
                "+added line",
                ...Array(50).fill(" context"),
            ].join("\n");

            const result = GitUtils.compactDiff(largeDiff, 20);
            assert.ok(result.length < largeDiff.length);
            assert.ok(result.includes("-deleted line"));
            assert.ok(result.includes("+added line"));
        });
    });
});
