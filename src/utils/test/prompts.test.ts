import * as assert from "assert";
import { resolvePrompt } from "../prompts";

suite("resolvePrompt Unit Tests", () => {
    test("returns fallback when override is undefined", () => {
        assert.strictEqual(resolvePrompt(undefined, "fallback text"), "fallback text");
    });

    test("returns fallback when override is an empty string", () => {
        assert.strictEqual(resolvePrompt("", "fallback text"), "fallback text");
    });

    test("returns fallback when override is whitespace-only", () => {
        assert.strictEqual(resolvePrompt("   \n\t  ", "fallback text"), "fallback text");
    });

    test("returns the trimmed override when non-empty", () => {
        assert.strictEqual(resolvePrompt("  custom prompt  ", "fallback text"), "custom prompt");
    });

    test("preserves internal newlines in a multiline override", () => {
        const override = "line one\nline two\nline three";
        assert.strictEqual(resolvePrompt(override, "fallback text"), override);
    });
});
