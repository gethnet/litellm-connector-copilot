import * as assert from "assert";
import { interpretStreamEvent, createInitialStreamingState } from "../liteLLMStreamInterpreter";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

suite("LiteLLMStreamInterpreter - Tool Call Regressions", () => {
    test("should flush tool calls only when finish_reason is present (current behavior verification)", () => {
        const state = createInitialStreamingState();

        // Chunk 1: Tool call start
        const chunk1 = {
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_123",
                                function: { name: "get_weather", arguments: '{"city":' },
                            },
                        ],
                    },
                },
            ],
        };

        const parts1 = interpretStreamEvent(chunk1, state);
        assert.strictEqual(parts1.length, 0, "Should not emit tool_call yet (incomplete)");

        // Chunk 2: Tool call completion but NO finish_reason
        const chunk2 = {
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                function: { arguments: '"London"}' },
                            },
                        ],
                    },
                },
            ],
        };
        const parts2 = interpretStreamEvent(chunk2, state);
        assert.strictEqual(parts2.length, 0, "Should still not emit tool_call (missing finish_reason)");

        // Chunk 3: finish_reason
        const chunk3 = {
            choices: [
                {
                    finish_reason: "tool_calls",
                },
            ],
        };
        const parts3 = interpretStreamEvent(chunk3, state);
        assert.strictEqual(parts3.length, 2);
        assert.strictEqual(parts3[0].type, "tool_call");
        if (parts3[0].type === "tool_call") {
            assert.strictEqual(parts3[0].name, "get_weather");
            assert.strictEqual(parts3[0].args, '{"city":"London"}');
        }
        assert.strictEqual(parts3[1].type, "finish");
    });

    test("should handle tool call corruption if indices collide (theoretical bug)", () => {
        const state = createInitialStreamingState();

        // Turn 1 ends abruptly or re-uses index in weird proxy scenarios
        const chunk1 = {
            choices: [
                {
                    delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "tool1", arguments: "{" } }] },
                },
            ],
        };
        interpretStreamEvent(chunk1, state);

        // Turn 2 uses same index without finish_reason from Turn 1
        const chunk2 = {
            choices: [
                {
                    delta: {
                        tool_calls: [{ index: 0, id: "call_2", function: { name: "tool2", arguments: '{"a":1}' } }],
                    },
                },
            ],
        };
        interpretStreamEvent(chunk2, state);

        const chunk3 = { choices: [{ finish_reason: "stop" }] };
        const parts = interpretStreamEvent(chunk3, state);

        const toolCall = parts.find((p) => p.type === "tool_call");
        if (toolCall && toolCall.type === "tool_call") {
            // If it concatenates, it's corrupted: "{{\"a\":1}"
            assert.notStrictEqual(
                toolCall.args,
                '{{"a":1}',
                "Tool call arguments should not be corrupted by previous turns"
            );
        }
    });

    test("should NOT emit tool call with invalid JSON args on finish_reason: stop", () => {
        const state = createInitialStreamingState();

        // Tool call with incomplete JSON args
        const chunk1 = {
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_bad",
                                function: { name: "bad_tool", arguments: '{"incomplete":' },
                            },
                        ],
                    },
                },
            ],
        };
        interpretStreamEvent(chunk1, state);

        // finish_reason: "stop" should NOT flush incomplete tool calls
        const chunk2 = { choices: [{ finish_reason: "stop" }] };
        const parts = interpretStreamEvent(chunk2, state);

        const toolCall = parts.find((p) => p.type === "tool_call");
        assert.strictEqual(toolCall, undefined, "Should not emit tool call with invalid/incomplete JSON args");
    });

    test("should emit tool call with valid JSON args on finish_reason: tool_calls", () => {
        const state = createInitialStreamingState();

        const chunk1 = {
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_valid",
                                function: { name: "valid_tool", arguments: '{"key":"value"}' },
                            },
                        ],
                    },
                },
            ],
        };
        interpretStreamEvent(chunk1, state);

        const chunk2 = { choices: [{ finish_reason: "tool_calls" }] };
        const parts = interpretStreamEvent(chunk2, state);

        const toolCall = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCall, "Should emit tool call with valid JSON args");
        if (toolCall && toolCall.type === "tool_call") {
            assert.strictEqual(toolCall.name, "valid_tool");
            assert.strictEqual(toolCall.args, '{"key":"value"}');
        }
    });
});
