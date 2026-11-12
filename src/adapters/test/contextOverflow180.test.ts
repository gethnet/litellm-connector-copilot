import * as assert from "assert";
import { isContextOverflowError } from "../tokenUtils";

suite("Context overflow signatures (#180)", () => {
    for (const message of [
        "prompt is too long: 1115674 tokens > 1000000 maximum",
        "LiteLLM BadRequestError: Azure_aiException: prompt is too long",
        "input is too long",
        "prompt too long",
        "tokens exceed the maximum input capacity",
        "too many tokens in the request",
        "Context window exceeded",
        "litellm.ContextWindowExceededError",
        "maximum context length is 1000",
        "context length exceeded",
        "Message exceeds token limit.",
    ]) {
        test(`recognizes input overflow: ${message}`, () => {
            assert.strictEqual(isContextOverflowError(new Error(message)), true);
            assert.strictEqual(isContextOverflowError({ message }), true);
        });
    }
    for (const code of ["context_length_exceeded", "tokens_exceeded", "ContextExceeded"]) {
        test(`recognizes structured code ${code}`, () => {
            assert.strictEqual(isContextOverflowError({ code }), true);
        });
    }
    test("recognizes wrapped LanguageModelError causes with a bounded traversal", () => {
        assert.strictEqual(
            isContextOverflowError({ message: "Provider failed", cause: new Error("prompt is too long") }),
            true
        );
        const cyclic: { message: string; cause?: unknown } = { message: "unrelated" };
        cyclic.cause = cyclic;
        assert.strictEqual(isContextOverflowError(cyclic), false);
    });
    for (const value of [
        undefined,
        null,
        42,
        "plain string failure",
        new Error("provider fail"),
        new Error("request cancelled"),
        new Error("quota exceeded"),
        new Error("rate limit exceeded"),
        new Error("max_tokens is invalid: too many tokens requested for output"),
        new Error("too many tokens requested for output"),
        { code: "tokens_exceeded", message: "too many tokens requested for output" },
        new Error("output tokens exceed the model maximum"),
        new Error("max_output_tokens exceeds maximum allowed value"),
        { code: "tokens_exceeded", message: "max_tokens is invalid for output" },
    ]) {
        test(`does not classify unrelated or output failure: ${String(value)}`, () => {
            assert.strictEqual(isContextOverflowError(value), false);
        });
    }
});
