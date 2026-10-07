import * as assert from "assert";
import type * as vscode from "vscode";
import { resolveRequestOutputCap, getRequestInputTokenBudget, getPreparedOutputCap } from "../requestTokenBudget";
import type { LiteLLMModelInfo } from "../../types";

suite("Request-only token budgets (#159)", () => {
    const model = Object.freeze({
        id: "test-model",
        maxInputTokens: 229376,
        maxOutputTokens: 32768,
        maxContextWindowTokens: 229376,
    }) as vscode.LanguageModelChatInformation;
    test("does not reserve again from an explicit independent input maximum", () => {
        const info = Object.freeze({ max_input_tokens: 229376, max_output_tokens: 32768 });
        assert.strictEqual(getRequestInputTokenBudget(model, info, 32768), 229376);
        assert.strictEqual(getRequestInputTokenBudget(model, info, 4096), 229376);
        assert.strictEqual(info.max_input_tokens, 229376);
    });
    test("honors an explicit total without assuming maxima sum", () => {
        const info = { max_input_tokens: 229376, context_window_tokens: 240000, max_tokens: 999999 };
        assert.strictEqual(getRequestInputTokenBudget(model, info, 32768), 207232);
        assert.strictEqual(getRequestInputTokenBudget(model, info, 4096), 229376);
    });
    test("legacy-only is an independent fallback, not a combined constraint", () => {
        assert.strictEqual(getRequestInputTokenBudget(model, { max_tokens: 240000 }, 32768), 229376);
        const contextOnly = { context_window_tokens: 8000 };
        assert.strictEqual(getRequestInputTokenBudget({ ...model, maxInputTokens: 8000 }, contextOnly, 1000), 7000);
    });
    test("missing raw metadata cannot promote host display fallback to combined capacity", () => {
        assert.strictEqual(getRequestInputTokenBudget(model, undefined, 32768), 229376);
        assert.strictEqual(
            getRequestInputTokenBudget({ ...model, maxContextWindowTokens: undefined }, undefined, 32768),
            229376
        );
    });
    test("normal Claude input budget is independent of either output cap", () => {
        const info = Object.freeze({ max_input_tokens: 200000, max_output_tokens: 8192, max_tokens: 8192 });
        const claude = { ...model, maxInputTokens: 200000, maxOutputTokens: 8192, maxContextWindowTokens: 200000 };
        assert.strictEqual(getRequestInputTokenBudget(claude, info, 8192), 200000);
        assert.strictEqual(getRequestInputTokenBudget(claude, info, 4096), 200000);
    });
    test("raw independent ceilings constrain larger positive host limits", () => {
        const info = Object.freeze({ max_input_tokens: 8000, max_output_tokens: 500 });
        assert.strictEqual(getRequestInputTokenBudget(model, info, 500), 8000);
        assert.strictEqual(resolveRequestOutputCap(model, undefined, info), 500);
        assert.strictEqual(resolveRequestOutputCap(model, 800, info), 500);
        assert.strictEqual(resolveRequestOutputCap(model, 300, info), 300);
        assert.strictEqual(info.max_input_tokens, 8000);
    });
    test("zero remaining capacity is not clamped up", () => {
        assert.strictEqual(getRequestInputTokenBudget(model, { context_window_tokens: 1000 }, 1000), 0);
        assert.strictEqual(getRequestInputTokenBudget(model, { context_window_tokens: 500 }, 1000), 0);
    });
    test("output cap is finite, positive, integral, and within the raw output maximum", () => {
        assert.strictEqual(resolveRequestOutputCap(model, undefined), 32768);
        assert.strictEqual(resolveRequestOutputCap(model, 999999), 32768);
        assert.strictEqual(resolveRequestOutputCap(model, 4096.8), 4096);
        for (const invalid of [0, -1, Number.NaN, Infinity, "4096", 0.5]) {
            assert.throws(() => resolveRequestOutputCap(model, invalid), /Invalid request output token limit/);
        }
        assert.throws(
            () => resolveRequestOutputCap({ ...model, maxOutputTokens: 0 }),
            /Invalid model output token limit/
        );
    });
    test("invalid present metadata fails closed without changing it", () => {
        for (const invalid of [0, -1, Number.NaN, Infinity]) {
            const info: LiteLLMModelInfo = Object.freeze({ context_window_tokens: invalid });
            assert.throws(() => getRequestInputTokenBudget(model, info, 1000), /Invalid combined context token limit/);
            assert.ok(Object.is(info.context_window_tokens, invalid));
        }
        assert.throws(
            () => getRequestInputTokenBudget({ ...model, maxInputTokens: 0 }, {}, 1000),
            /Invalid model input token limit/
        );
        assert.throws(() => getRequestInputTokenBudget(model, {}, 0), /Invalid request output token limit/);
        for (const invalid of [0, -1, Number.NaN, Infinity, 0.5]) {
            assert.throws(
                () => getRequestInputTokenBudget(model, { max_input_tokens: invalid }, 1000),
                /Invalid raw input token limit/
            );
            assert.throws(
                () => getRequestInputTokenBudget(model, { max_output_tokens: invalid }, 1000),
                /Invalid raw output token limit/
            );
            assert.throws(
                () => resolveRequestOutputCap(model, 1000, { max_output_tokens: invalid }),
                /Invalid raw output token limit/
            );
        }
    });
    test("applies margins to local budgets only", () => {
        assert.strictEqual(getRequestInputTokenBudget(model, { max_input_tokens: 229376 }, 32768, 0.95), 217907);
        assert.strictEqual(model.maxInputTokens, 229376);
        assert.throws(() => getRequestInputTokenBudget(model, {}, 1000, 1.1), /Invalid input safety ratio/);
    });
    test("usage consumes the actual prepared cap without a second reservation", () => {
        assert.strictEqual(getPreparedOutputCap({ max_tokens: 8192 }), 8192);
        assert.strictEqual(getPreparedOutputCap({ max_tokens: 4096 }), 4096);
        assert.strictEqual(getPreparedOutputCap({ max_tokens: 500 }), 500);
        for (const invalid of [undefined, 0, -1, Infinity, Number.NaN, 0.5]) {
            assert.throws(() => getPreparedOutputCap({ max_tokens: invalid }), /Invalid prepared output token limit/);
        }
    });
});
