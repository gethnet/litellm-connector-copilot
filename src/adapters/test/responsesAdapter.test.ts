import * as assert from "assert";
import { transformToResponsesFormat } from "../responsesAdapter";
import { normalizeToolCallId } from "../../utils";
import type { OpenAIFunctionToolDef, OpenAIChatMessage, LiteLLMResponseInputItem } from "../../types";

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

    test("transformToResponsesFormat shrinks overlong tool call IDs to <= 42 chars", () => {
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
        assert.ok(expected.length <= 42);

        const input = body.input as Record<string, unknown>[];
        const allIds = input
            .filter((i) => i.type === "function_call" || i.type === "function_call_output")
            .flatMap((i) => [i.id, i.call_id])
            .filter((x): x is string => typeof x === "string");

        assert.ok(allIds.includes(expected));
        assert.ok(allIds.every((x) => x.length <= 42));
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

    test("transformToResponsesFormat handles assistant with both text and tool calls", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [
                {
                    role: "assistant",
                    content: "Thought: I should use a tool.",
                    tool_calls: [{ id: "c1", type: "function", function: { name: "t1", arguments: "{}" } }],
                },
            ],
        });

        const input = body.input as Record<string, unknown>[];
        assert.strictEqual(input.length, 2);
        assert.strictEqual(input[0].type, "message");
        assert.strictEqual(input[0].content, "Thought: I should use a tool.");
        assert.strictEqual(input[1].type, "function_call");
    });

    test("transformToResponsesFormat synthesizes name from tool definitions", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [{ role: "tool", tool_call_id: "orphaned", content: "ok" }],
            tools: [{ type: "function", function: { name: "my_tool", parameters: {} } }],
        });

        const input = body.input as Record<string, unknown>[];
        assert.strictEqual(input[0].type, "function_call");
        assert.strictEqual(input[0].name, "my_tool");
    });

    test("transformToResponsesFormat handles system message with array content", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [{ role: "system", content: [{ type: "text", text: "sys" }] as unknown as string }],
        });
        // System messages with content arrays should extract text from items
        assert.strictEqual(body.instructions, "sys");
    });

    test("transformToResponsesFormat wraps user image_url content item in array (not bare dict)", () => {
        // Reproduces addendum bug: LiteLLM raises ValueError: Invalid content type: <class 'dict'>
        // when content is a bare object. The fix is to wrap it in an array.
        const body = transformToResponsesFormat({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }],
                },
            ],
        });

        const input = body.input as Record<string, unknown>[];
        assert.strictEqual(input.length, 1, "Should produce one input item");
        const item = input[0];
        assert.strictEqual(item.type, "message");
        assert.strictEqual(item.role, "user");
        // content must be an ARRAY, not a bare object
        assert.ok(Array.isArray(item.content), "content must be an array, not a bare dict");
        const content = item.content as Record<string, unknown>[];
        assert.strictEqual(content.length, 1);
        assert.strictEqual(content[0].type, "image_url");
        assert.deepStrictEqual(content[0].image_url, { url: "https://example.com/image.png" });
    });

    test("transformToResponsesFormat wraps assistant image_url content item in array (not bare dict)", () => {
        // Companion to the user image test — assistant vision messages have the same bug
        const body = transformToResponsesFormat({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "describe this image" }],
                },
                {
                    role: "assistant",
                    content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }],
                },
            ],
        });

        const input = body.input as Record<string, unknown>[];
        const imageMessage = input.find(
            (i) => i.type === "message" && (i as Record<string, unknown>).role === "assistant"
        );
        assert.ok(imageMessage, "Should find assistant message");
        assert.ok(Array.isArray((imageMessage as Record<string, unknown>).content), "content must be an array");
        const content = (imageMessage as Record<string, unknown>).content as Record<string, unknown>[];
        assert.strictEqual(content[0].type, "image_url");
    });

    test("transformToResponsesFormat handles user message with mixed array content", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "  " }, // whitespace only
                        { type: "text", text: "hello" },
                        { type: "image_url", image_url: { url: "https://example.com/image.png" } }, // not text
                    ] as unknown as string,
                },
            ],
        });
        // Each content item is unpacked into the input array as LiteLLMResponseInputItem
        assert.strictEqual(body.input.length, 3);

        // First item: text message (type="message" because it's wrapped in response format)
        const whitespaceMessage = body.input[0];
        assert.strictEqual(whitespaceMessage.type, "message");
        assert.strictEqual(whitespaceMessage.role, "user");
        assert.strictEqual(whitespaceMessage.content, "  "); // text content is unpacked string

        // Second item: text message
        const textMessage = body.input[1];
        assert.strictEqual(textMessage.type, "message");
        assert.strictEqual(textMessage.role, "user");
        assert.strictEqual(textMessage.content, "hello");

        // Third item: image_url message — content must be an ARRAY (not a bare dict)
        const imageMessage = body.input[2] as LiteLLMResponseInputItem;
        assert.strictEqual(imageMessage.type, "message");
        assert.strictEqual(imageMessage.role, "user");
        const content = imageMessage.content as unknown as Record<string, unknown>[];
        assert.ok(Array.isArray(content), "image_url content must be array-wrapped");
        assert.strictEqual(content[0].type, "image_url");
        assert.deepStrictEqual(content[0].image_url, { url: "https://example.com/image.png" });
    });

    test("transformToResponsesFormat preserves image_url content in user messages", () => {
        const body = transformToResponsesFormat({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "What's in this image?" },
                        { type: "image_url", image_url: { url: "https://example.com/image.png" } },
                    ],
                },
            ],
        });

        const input = body.input as Record<string, unknown>[];
        // Should have both text message and image message
        assert.ok(input.length >= 2, `Expected at least 2 input items, got ${input.length}`);

        const textMessage = input.find(
            (i) => i.type === "message" && (i as Record<string, unknown>).content === "What's in this image?"
        );
        const imageMessage = input.find(
            (i) =>
                i.type === "message" &&
                (i as Record<string, unknown>).role === "user" &&
                typeof (i as Record<string, unknown>).content === "object"
        );

        assert.ok(textMessage, "Text message should be preserved");
        assert.ok(imageMessage, "Image message should be preserved");
        assert.ok(
            Array.isArray((imageMessage as Record<string, unknown>).content),
            "image_url message content must be an array"
        );
    });

    test("transformToResponsesFormat preserves image_url content in assistant messages", () => {
        const body = transformToResponsesFormat({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "describe this image" }],
                },
                {
                    role: "assistant",
                    content: [
                        { type: "text", text: "This image shows a sunset." },
                        { type: "image_url", image_url: { url: "https://example.com/image.png" } },
                    ],
                },
            ],
        });

        const input = body.input as Record<string, unknown>[];
        // Should have both text message and image message
        assert.ok(input.length >= 2, `Expected at least 2 input items, got ${input.length}`);

        const textMessage = input.find(
            (i) => i.type === "message" && (i as Record<string, unknown>).role === "assistant"
        );
        const imageMessage = input.find(
            (i) =>
                i.type === "message" &&
                (i as Record<string, unknown>).role === "assistant" &&
                typeof (i as Record<string, unknown>).content === "object"
        );

        assert.ok(textMessage, "Assistant text message should be preserved");
        assert.ok(imageMessage, "Assistant image message should be preserved");
        assert.ok(
            Array.isArray((imageMessage as Record<string, unknown>).content),
            "assistant image_url message content must be an array"
        );
    });

    test("transformToResponsesFormat handles tool message with missing id", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [{ role: "tool", content: "ok" } as unknown as OpenAIChatMessage],
        });
        // inputArray should be empty for this message
        assert.strictEqual(body.input.length, 0);
    });

    test("transformToResponsesFormat propagates reasoning_effort verbatim", () => {
        // We deliberately use a single canonical request shape across endpoints.
        // LiteLLM accepts the flat `reasoning_effort` key on /responses just as it
        // does on /chat/completions, so the adapter passes it through unchanged
        // rather than translating into a nested `reasoning: { effort }` shape.
        const body = transformToResponsesFormat({
            model: "m",
            messages: [{ role: "user", content: "hi" }],
            reasoning_effort: "high",
        });
        assert.strictEqual(body.reasoning_effort, "high");
    });

    test("transformToResponsesFormat omits reasoning_effort when source request did not set it", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [{ role: "user", content: "hi" }],
        });
        assert.strictEqual(body.reasoning_effort, undefined);
    });
});
