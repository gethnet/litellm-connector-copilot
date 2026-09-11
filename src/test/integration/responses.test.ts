import * as assert from "assert";
import { interpretStreamEvent, createInitialStreamingState } from "../../adapters/streaming/liteLLMStreamInterpreter";

suite("Responses /responses stream interpreter integration", () => {
    test("should handle output_item.delta → output_item.done tool call sequence", () => {
        const state = createInitialStreamingState();

        interpretStreamEvent(
            {
                type: "response.output_item.delta",
                item: { type: "function_call", call_id: "c1", name: "search", arguments: '{"q":' },
            },
            state
        );
        interpretStreamEvent(
            {
                type: "response.output_item.delta",
                item: { type: "function_call", call_id: "c1", arguments: '"test"}' },
            },
            state
        );

        const parts = interpretStreamEvent(
            {
                type: "response.output_item.done",
                item: { type: "function_call", call_id: "c1", name: "search", arguments: '{"q":"test"}' },
            },
            state
        );

        const tc = parts.find((p) => p.type === "tool_call");
        assert.ok(tc && tc.type === "tool_call");
        assert.strictEqual(tc.id, "c1");
        assert.strictEqual(tc.name, "search");
        assert.strictEqual(tc.args, '{"q":"test"}');
    });

    test("should handle response.completed usage frame after output_item path", () => {
        const state = createInitialStreamingState();

        interpretStreamEvent({ type: "response.output_text.delta", delta: "Hello" }, state);

        const parts = interpretStreamEvent(
            { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } },
            state
        );

        const usage = parts.find((p) => p.type === "data");
        assert.ok(usage && usage.type === "data");
        assert.strictEqual(usage.mimeType, "usage");
        assert.strictEqual((usage.value as { prompt_tokens: number }).prompt_tokens, 10);
        assert.strictEqual((usage.value as { completion_tokens: number }).completion_tokens, 5);
    });

    test("should handle text delta events", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent({ type: "response.output_text.delta", delta: "Hello World" }, state);

        assert.strictEqual(parts.length, 1);
        assert.strictEqual(parts[0].type, "text");
        if (parts[0].type === "text") {
            assert.strictEqual(parts[0].value, "Hello World");
        }
    });

    test("should surface the real LiteLLM /responses reasoning sequence end-to-end", () => {
        const state = createInitialStreamingState();

        // Real LiteLLM bridge sequence for a reasoning model (issue #149)
        const open = interpretStreamEvent(
            {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "reasoning", id: "rs_1", summary: [] },
            },
            state
        );
        assert.strictEqual(open.length, 0);

        const delta = interpretStreamEvent(
            { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "Let me think..." },
            state
        );
        assert.strictEqual(delta.length, 1);
        assert.strictEqual(delta[0].type, "thinking");
        if (delta[0].type === "thinking") {
            assert.strictEqual(delta[0].value, "Let me think...");
        }

        const done = interpretStreamEvent(
            {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                    type: "reasoning",
                    id: "rs_1",
                    summary: [{ type: "summary_text", text: "Let me think..." }],
                    encrypted_content: "opaque-continuity",
                },
            },
            state
        );
        const sig = done.find((p) => p.type === "thinking");
        assert.ok(sig && sig.type === "thinking");
        if (sig.type === "thinking") {
            assert.strictEqual(sig.metadata?.encrypted_content, "opaque-continuity");
        }

        // And the completed frame still yields usage afterwards
        const completed = interpretStreamEvent(
            { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 2 } } },
            state
        );
        assert.ok(completed.some((p) => p.type === "data"));
    });
});
