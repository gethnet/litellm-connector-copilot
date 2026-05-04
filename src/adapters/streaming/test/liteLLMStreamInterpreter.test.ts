import * as assert from "assert";
import { interpretStreamEvent, createInitialStreamingState } from "../liteLLMStreamInterpreter";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

suite("LiteLLMStreamInterpreter - Tool Call Regressions", () => {
    test("should clear buffered tool calls when stream aborts before finish", () => {
        const state = createInitialStreamingState();

        // Start buffering a tool call but never send finish_reason
        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_stale",
                                    function: { name: "tool", arguments: "{" },
                                },
                            ],
                        },
                    },
                ],
            },
            state
        );

        // Simulate abort/reset for a new request on same connection
        state.toolCallBuffers.clear();
        state.completedToolCallIndices.clear();
        state.emittedTextToolCallIds.clear();

        // Next request reuses index 0; should not be corrupted by stale args
        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_fresh",
                                    function: { name: "tool", arguments: '{"ok":true}' },
                                },
                            ],
                        },
                    },
                ],
            },
            state
        );

        const parts = interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);
        const toolCall = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        if (toolCall && toolCall.type === "tool_call") {
            assert.strictEqual(toolCall.args, '{"ok":true}');
        }
    });

    test("should emit thinking before text and tool calls when mixed in one chunk", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            content: "hi",
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_order",
                                    function: { name: "tool", arguments: "{}" },
                                },
                            ],
                        },
                        // Simulate thinking surfaced in /responses style alongside OpenAI delta
                    },
                ],
                type: "response.output_reasoning.delta",
                delta: "thought",
            },
            state
        );

        const order = parts.map((p) => p.type);
        assert.deepStrictEqual(order, ["thinking", "text"]);
    });

    test("should parse LiteLLM /responses tool calls and flush on completed", () => {
        const state = createInitialStreamingState();

        // Tool call arrives in fragments
        interpretStreamEvent(
            {
                type: "response.output_tool_call.delta",
                delta: { id: "call-resp", name: "tc_responses", arguments: "{" },
            },
            state
        );
        interpretStreamEvent(
            {
                type: "response.output_tool_call.delta",
                delta: { id: "call-resp", arguments: '"x":1}' },
            },
            state
        );

        const parts = interpretStreamEvent(
            {
                type: "response.completed",
                response: {
                    usage: {
                        input_tokens: 1,
                        input_tokens_details: { cached_tokens: 1 },
                        output_tokens: 2,
                        output_tokens_details: {
                            reasoning_tokens: 1,
                            accepted_prediction_tokens: 0,
                            rejected_prediction_tokens: 0,
                        },
                        total_tokens: 3,
                    },
                },
            },
            state
        );

        const toolCall = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        if (toolCall && toolCall.type === "tool_call") {
            assert.strictEqual(toolCall.name, "tc_responses");
            assert.strictEqual(toolCall.args, '{"x":1}');
        }

        const usage = parts.find((p) => p.type === "data");
        assert.ok(usage, "expected usage data part to be emitted");
        if (usage && usage.type === "data") {
            const parsed = usage.value;
            assert.deepStrictEqual(parsed, {
                kind: "usage",
                promptTokens: 1,
                completionTokens: 2,
                totalTokens: 3,
                reasoningTokens: 1,
                promptTokensDetails: { cachedTokens: 1 },
                completionTokensDetails: {
                    acceptedPredictionTokens: 0,
                    rejectedPredictionTokens: 0,
                },
            });
        }
    });

    test("preserves detailed usage metrics from response.completed frames", () => {
        const state = createInitialStreamingState();

        const parts = interpretStreamEvent(
            {
                type: "response.completed",
                response: {
                    usage: {
                        input_tokens: 12,
                        input_tokens_details: { cached_tokens: 10 },
                        output_tokens: 4,
                        output_tokens_details: {
                            reasoning_tokens: 2,
                            accepted_prediction_tokens: 1,
                            rejected_prediction_tokens: 0,
                        },
                        total_tokens: 16,
                    },
                },
            },
            state
        );

        const responsePart = parts.find((part) => part.type === "response");
        assert.ok(responsePart && responsePart.type === "response", "expected response usage part to be emitted");
        if (!responsePart || responsePart.type !== "response") {
            return;
        }

        assert.deepStrictEqual(responsePart.usage, {
            inputTokens: 12,
            outputTokens: 4,
            totalTokens: 16,
            reasoningTokens: 2,
            promptTokensDetails: { cachedTokens: 10 },
            completionTokensDetails: {
                acceptedPredictionTokens: 1,
                rejectedPredictionTokens: 0,
            },
        });

        const usageDataPart = parts.find((part) => part.type === "data");
        assert.ok(usageDataPart && usageDataPart.type === "data", "expected usage data payload part to be emitted");
        if (!usageDataPart || usageDataPart.type !== "data") {
            return;
        }

        assert.deepStrictEqual(usageDataPart.value, {
            kind: "usage",
            promptTokens: 12,
            completionTokens: 4,
            totalTokens: 16,
            reasoningTokens: 2,
            promptTokensDetails: { cachedTokens: 10 },
            completionTokensDetails: {
                acceptedPredictionTokens: 1,
                rejectedPredictionTokens: 0,
            },
        });
    });

    test("should flush /responses tool calls on output_item.done when no completed frame", () => {
        const state = createInitialStreamingState();

        interpretStreamEvent(
            {
                type: "response.output_tool_call.delta",
                delta: { id: "call-resp-2", name: "tc2", arguments: "{" },
            },
            state
        );
        interpretStreamEvent(
            {
                type: "response.output_tool_call.delta",
                delta: { id: "call-resp-2", arguments: '"y":true}' },
            },
            state
        );

        const parts = interpretStreamEvent({ type: "response.output_item.done" }, state);
        const toolCall = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        if (toolCall && toolCall.type === "tool_call") {
            assert.strictEqual(toolCall.name, "tc2");
            assert.strictEqual(toolCall.args, '{"y":true}');
        }
    });

    test("should parse Gemini native tool call shape", () => {
        const state = createInitialStreamingState();
        const parts = interpretStreamEvent(
            {
                candidates: [
                    {
                        content: {
                            parts: [
                                {
                                    functionCall: {
                                        name: "gem_tool",
                                        args: { city: "Paris" },
                                    },
                                },
                            ],
                        },
                    },
                ],
            },
            state
        );

        const toolCall = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        if (toolCall && toolCall.type === "tool_call") {
            assert.strictEqual(toolCall.name, "gem_tool");
            assert.strictEqual(toolCall.args, '{"city":"Paris"}');
        }
    });

    test("should suppress cache-control VS Code DataPart carrier objects", () => {
        const state = createInitialStreamingState();
        const parts = interpretStreamEvent(
            {
                $mid: 1,
                mimeType: "application/vnd.cache-control+json",
                data: "ZXBoZW1lcmFs",
            },
            state
        );

        assert.deepStrictEqual(parts, []);
    });

    test("should pass through non-cache-control VS Code DataPart carrier objects", () => {
        const state = createInitialStreamingState();
        const parts = interpretStreamEvent(
            {
                $mid: 2,
                mimeType: "application/vnd.litellm.usage+json",
                data: { promptTokens: 1, completionTokens: 2 },
            },
            state
        );

        assert.strictEqual(parts.length, 1);
        const [part] = parts;
        assert.strictEqual(part.type, "data");
        if (part.type === "data") {
            assert.strictEqual(part.mimeType, "application/vnd.litellm.usage+json");
        }
    });

    test("should normalize tool call ids on update and merge name/args", () => {
        const state = createInitialStreamingState();

        // Initial fragment with raw id
        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "rawId",
                                    function: { name: "tool", arguments: "{" },
                                },
                            ],
                        },
                    },
                ],
            },
            state
        );

        // Update with same raw id to trigger normalization + name update + args concat
        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "rawId",
                                    function: { name: "toolUpdated", arguments: '"value":true}' },
                                },
                            ],
                        },
                    },
                ],
            },
            state
        );

        const parts = interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);
        const toolCall = parts.find((p) => p.type === "tool_call");
        assert.ok(toolCall && toolCall.type === "tool_call");
        if (toolCall && toolCall.type === "tool_call") {
            assert.strictEqual(toolCall.name, "toolUpdated");
            assert.strictEqual(toolCall.args, '{"value":true}');
            assert.ok(toolCall.id?.startsWith("fc_"));
        }
    });
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

    test("should NOT emit tool_call when finish_reason is tool_calls and args are invalid JSON", () => {
        // Regression: previously allowEmit = isJsonValid || finishReason === "tool_calls"
        // silently forwarded malformed args to the emitter. Now it must hard-block.
        const state = createInitialStreamingState();

        // Buffer a tool call with malformed (incomplete) args
        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_bad",
                                    function: { name: "bad_tool", arguments: '{"city":' },
                                },
                            ],
                        },
                    },
                ],
            },
            state
        );

        // finish_reason arrives but args are still malformed
        const parts = interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);

        const toolCallParts = parts.filter((p) => p.type === "tool_call");
        assert.strictEqual(
            toolCallParts.length,
            0,
            "Must NOT emit a tool_call when args are invalid JSON, regardless of finish_reason"
        );

        // finish part should still be emitted so the stream terminates cleanly
        const finishParts = parts.filter((p) => p.type === "finish");
        assert.strictEqual(finishParts.length, 1, "Must still emit a finish part");
    });

    test("should emit an error part when finish_reason is tool_calls and args are invalid JSON", () => {
        // After fixing the allowEmit gate, the interpreter must surface an error part
        // so the caller knows the tool call was corrupted and can fail fast.
        const state = createInitialStreamingState();

        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_bad",
                                    function: { name: "bad_tool", arguments: '{"city":' },
                                },
                            ],
                        },
                    },
                ],
            },
            state
        );

        const parts = interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);

        const errorParts = parts.filter((p) => p.type === "error");
        assert.strictEqual(errorParts.length, 1, "Must emit exactly one error part for a corrupted tool call");
        if (errorParts[0].type === "error") {
            assert.ok(
                errorParts[0].message.includes("bad_tool"),
                "Error message should include the tool name for debuggability"
            );
        }
    });

    test("should still emit valid tool_calls when finish_reason is tool_calls", () => {
        // Regression guard: fixing allowEmit must not break the normal happy path
        const state = createInitialStreamingState();

        interpretStreamEvent(
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_good",
                                    function: { name: "good_tool", arguments: '{"city":"London"}' },
                                },
                            ],
                        },
                    },
                ],
            },
            state
        );

        const parts = interpretStreamEvent({ choices: [{ finish_reason: "tool_calls" }] }, state);

        const toolCallParts = parts.filter((p) => p.type === "tool_call");
        assert.strictEqual(toolCallParts.length, 1, "Must still emit valid tool_calls");
        if (toolCallParts[0].type === "tool_call") {
            assert.strictEqual(toolCallParts[0].name, "good_tool");
            assert.strictEqual(toolCallParts[0].args, '{"city":"London"}');
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

    test("should deduplicate tool calls with same ID across turns", () => {
        const state = createInitialStreamingState();

        const chunk = {
            choices: [
                {
                    delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "t1", arguments: "{}" } }] },
                    finish_reason: "tool_calls",
                },
            ],
        };

        const parts1 = interpretStreamEvent(chunk, state);
        assert.strictEqual(parts1.filter((p) => p.type === "tool_call").length, 1);

        const parts2 = interpretStreamEvent(chunk, state);
        assert.strictEqual(parts2.filter((p) => p.type === "tool_call").length, 0, "Should not re-emit same ID");
    });

    test("should handle /responses format edge cases", () => {
        const state = createInitialStreamingState();

        // Reasoning delta
        const parts1 = interpretStreamEvent({ type: "response.output_reasoning.delta", delta: "thinking" }, state);
        assert.strictEqual(parts1[0].type, "thinking");

        // response.completed with partial usage
        const parts2 = interpretStreamEvent(
            {
                type: "response.completed",
                response: { usage: { input_tokens: 10 } },
            },
            state
        );
        assert.strictEqual(parts2.length, 2);
        assert.strictEqual(parts2[1].type, "data");

        // response.output_item.done
        const parts3 = interpretStreamEvent({ type: "response.output_item.done" }, state);
        assert.strictEqual(parts3[0].type, "finish");
    });

    test("should handle Gemini native format", () => {
        const state = createInitialStreamingState();
        const chunk = {
            candidates: [
                {
                    content: {
                        parts: [{ text: "hello" }],
                    },
                },
            ],
        };
        const parts = interpretStreamEvent(chunk, state);
        assert.strictEqual(parts[0].type, "text");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assert.strictEqual((parts[0] as any).value, "hello");
    });
});
