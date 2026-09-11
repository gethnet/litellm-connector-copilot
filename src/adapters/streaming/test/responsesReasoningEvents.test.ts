import * as assert from "assert";
import {
    createResponsesReasoningState,
    interpretResponsesReasoningEvent,
    type ResponsesReasoningState,
} from "../responsesReasoningEvents";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

/**
 * Regression tests for issue #149: the interpreter previously listened for
 * `response.output_reasoning.delta` and raw Anthropic `content_block_*`
 * events, neither of which LiteLLM's /responses bridge ever emits. These
 * tests encode the real sequence from
 * litellm/responses/litellm_completion_transformation/streaming_iterator.py.
 */
suite("ResponsesReasoningEvents - real LiteLLM /responses sequence", () => {
    test("reasoning_summary_text.delta emits a thinking part with the delta text", () => {
        const state = createResponsesReasoningState();
        const parts = interpretResponsesReasoningEvent(
            { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "Let me think" },
            state
        );
        assert.strictEqual(parts.length, 1);
        assert.strictEqual(parts[0].type, "thinking");
        if (parts[0].type === "thinking") {
            assert.strictEqual(parts[0].value, "Let me think");
        }
    });

    test("reasoning_text.delta (native OpenAI raw reasoning) emits a thinking part", () => {
        const state = createResponsesReasoningState();
        const parts = interpretResponsesReasoningEvent(
            { type: "response.reasoning_text.delta", item_id: "rs_2", delta: "raw thought" },
            state
        );
        assert.strictEqual(parts.length, 1);
        assert.strictEqual(parts[0].type, "thinking");
        if (parts[0].type === "thinking") {
            assert.strictEqual(parts[0].value, "raw thought");
        }
    });

    test("output_item.added with item.type=reasoning opens a block and returns no parts", () => {
        const state = createResponsesReasoningState();
        const parts = interpretResponsesReasoningEvent(
            {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "reasoning", id: "rs_1", summary: [] },
            },
            state
        );
        assert.strictEqual(parts.length, 0);
        assert.strictEqual(state.currentReasoningItemId, "rs_1");
    });

    test("output_item.done with item.type=reasoning emits signature-carrying thinking part", () => {
        const state = createResponsesReasoningState();
        state.currentReasoningItemId = "rs_1";
        const parts = interpretResponsesReasoningEvent(
            {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                    type: "reasoning",
                    id: "rs_1",
                    summary: [{ type: "summary_text", text: "full thought" }],
                    encrypted_content: "opaque-sig",
                },
            },
            state
        );
        assert.strictEqual(parts.length, 1);
        const part = parts[0];
        assert.strictEqual(part.type, "thinking");
        if (part.type === "thinking") {
            assert.strictEqual(part.value, "");
            assert.strictEqual(part.metadata?.encrypted_content, "opaque-sig");
        }
        // Block is closed after done
        assert.strictEqual(state.currentReasoningItemId, undefined);
    });

    test("output_item.done tolerates item.signature when encrypted_content is absent", () => {
        const state = createResponsesReasoningState();
        const parts = interpretResponsesReasoningEvent(
            {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                    type: "reasoning",
                    id: "rs_9",
                    summary: [{ type: "summary_text", text: "t" }],
                    signature: "sig-fallback",
                },
            },
            state
        );
        const part = parts[0];
        assert.ok(part && part.type === "thinking");
        if (part.type === "thinking") {
            assert.strictEqual(part.metadata?.signature, "sig-fallback");
            assert.strictEqual(part.metadata?.encrypted_content, undefined);
        }
    });

    test("output_item.done with no opaque state emits no metadata-only part", () => {
        const state = createResponsesReasoningState();
        const parts = interpretResponsesReasoningEvent(
            {
                type: "response.output_item.done",
                output_index: 0,
                item: { type: "reasoning", id: "rs_3", summary: [{ type: "summary_text", text: "t" }] },
            },
            state
        );
        // Visible text already streamed via deltas; nothing opaque to emit.
        assert.strictEqual(parts.length, 0);
    });

    test("reasoning_summary_part.done and reasoning_summary_text.done are no-ops (text already streamed)", () => {
        const state = createResponsesReasoningState();
        const partDone = interpretResponsesReasoningEvent(
            {
                type: "response.reasoning_summary_part.done",
                item_id: "rs_1",
                part: { type: "summary_text", text: "t" },
            },
            state
        );
        const textDone = interpretResponsesReasoningEvent(
            { type: "response.reasoning_summary_text.done", item_id: "rs_1", text: "t" },
            state
        );
        assert.strictEqual(partDone.length, 0);
        assert.strictEqual(textDone.length, 0);
    });

    test("non-reasoning events return empty array and are reported as unhandled", () => {
        const state = createResponsesReasoningState();
        const parts = interpretResponsesReasoningEvent(
            { type: "response.output_item.added", item: { type: "function_call", id: "fc_1" } },
            state
        );
        assert.strictEqual(parts.length, 0);
        // output_item.done with a non-reasoning item must also be untouched
        const parts2 = interpretResponsesReasoningEvent(
            { type: "response.output_item.done", item: { type: "function_call", call_id: "c1" } },
            state
        );
        assert.strictEqual(parts2.length, 0);
    });

    test("display metadata from state is attached to reasoning deltas", () => {
        const state = createResponsesReasoningState();
        state.currentThinkingDisplay = "omitted";
        const parts = interpretResponsesReasoningEvent(
            { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "x" },
            state
        );
        const part = parts[0];
        assert.ok(part && part.type === "thinking");
        if (part.type === "thinking") {
            assert.strictEqual(part.metadata?.display, "omitted");
        }
    });

    test("malformed frames (non-object, missing type, non-string delta) return no parts", () => {
        const state = createResponsesReasoningState();
        assert.deepStrictEqual(interpretResponsesReasoningEvent("not-an-object", state), []);
        assert.deepStrictEqual(interpretResponsesReasoningEvent({}, state), []);
        const noText = interpretResponsesReasoningEvent(
            { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "" },
            state
        );
        assert.strictEqual(noText.length, 0, "empty delta should not emit a part");
        const wrongType = interpretResponsesReasoningEvent(
            { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: 42 },
            state as ResponsesReasoningState
        );
        assert.strictEqual(wrongType.length, 0, "non-string delta should not emit a part");
    });
});
