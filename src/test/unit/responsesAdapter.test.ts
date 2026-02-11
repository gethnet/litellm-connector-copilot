import * as assert from "assert";
import { transformToResponsesFormat } from "../../adapters/responsesAdapter";
import { normalizeToolCallId } from "../../utils";

suite("Responses Adapter Unit Tests", () => {
    test("transformToResponsesFormat normalizes tool call IDs", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [
                {
                    role: "assistant",
                    tool_calls: [{ id: "call1", type: "function", function: { name: "do", arguments: "{}" } }],
                },
                { role: "tool", tool_call_id: "call1", content: "ok" },
            ],
        });

        const input = body.input as Record<string, unknown>[];
        const functionCall = input.find((i) => i.type === "function_call");
        const functionOutput = input.find((i) => i.type === "function_call_output");

        assert.strictEqual(functionCall?.id, normalizeToolCallId("call1"));
        assert.strictEqual(functionOutput?.call_id, normalizeToolCallId("call1"));
    });

    test("transformToResponsesFormat synthesizes function_call for orphaned outputs", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [
                { role: "user", content: "hello" },
                { role: "tool", tool_call_id: "orphaned_id", content: "result" },
            ],
        });

        const input = body.input as Record<string, unknown>[];
        const functionCall = input.find((i) => i.type === "function_call");
        const functionOutput = input.find((i) => i.type === "function_call_output");

        assert.ok(functionCall, "Should have synthesized a function_call");
        assert.strictEqual(functionCall?.id, normalizeToolCallId("orphaned_id"));
        assert.strictEqual(functionOutput?.call_id, normalizeToolCallId("orphaned_id"));
    });

    test("transformToResponsesFormat skips empty messages", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [
                { role: "user", content: "" },
                { role: "assistant", content: "  " },
                { role: "user", content: "hello" },
            ],
        });

        const input = body.input as Record<string, unknown>[];
        assert.strictEqual(input.length, 1);
        assert.strictEqual(input[0].content, "hello");
    });

    test("transformToResponsesFormat handles conversation history when switching models", () => {
        const body = transformToResponsesFormat({
            model: "new-model",
            messages: [
                { role: "user", content: "Use the tool" },
                {
                    role: "assistant",
                    tool_calls: [
                        { id: "call_123", type: "function", function: { name: "get_info", arguments: '{"x":1}' } },
                    ],
                },
                { role: "tool", tool_call_id: "call_123", content: "tool result" },
                { role: "user", content: "Thanks, now use it again" },
                {
                    role: "assistant",
                    tool_calls: [
                        { id: "call_456", type: "function", function: { name: "get_info", arguments: '{"y":2}' } },
                    ],
                },
                { role: "tool", tool_call_id: "call_456", content: "another result" },
            ],
        });

        const input = body.input as Record<string, unknown>[];
        const toolCalls = input.filter((i) => i.type === "function_call");
        assert.strictEqual(toolCalls.length, 2);
        assert.strictEqual(toolCalls[0].id, normalizeToolCallId("call_123"));
        assert.strictEqual(toolCalls[1].id, normalizeToolCallId("call_456"));

        const toolOutputs = input.filter((i) => i.type === "function_call_output");
        assert.strictEqual(toolOutputs.length, 2);
        assert.strictEqual(toolOutputs[0].call_id, normalizeToolCallId("call_123"));
        assert.strictEqual(toolOutputs[1].call_id, normalizeToolCallId("call_456"));
    });

    test("transformToResponsesFormat shrinks overlong tool call IDs to <= 40 chars", () => {
        const longId = "x".repeat(42);
        const body = transformToResponsesFormat({
            model: "m",
            messages: [
                {
                    role: "assistant",
                    tool_calls: [{ id: longId, type: "function", function: { name: "do", arguments: "{}" } }],
                },
                { role: "tool", tool_call_id: longId, content: "ok" },
            ],
        });

        const expected = normalizeToolCallId(longId);
        assert.ok(expected.length <= 40);

        const input = body.input as Record<string, unknown>[];
        const allIds = input
            .filter((i) => i.type === "function_call" || i.type === "function_call_output")
            .flatMap((i) => [i.id, i.call_id])
            .filter((x): x is string => typeof x === "string");

        assert.ok(allIds.includes(expected));
        assert.ok(allIds.every((x) => x.length <= 40));
    });
});
