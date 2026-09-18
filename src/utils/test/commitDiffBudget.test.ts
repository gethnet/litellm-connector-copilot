import * as assert from "assert";
import {
    computeDiffBudget,
    computeOutputReserve,
    countDiffBreadth,
    resolveCommitContextWindow,
    MAX_OUTPUT_RESERVE_TOKENS,
    MIN_OUTPUT_RESERVE_TOKENS,
} from "../commitDiffBudget";
import { countTokens } from "../../adapters/tokenUtils";

function buildDiff(files: number, linesPerFile: number): string {
    const parts: string[] = [];
    for (let f = 0; f < files; f++) {
        parts.push(`diff --git a/src/file${f}.ts b/src/file${f}.ts`);
        parts.push("index 0000000..1111111 100644");
        parts.push(`--- a/src/file${f}.ts`);
        parts.push(`+++ b/src/file${f}.ts`);
        parts.push(`@@ -1,${linesPerFile} +1,${linesPerFile} @@`);
        for (let i = 0; i < linesPerFile; i++) {
            parts.push(`+    const value${i} = computeSomething(${i}, "payload-${f}-${i}");`);
        }
    }
    return parts.join("\n");
}

suite("commitDiffBudget", () => {
    suite("countDiffBreadth", () => {
        test("counts diff headers as files and hunk lines", () => {
            const diff = [
                "diff --git a/a.ts b/a.ts",
                "--- a/a.ts",
                "+++ b/a.ts",
                "@@ -1,2 +1,2 @@",
                "-x",
                "+y",
                "@@ -10,2 +10,2 @@",
                "-p",
                "+q",
                "diff --git a/b.ts b/b.ts",
                "--- a/b.ts",
                "+++ b/b.ts",
                "@@ -1 +1 @@",
                "-m",
                "+n",
            ].join("\n");
            assert.deepStrictEqual(countDiffBreadth(diff), { files: 2, hunks: 3 });
        });

        test("falls back to plus headers when git headers are absent", () => {
            const diff = ["--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-x", "+y"].join("\n");
            assert.deepStrictEqual(countDiffBreadth(diff), { files: 1, hunks: 1 });
        });

        test("does not count added lines that start with plus headers", () => {
            const diff = ["diff --git a/a.ts b/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "++++ not a header"].join("\n");
            assert.deepStrictEqual(countDiffBreadth(diff), { files: 1, hunks: 1 });
        });

        test("returns zeros for an empty diff", () => {
            assert.deepStrictEqual(countDiffBreadth(""), { files: 0, hunks: 0 });
        });
    });

    suite("computeOutputReserve", () => {
        test("computes adaptive reserve within the clamp", () => {
            const reserve = computeOutputReserve({ files: 1, hunks: 1 });
            assert.strictEqual(reserve, 1440);
            assert.ok(reserve >= MIN_OUTPUT_RESERVE_TOKENS && reserve <= MAX_OUTPUT_RESERVE_TOKENS);
        });
        test("clamps adaptive reserve to the floor and ceiling", () => {
            assert.strictEqual(computeOutputReserve({ files: 0, hunks: 0 }), MIN_OUTPUT_RESERVE_TOKENS);
            assert.strictEqual(computeOutputReserve({ files: 50, hunks: 0 }), MAX_OUTPUT_RESERVE_TOKENS);
        });
        test("respects positive overrides within the clamp", () => {
            assert.strictEqual(computeOutputReserve({ files: 50, hunks: 50 }, 3000), 3000);
            assert.strictEqual(computeOutputReserve({ files: 1, hunks: 1 }, 500), MIN_OUTPUT_RESERVE_TOKENS);
            assert.strictEqual(computeOutputReserve({ files: 1, hunks: 1 }, 20000), MAX_OUTPUT_RESERVE_TOKENS);
        });
        test("uses adaptive reserve for invalid overrides and floors fractions", () => {
            assert.strictEqual(computeOutputReserve({ files: 1, hunks: 1 }, 0), 1440);
            assert.strictEqual(computeOutputReserve({ files: 1, hunks: 1 }, -5), 1440);
            assert.strictEqual(computeOutputReserve({ files: 1, hunks: 1 }, Number.NaN), 1440);
            assert.strictEqual(computeOutputReserve({ files: 1, hunks: 1 }, 2500.9), 2500);
        });
    });

    suite("computeDiffBudget", () => {
        test("subtracts reserve and prompt tokens once, then applies the margin", () => {
            const budget = computeDiffBudget({
                maxInputTokens: 8000,
                outputReserve: 1440,
                staticPrompts: ["a".repeat(350)],
                modelId: "test-model",
            });
            assert.strictEqual(budget, 5814);
        });
        test("sums tokens across static prompts", () => {
            const budget = computeDiffBudget({
                maxInputTokens: 8000,
                outputReserve: 1000,
                staticPrompts: ["a".repeat(350), "b".repeat(700)],
                modelId: "test-model",
            });
            assert.strictEqual(budget, 6030);
        });
        test("never returns a negative budget", () => {
            assert.strictEqual(
                computeDiffBudget({
                    maxInputTokens: 100,
                    outputReserve: 8000,
                    staticPrompts: ["a".repeat(350)],
                    modelId: "test-model",
                }),
                0
            );
        });
        test("covers a diff that fits after reserve and prompts", () => {
            const diffTokens = countTokens(buildDiff(1, 10), "test-model");
            const budget = computeDiffBudget({
                maxInputTokens: diffTokens * 2 + 1440 + 100,
                outputReserve: 1440,
                staticPrompts: ["a".repeat(350)],
                modelId: "test-model",
            });
            assert.ok(budget >= diffTokens, `budget ${budget} should cover diff ${diffTokens}`);
        });
    });

    suite("resolveCommitContextWindow", () => {
        test("uses a positive finite VS Code context window", () => {
            assert.strictEqual(resolveCommitContextWindow(8000, "test-model", undefined), 8000);
            assert.strictEqual(resolveCommitContextWindow(8000.7, "test-model", undefined), 8000);
        });
        test("falls back to derived capabilities for unusable reported values", () => {
            assert.strictEqual(resolveCommitContextWindow(undefined, "test-model", undefined), 112000);
            assert.strictEqual(resolveCommitContextWindow(0, "test-model", undefined), 112000);
            assert.strictEqual(resolveCommitContextWindow(-1, "test-model", undefined), 112000);
            assert.strictEqual(resolveCommitContextWindow(Number.NaN, "test-model", undefined), 112000);
        });
        test("honours LiteLLM model info in the fallback", () => {
            assert.strictEqual(
                resolveCommitContextWindow(undefined, "test-model", {
                    max_input_tokens: 32000,
                    max_output_tokens: 4000,
                }),
                28000
            );
        });
    });
});
