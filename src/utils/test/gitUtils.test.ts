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

        test("compactDiff removes context lines if too large", () => {
            const diff =
                "diff --git a/file.txt b/file.txt\n" +
                "index 123..456 100644\n" +
                "--- a/file.txt\n" +
                "+++ b/file.txt\n" +
                "@@ -1,5 +1,5 @@\n" +
                " context 1\n" +
                " context 2\n" +
                "-old line\n" +
                "+new line\n" +
                " context 3\n" +
                " context 4";

            // Use 20 tokens (80 chars) to allow headers + changes but still force context removal
            const result = GitUtils.compactDiff(diff, 20);
            assert.ok(!result.includes("context 1"));
            assert.ok(result.includes("-old line"));
            assert.ok(result.includes("+new line"));
        });
    });
});

suite("GitUtils — multi-repo support", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("findRepositoryByRootUri returns matching repo by rootUri", () => {
        const repoA = { rootUri: vscode.Uri.file("/workspace/repo-a"), inputBox: { value: "" } };
        const repoB = { rootUri: vscode.Uri.file("/workspace/repo-b"), inputBox: { value: "" } };
        const api = { repositories: [repoA, repoB] } as unknown as GitAPI;

        const result = GitUtils.findRepositoryByRootUri(api, vscode.Uri.file("/workspace/repo-b"));
        assert.strictEqual(result, repoB);
    });

    test("findRepositoryByRootUri returns undefined when no match found", () => {
        const repoA = { rootUri: vscode.Uri.file("/workspace/repo-a"), inputBox: { value: "" } };
        const api = { repositories: [repoA] } as unknown as GitAPI;

        const result = GitUtils.findRepositoryByRootUri(api, vscode.Uri.file("/workspace/other"));
        assert.strictEqual(result, undefined);
    });

    test("findRepositoryByRootUri returns undefined for empty repositories", () => {
        const api = { repositories: [] } as unknown as GitAPI;
        const result = GitUtils.findRepositoryByRootUri(api, vscode.Uri.file("/workspace/repo-a"));
        assert.strictEqual(result, undefined);
    });

    test("getStagedDiff uses correct repository when rootUri is provided", async () => {
        const repoA = {
            rootUri: vscode.Uri.file("/workspace/repo-a"),
            state: { indexChanges: [] },
            diffIndexWithHEAD: async () => [],
            diff: async () => "diff-a",
        };
        const repoB = {
            rootUri: vscode.Uri.file("/workspace/repo-b"),
            state: { indexChanges: [{ uri: vscode.Uri.file("/workspace/repo-b/file.ts"), status: 1 }] },
            diffIndexWithHEAD: async () => [{ uri: vscode.Uri.file("/workspace/repo-b/file.ts"), status: 1 }],
            diff: async () => "diff-b-content",
        };

        const mockApi = { repositories: [repoA, repoB] } as unknown as GitAPI;
        sandbox.stub(GitUtils, "getGitAPI").resolves(mockApi);

        const result = await GitUtils.getStagedDiff(vscode.Uri.file("/workspace/repo-b"));
        // Should NOT get repoA's diff, even though repoA is first
        assert.notStrictEqual(result, "diff-a");
    });

    test("getStagedDiff falls back to first repo when no rootUri provided (backward compat)", async () => {
        const repoA = {
            rootUri: vscode.Uri.file("/workspace/repo-a"),
            state: { indexChanges: [{ uri: vscode.Uri.file("/workspace/repo-a/file.ts"), status: 1 }] },
            diffIndexWithHEAD: async () => [{ uri: vscode.Uri.file("/workspace/repo-a/file.ts"), status: 1 }],
            diff: async () => "diff-a",
        };
        const mockApi = { repositories: [repoA] } as unknown as GitAPI;
        sandbox.stub(GitUtils, "getGitAPI").resolves(mockApi);

        const result = await GitUtils.getStagedDiff();
        // Fallback: uses first repo
        assert.ok(result?.includes("diff-a"));
    });
});
