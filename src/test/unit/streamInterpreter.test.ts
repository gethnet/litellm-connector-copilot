import * as assert from "assert";
import { interpretStreamEvent, createInitialStreamingState } from "../../adapters/streaming/liteLLMStreamInterpreter";

suite("Stream Interpreter Unit Tests", () => {
    test("interprets OpenAI text delta", () => {
        const state = createInitialStreamingState();
        const event = {
            choices: [
                {
                    delta: { content: "hello" },
                },
            ],
        };
        const parts = interpretStreamEvent(event, state);
        assert.deepStrictEqual(parts, [{ type: "text", value: "hello" }]);
    });

    test("interprets OpenAI tool call delta", () => {
        const state = createInitialStreamingState();
        const event = {
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_1",
                                function: { name: "get_weather", arguments: '{"lo' },
                            },
                        ],
                    },
                },
            ],
        };
        const parts = interpretStreamEvent(event, state);
        // Tool calls are buffered until finish or explicit flush logic in interpreter (currently buffers in state)
        assert.strictEqual(parts.length, 0);
        assert.strictEqual(state.toolCallBuffers.get(0)?.args, '{"lo');

        const event2 = {
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                function: { arguments: 'cation": "London"}' },
                            },
                        ],
                    },
                },
            ],
        };
        interpretStreamEvent(event2, state);
        assert.strictEqual(state.toolCallBuffers.get(0)?.args, '{"location": "London"}');
    });

    test("emits tool call and finish on finish_reason", () => {
        const state = createInitialStreamingState();
        // Setup buffered tool call
        state.toolCallBuffers.set(0, { id: "call_1", name: "get_weather", args: '{"location": "London"}' });

        const event = {
            choices: [
                {
                    finish_reason: "tool_calls",
                },
            ],
        };
        const parts = interpretStreamEvent(event, state);
        assert.deepStrictEqual(parts, [
            { type: "tool_call", index: 0, id: "call_1", name: "get_weather", args: '{"location": "London"}' },
            { type: "finish", reason: "tool_calls" },
        ]);
    });

    test("interprets LiteLLM /responses format", () => {
        const state = createInitialStreamingState();
        const event = {
            type: "response.output_text.delta",
            delta: "hello",
        };
        const parts = interpretStreamEvent(event, state);
        assert.deepStrictEqual(parts, [{ type: "text", value: "hello" }]);

        const doneEvent = { type: "response.output_item.done" };
        const doneParts = interpretStreamEvent(doneEvent, state);
        assert.deepStrictEqual(doneParts, [{ type: "finish" }]);
    });
});
