import * as assert from "assert";
import { decodeSSE } from "../../adapters/sse/sseDecoder";
import { interpretStreamEvent, createInitialStreamingState } from "../../adapters/streaming/liteLLMStreamInterpreter";

/*eslint no-useless-escape: "off"*/
suite("Stream Interpreter Unit Tests", () => {
    test("decodeSSE rejoins multiline data frames", async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(
                    encoder.encode(
                        'data: {"type":"response.output_text.delta",\n' +
                            'data: "delta":"semi; colon: quote \\\" and backtick `"}\n\n' +
                            "data: [DONE]\n\n"
                    )
                );
                controller.close();
            },
        });

        const payloads: string[] = [];
        for await (const payload of decodeSSE(stream)) {
            payloads.push(payload);
        }

        assert.deepStrictEqual(payloads, [
            '{"type":"response.output_text.delta",\n"delta":"semi; colon: quote \\\" and backtick `"}',
        ]);
    });

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

    test("interprets Gemini native format", () => {
        const state = createInitialStreamingState();
        const event = {
            candidates: [
                {
                    content: {
                        parts: [{ text: "hello from gemini" }],
                    },
                },
            ],
        };
        const parts = interpretStreamEvent(event, state);
        assert.deepStrictEqual(parts, [{ type: "text", value: "hello from gemini" }]);
    });

    test("deduplicates tool calls with same ID across finish_reason events", () => {
        const state = createInitialStreamingState();

        // First turn: emit tool call with ID "call_1"
        const event1 = {
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_1",
                                function: { name: "get_weather", arguments: '{"location":"London"}' },
                            },
                        ],
                    },
                    finish_reason: "tool_calls",
                },
            ],
        };
        const parts1 = interpretStreamEvent(event1, state);
        const toolCalls1 = parts1.filter((p) => p.type === "tool_call");
        assert.strictEqual(toolCalls1.length, 1, "First turn should emit 1 tool call");
        // IDs are now normalized to start with 'fc_' and be <= 40 chars
        const emittedId1 = (toolCalls1[0] as { id: string }).id;
        assert.ok(emittedId1.startsWith("fc_"), `Expected normalized ID to start with 'fc_', got: ${emittedId1}`);
        assert.ok(emittedId1.length <= 40, `Expected normalized ID <= 40 chars, got: ${emittedId1.length}`);

        // Second turn: same tool call ID should NOT be emitted again
        // This simulates a model that re-sends previous tool calls in history
        const event2 = {
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_1",
                                function: { name: "get_weather", arguments: '{"location":"London"}' },
                            },
                        ],
                    },
                    finish_reason: "tool_calls",
                },
            ],
        };
        const parts2 = interpretStreamEvent(event2, state);
        const toolCalls2 = parts2.filter((p) => p.type === "tool_call");
        assert.strictEqual(toolCalls2.length, 0, "Second turn should NOT re-emit same tool call ID");
    });

    test("allows new tool call IDs in subsequent turns", () => {
        const state = createInitialStreamingState();

        // First turn: emit tool call with ID "call_1"
        const event1 = {
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_1",
                                function: { name: "get_weather", arguments: '{"location":"London"}' },
                            },
                        ],
                    },
                    finish_reason: "tool_calls",
                },
            ],
        };
        const parts1 = interpretStreamEvent(event1, state);
        const toolCalls1 = parts1.filter((p) => p.type === "tool_call");
        assert.strictEqual(toolCalls1.length, 1, "First turn should emit 1 tool call");
        const firstId = (toolCalls1[0] as { id: string }).id;
        assert.ok(firstId.startsWith("fc_"), `Expected normalized ID to start with 'fc_', got: ${firstId}`);

        // Second turn: new tool call ID "call_2" should be emitted
        const event2 = {
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_2",
                                function: { name: "get_time", arguments: '{"timezone":"UTC"}' },
                            },
                        ],
                    },
                    finish_reason: "tool_calls",
                },
            ],
        };
        const parts2 = interpretStreamEvent(event2, state);
        const toolCalls2 = parts2.filter((p) => p.type === "tool_call");
        assert.strictEqual(toolCalls2.length, 1, "Second turn should emit new tool call");
        const secondId = (toolCalls2[0] as { id: string }).id;
        assert.ok(secondId.startsWith("fc_"), `Expected normalized ID to start with 'fc_', got: ${secondId}`);
        // Verify the two IDs are different (different original IDs produce different normalized IDs)
        assert.notStrictEqual(firstId, secondId, "Different original IDs should produce different normalized IDs");
    });
});
