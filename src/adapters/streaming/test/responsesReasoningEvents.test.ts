import * as assert from "assert";
import * as sinon from "sinon";
import {
    createResponsesReasoningState,
    interpretResponsesReasoningEvent,
    type ResponsesReasoningState,
} from "../responsesReasoningEvents";
import { StructuredLogger } from "../../../observability/structuredLogger";
import { Logger } from "../../../utils/logger";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

/** Id of the first thinking part in a batch, or undefined when there is none. */
function thinkingId(parts: ReturnType<typeof interpretResponsesReasoningEvent>): string | undefined {
    const part = parts.find((p) => p.type === "thinking");
    return part?.type === "thinking" ? part.id : undefined;
}

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
            assert.strictEqual(part.id, "rs_1");
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

    test("delta trace carries upstream identity (itemId, indices, sequence) and correlation options", () => {
        const sandbox = sinon.createSandbox();
        try {
            const traceStub = sandbox.stub(StructuredLogger, "trace");
            const state = createResponsesReasoningState();
            state.currentReasoningItemId = "rs_abc";
            const parts = interpretResponsesReasoningEvent(
                {
                    type: "response.reasoning_summary_text.delta",
                    item_id: "rs_abc",
                    output_index: 0,
                    summary_index: 2,
                    sequence_number: 17,
                    delta: "thought fragment",
                },
                state,
                { requestId: "req-9", model: "claude-sonnet", endpoint: "responses" }
            );
            assert.strictEqual(parts.length, 1, "behavior unchanged: one thinking part per delta");

            const call = traceStub.getCalls().find((c) => c.args[0] === "stream.responses_reasoning_delta");
            assert.ok(call, "expected a stream.responses_reasoning_delta trace line");
            const data = call.args[1] as Record<string, unknown>;
            assert.strictEqual(data.eventType, "response.reasoning_summary_text.delta");
            assert.match(String(data.itemId), /^[a-f0-9]{64}$/);
            assert.strictEqual(data.outputIndex, 0);
            assert.strictEqual(data.summaryIndex, 2);
            assert.strictEqual(data.sequenceNumber, 17);
            assert.strictEqual(data.openReasoningItemId, data.itemId);
            assert.strictEqual(data.length, "thought fragment".length);
            assert.ok(!JSON.stringify(data).includes("thought fragment"));

            const options = call.args[2] as Record<string, unknown> | undefined;
            assert.strictEqual(options?.requestId, "req-9");
            assert.strictEqual(options?.endpoint, "responses");
        } finally {
            sandbox.restore();
        }
    });

    test("reasoning identity is correlated without logging untrusted IDs and replay remains unchanged", () => {
        const sandbox = sinon.createSandbox();
        try {
            const structured = sandbox.stub(StructuredLogger, "log");
            const legacy = sandbox.stub(Logger, "debug");
            const state = createResponsesReasoningState();
            const id = "private@example.com-reasoning-id";
            interpretResponsesReasoningEvent(
                { type: "response.output_item.added", item: { type: "reasoning", id } },
                state
            );
            interpretResponsesReasoningEvent(
                { type: "response.reasoning_text.delta", item_id: id, delta: "thought" },
                state
            );
            const parts = interpretResponsesReasoningEvent(
                { type: "response.output_item.done", item: { type: "reasoning", id, signature: "sig" } },
                state
            );
            assert.deepStrictEqual(parts, [{ type: "thinking", value: "", id, metadata: { signature: "sig" } }]);
            const calls = structured.getCalls();
            const opened = calls.find((call) => call.args[1] === "stream.responses_reasoning_block_opened");
            const delta = calls.find((call) => call.args[1] === "stream.responses_reasoning_delta");
            const closed = calls.find((call) => call.args[1] === "stream.responses_reasoning_block_closed");
            assert.ok(opened && delta && closed);
            const openId = (opened.args[2] as { itemId: string }).itemId;
            assert.match(openId, /^[a-f0-9]{64}$/);
            assert.strictEqual((delta.args[2] as { itemId: string; openReasoningItemId: string }).itemId, openId);
            assert.strictEqual((delta.args[2] as { openReasoningItemId: string }).openReasoningItemId, openId);
            assert.strictEqual((closed.args[2] as { itemId: string }).itemId, openId);
            assert.ok(!JSON.stringify([structured.args, legacy.args]).includes(id));
        } finally {
            sandbox.restore();
        }
    });

    test("logContext is optional: omitting it keeps the legacy no-request behavior", () => {
        const sandbox = sinon.createSandbox();
        try {
            const traceStub = sandbox.stub(StructuredLogger, "trace");
            const state = createResponsesReasoningState();
            const parts = interpretResponsesReasoningEvent(
                { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "x" },
                state
            );
            assert.strictEqual(parts.length, 1);
            const call = traceStub.getCalls().find((c) => c.args[0] === "stream.responses_reasoning_delta");
            assert.ok(call);
            assert.strictEqual(call.args[2], undefined, "no fabricated correlation when context is unavailable");
        } finally {
            sandbox.restore();
        }
    });

    // Issue #182: id-less deltas let the host split one reasoning run into many blocks.
    test("deltas of one reasoning item share its upstream id and match the closing metadata part", () => {
        const state = createResponsesReasoningState();
        interpretResponsesReasoningEvent(
            { type: "response.output_item.added", item: { type: "reasoning", id: "rs_a" } },
            state
        );
        const first = thinkingId(
            interpretResponsesReasoningEvent(
                { type: "response.reasoning_summary_text.delta", item_id: "rs_a", delta: "First " },
                state
            )
        );
        const second = thinkingId(
            interpretResponsesReasoningEvent(
                { type: "response.reasoning_summary_text.delta", item_id: "rs_a", delta: "thought" },
                state
            )
        );
        const closing = thinkingId(
            interpretResponsesReasoningEvent(
                {
                    type: "response.output_item.done",
                    item: { type: "reasoning", id: "rs_a", encrypted_content: "enc" },
                },
                state
            )
        );
        assert.strictEqual(first, "rs_a");
        assert.strictEqual(second, "rs_a");
        assert.strictEqual(closing, "rs_a");

        const nextItem = thinkingId(
            interpretResponsesReasoningEvent(
                { type: "response.reasoning_summary_text.delta", item_id: "rs_b", delta: "Next" },
                state
            )
        );
        assert.strictEqual(nextItem, "rs_b", "a different reasoning item must get a different id");
    });

    test("a delta without item_id uses the open reasoning item id", () => {
        const state = createResponsesReasoningState();
        interpretResponsesReasoningEvent(
            { type: "response.output_item.added", item: { type: "reasoning", id: "rs_open" } },
            state
        );
        const id = thinkingId(
            interpretResponsesReasoningEvent({ type: "response.reasoning_text.delta", delta: "thought" }, state)
        );
        assert.strictEqual(id, "rs_open");
    });

    test("deltas with no upstream identity share one generated id that is not reused across streams", () => {
        const state = createResponsesReasoningState();
        const delta = { type: "response.reasoning_text.delta", delta: "thought" };
        const first = thinkingId(interpretResponsesReasoningEvent(delta, state));
        assert.ok(first && first.startsWith("thinking-"), "expected a generated thinking- id");
        assert.strictEqual(thinkingId(interpretResponsesReasoningEvent(delta, state)), first);

        const otherStream = thinkingId(interpretResponsesReasoningEvent(delta, createResponsesReasoningState()));
        assert.ok(otherStream);
        assert.notStrictEqual(otherStream, first, "streams must not share generated ids");
    });

    test("a generated id is dropped once a reasoning item opens and closes", () => {
        const state = createResponsesReasoningState();
        const delta = { type: "response.reasoning_text.delta", delta: "thought" };
        const before = thinkingId(interpretResponsesReasoningEvent(delta, state));
        interpretResponsesReasoningEvent(
            { type: "response.output_item.added", item: { type: "reasoning", id: "rs_c" } },
            state
        );
        interpretResponsesReasoningEvent(
            { type: "response.output_item.done", item: { type: "reasoning", id: "rs_c" } },
            state
        );
        const after = thinkingId(interpretResponsesReasoningEvent(delta, state));
        assert.ok(before && after);
        assert.notStrictEqual(after, before, "a later id-less run must not reuse the earlier generated id");
    });

    test("delta trace records which source supplied the id without logging the id", () => {
        const sandbox = sinon.createSandbox();
        try {
            const traceStub = sandbox.stub(StructuredLogger, "trace");
            const sourceOfLastDelta = (): unknown => {
                const calls = traceStub.getCalls().filter((c) => c.args[0] === "stream.responses_reasoning_delta");
                return (calls[calls.length - 1].args[1] as Record<string, unknown>).idSource;
            };
            const state = createResponsesReasoningState();

            interpretResponsesReasoningEvent({ type: "response.reasoning_text.delta", delta: "a" }, state);
            assert.strictEqual(sourceOfLastDelta(), "generated");

            interpretResponsesReasoningEvent(
                { type: "response.output_item.added", item: { type: "reasoning", id: "rs_private_open" } },
                state
            );
            interpretResponsesReasoningEvent({ type: "response.reasoning_text.delta", delta: "b" }, state);
            assert.strictEqual(sourceOfLastDelta(), "open_item");

            interpretResponsesReasoningEvent(
                { type: "response.reasoning_text.delta", item_id: "rs_private_frame", delta: "c" },
                state
            );
            assert.strictEqual(sourceOfLastDelta(), "item_id");

            const logged = JSON.stringify(traceStub.args);
            assert.ok(!logged.includes("rs_private_open") && !logged.includes("rs_private_frame"));
        } finally {
            sandbox.restore();
        }
    });
});
