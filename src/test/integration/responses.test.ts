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

    test("should handle reasoning delta events", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            { type: "response.output_reasoning.delta", delta: "Let me think..." },
            state
        );

        assert.strictEqual(parts.length, 1);
        assert.strictEqual(parts[0].type, "thinking");
        if (parts[0].type === "thinking") {
            assert.strictEqual(parts[0].value, "Let me think...");
        }
    });
});
