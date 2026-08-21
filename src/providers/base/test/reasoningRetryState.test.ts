import * as assert from "assert";
import type { OpenAIChatCompletionRequest } from "../../../types";
import { applyReasoningRetryState, readReasoningRetryState, replaceReasoningRetryState } from "../reasoningRetryState";

function request(overrides: Partial<OpenAIChatCompletionRequest> = {}): OpenAIChatCompletionRequest {
    return {
        model: "claude-opus-5",
        messages: [{ role: "user", content: "hi" }],
        ...overrides,
    };
}

suite("reasoningRetryState", () => {
    test("reads native adaptive fields without treating missing reasoning_effort as absent", () => {
        const state = readReasoningRetryState(
            request({
                thinking: { type: "adaptive", display: "summarized" },
                output_config: { effort: "medium" },
            })
        );

        assert.deepStrictEqual(state, {
            kind: "adaptive",
            effort: "medium",
            thinking: { type: "adaptive", display: "summarized" },
        });
    });

    test("reads string and object-form flat reasoning", () => {
        assert.deepStrictEqual(readReasoningRetryState(request({ reasoning_effort: "high" })), {
            kind: "flat",
            effort: "high",
        });
        assert.deepStrictEqual(
            readReasoningRetryState(request({ reasoning_effort: { effort: "low", summary: "detailed" } })),
            {
                kind: "flat",
                effort: "low",
                summary: "detailed",
            }
        );
    });

    test("reads explicit none and absent independently", () => {
        assert.deepStrictEqual(readReasoningRetryState(request({ reasoning_effort: "none" })), {
            kind: "none",
            effort: "none",
        });
        assert.deepStrictEqual(readReasoningRetryState(request()), { kind: "absent" });
    });

    test("prefers adaptive representation when mixed positive fields are present", () => {
        const state = readReasoningRetryState(
            request({
                reasoning_effort: "high",
                thinking: { type: "adaptive", display: "summarized" },
                output_config: { effort: "high" },
            })
        );

        assert.strictEqual(state.kind, "adaptive");
        assert.strictEqual(state.effort, "high");
    });

    test("treats explicit none as disabled even with leftover adaptive fields", () => {
        assert.deepStrictEqual(
            readReasoningRetryState(
                request({
                    reasoning_effort: "none",
                    thinking: { type: "adaptive", display: "summarized" },
                    output_config: { effort: "high" },
                })
            ),
            { kind: "none", effort: "none" }
        );
    });

    test("lowers adaptive effort without writing reasoning_effort or changing display", () => {
        const adaptive = request({
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: "high" },
        });

        applyReasoningRetryState(adaptive, readReasoningRetryState(adaptive), "medium");

        assert.strictEqual(adaptive.reasoning_effort, undefined);
        assert.deepStrictEqual(adaptive.thinking, { type: "adaptive", display: "summarized" });
        assert.deepStrictEqual(adaptive.output_config, { effort: "medium" });
    });

    test("does not mutate an absent request", () => {
        const empty = request();
        applyReasoningRetryState(empty, readReasoningRetryState(empty), undefined);
        assert.strictEqual(empty.reasoning_effort, undefined);
        assert.strictEqual(empty.thinking, undefined);
        assert.strictEqual(empty.output_config, undefined);
    });

    test("removes native fields for none or exhausted adaptive effort", () => {
        const adaptive = request({
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: "low" },
        });
        applyReasoningRetryState(adaptive, readReasoningRetryState(adaptive), "none");
        assert.strictEqual(adaptive.reasoning_effort, "none");
        assert.strictEqual(adaptive.thinking, undefined);
        assert.strictEqual(adaptive.output_config, undefined);

        const exhausted = request({
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: "low" },
        });
        applyReasoningRetryState(exhausted, readReasoningRetryState(exhausted), undefined);
        assert.strictEqual(exhausted.reasoning_effort, undefined);
        assert.strictEqual(exhausted.thinking, undefined);
        assert.strictEqual(exhausted.output_config, undefined);
    });

    test("preserves object-form summary when lowering flat effort", () => {
        const flat = request({
            model: "gpt-5.4",
            reasoning_effort: { effort: "high", summary: "concise" },
        });

        applyReasoningRetryState(flat, readReasoningRetryState(flat), "medium");

        assert.deepStrictEqual(flat.reasoning_effort, { effort: "medium", summary: "concise" });
        assert.strictEqual(flat.thinking, undefined);
    });

    test("replace overwrites rebuilt picker fields with the current retry state", () => {
        const rebuilt = request({
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: "high" },
            reasoning_effort: "high",
        });

        replaceReasoningRetryState(rebuilt, {
            kind: "adaptive",
            effort: "medium",
            thinking: { type: "adaptive", display: "summarized" },
        });

        assert.strictEqual(rebuilt.reasoning_effort, undefined);
        assert.deepStrictEqual(rebuilt.thinking, { type: "adaptive", display: "summarized" });
        assert.deepStrictEqual(rebuilt.output_config, { effort: "medium" });
    });

    test("replace clears restored reasoning when the live state is absent", () => {
        const rebuilt = request({
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: "high" },
        });

        replaceReasoningRetryState(rebuilt, { kind: "absent" });

        assert.strictEqual(rebuilt.reasoning_effort, undefined);
        assert.strictEqual(rebuilt.thinking, undefined);
        assert.strictEqual(rebuilt.output_config, undefined);
    });
});
