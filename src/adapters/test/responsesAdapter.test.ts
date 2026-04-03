import * as assert from "assert";
import { transformToResponsesFormat } from "../responsesAdapter";
import { normalizeToolCallId } from "../../utils";
import type { OpenAIFunctionToolDef } from "../../types";

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

    test("transformToResponsesFormat handles tool call with missing id field", () => {
        // Since we map tool call IDs from assistant messages, we need to test how it handles a missing/undefined ID
        // Although the type says ID is required, runtime could be different.
        const body = transformToResponsesFormat({
            model: "m",
            messages: [
                {
                    role: "assistant",
                    tool_calls: [
                        {
                            id: undefined as unknown as string,
                            type: "function",
                            function: { name: "do", arguments: "{}" },
                        },
                    ],
                },
            ],
        });

        const input = body.input as Record<string, unknown>[];
        // find function_call item
        const fc = input.find((i) => i.type === "function_call");
        assert.ok(
            fc && typeof fc.id === "string" && fc.id.startsWith("fc_"),
            "Should generate a fallback ID starting with fc_"
        );
    });

    test("transformToResponsesFormat wraps non-string tool content", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [{ role: "tool", tool_call_id: "c1", content: { result: "ok" } as unknown as string }],
        });

        const input = body.input as { output?: string }[];
        assert.strictEqual(input[1].output, JSON.stringify({ result: "ok" }));
    });

    test("transformToResponsesFormat handles system message as instructions", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [
                { role: "system", content: "You are helpful" },
                { role: "user", content: "hi" },
            ],
        });

        assert.strictEqual(body.instructions, "You are helpful");
        assert.strictEqual(body.input.length, 1);
    });

    test("transformToResponsesFormat handles array content in user messages", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [{ role: "user", content: [{ type: "text", text: "hello" }] as unknown as string }],
        });

        const item = body.input[0] as { content?: string };
        assert.strictEqual(item.content, "hello");
    });

    test("transformToResponsesFormat filters out invalid tools", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [],
            tools: [
                { type: "function", function: { name: "", parameters: {} } }, // invalid name
                { type: "function", function: { name: "valid", parameters: {} } },
            ] as unknown as OpenAIFunctionToolDef[],
        });

        assert.strictEqual(body.tools?.length, 1);
        assert.strictEqual(body.tools?.[0].name, "valid");
    });
});
