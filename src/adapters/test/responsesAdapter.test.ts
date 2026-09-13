import * as assert from "assert";
import { transformToResponsesFormat } from "../responsesAdapter";
import { normalizeToolCallId } from "../../utils";
import type { OpenAIFunctionToolDef, OpenAIChatMessage, LiteLLMResponsesContentItem } from "../../types";

suite("Responses Adapter Unit Tests", () => {
    test("transformToResponsesFormat preserves cache bypass extra_body", () => {
        const body = transformToResponsesFormat({
            model: "cache-capable-model",
            messages: [{ role: "user", content: "hello" }],
            extra_body: { cache: { "no-cache": true } },
        });

        assert.deepStrictEqual(body.extra_body, { cache: { "no-cache": true } });
    });

    test("transformToResponsesFormat preserves top-level prompt cache control", () => {
        const body = transformToResponsesFormat({
            model: "claude-opus-5",
            messages: [{ role: "user", content: "reuse this prefix" }],
            cache_control: { type: "ephemeral" },
        });

        assert.deepStrictEqual(body.cache_control, { type: "ephemeral" });
    });

    test("transformToResponsesFormat never creates a cache_control carrier object", () => {
        const body = transformToResponsesFormat({
            model: "cache-capable-model",
            messages: [{ role: "user", content: "hello" }],
            extra_body: { cache: { "no-cache": true } },
        });
        const serialized = JSON.stringify(body);

        assert.ok(!serialized.includes("cache_control"));
        assert.ok(!serialized.includes("cache-control"));
        assert.ok(!serialized.includes("$mid"));
    });

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

    test("transformToResponsesFormat preserves signed assistant thinking as reasoning input", () => {
        const body = transformToResponsesFormat({
            model: "reasoning-model",
            messages: [
                {
                    role: "assistant",
                    content: "I will continue the task.",
                    thinking_blocks: [
                        {
                            type: "thinking",
                            thinking: "I need the earlier reasoning summary.",
                            signature: "signed-thinking-state",
                        },
                    ],
                },
            ],
        });

        assert.deepStrictEqual(body.input, [
            {
                type: "message",
                role: "assistant",
                content: "I will continue the task.",
            },
            {
                type: "reasoning",
                id: "reasoning_1",
                summary: [{ type: "summary_text", text: "I need the earlier reasoning summary." }],
                encrypted_content: "signed-thinking-state",
            },
        ]);
    });

    test("transformToResponsesFormat preserves redacted thinking without exposing opaque data", () => {
        const body = transformToResponsesFormat({
            model: "reasoning-model",
            messages: [
                {
                    role: "assistant",
                    thinking_blocks: [{ type: "redacted_thinking", data: "opaque-redacted-thinking" }],
                },
            ],
        });

        assert.deepStrictEqual(body.input, [
            {
                type: "reasoning",
                id: "reasoning_0",
                summary: [],
                encrypted_content: "opaque-redacted-thinking",
            },
        ]);
        assert.ok(!JSON.stringify(body.input).includes('"thinking":"opaque-redacted-thinking"'));
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

    // ---------------------------------------------------------------------------
    // Issue #154 — Responses-native content parts.
    //
    // The Responses API (and LiteLLM's bridge for Anthropic/Bedrock/Vertex/Gemini)
    // only understands `input_text` / `input_image` / `input_file` inside
    // `input[].content[]`. Chat-Completions parts (`text` / `image_url` / `file`)
    // were previously forwarded verbatim and silently dropped by bridged providers.
    // ---------------------------------------------------------------------------

    /** Narrow a raw input item to its message shape for assertions. */
    function asMessage(item: unknown): { type: string; role: string; content: unknown } {
        const record = item as Record<string, unknown>;
        assert.strictEqual(record.type, "message");
        return record as { type: string; role: string; content: unknown };
    }

    test("transformToResponsesFormat emits ONE message with input_text + input_image for a user text+image turn (#154)", () => {
        const imageUrl = "data:image/png;base64,iVBORw0KGgo=";
        const body = transformToResponsesFormat({
            model: "claude-sonnet-4-5",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "What's in this image?" },
                        { type: "image_url", image_url: { url: imageUrl } },
                    ],
                },
            ],
        });

        assert.strictEqual(body.input.length, 1, "text + image must collapse into ONE message item");
        const message = asMessage(body.input[0]);
        assert.strictEqual(message.role, "user");
        assert.deepStrictEqual(message.content, [
            { type: "input_text", text: "What's in this image?" },
            { type: "input_image", image_url: imageUrl },
        ] satisfies LiteLLMResponsesContentItem[]);

        // `detail` is intentionally NOT emitted — LiteLLM defaults it to "auto".
        const imagePart = (message.content as Record<string, unknown>[])[1];
        assert.strictEqual("detail" in imagePart, false, "input_image must not carry a detail key");
    });

    test("transformToResponsesFormat maps a PDF file part to input_file (#154)", () => {
        const pdfUrl = "data:application/pdf;base64,JVBERi0=";
        const body = transformToResponsesFormat({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [{ type: "file", file: { filename: "document.pdf", file_data: pdfUrl } }],
                },
            ],
        });

        assert.strictEqual(body.input.length, 1);
        const message = asMessage(body.input[0]);
        assert.deepStrictEqual(message.content, [
            { type: "input_file", filename: "document.pdf", file_data: pdfUrl },
        ] satisfies LiteLLMResponsesContentItem[]);
    });

    test("transformToResponsesFormat maps assistant image_url parts to input_image (#154)", () => {
        const body = transformToResponsesFormat({
            model: "gpt-4o",
            messages: [
                { role: "user", content: [{ type: "text", text: "describe this image" }] },
                {
                    role: "assistant",
                    content: [
                        { type: "text", text: "This image shows a sunset." },
                        { type: "image_url", image_url: { url: "https://example.com/image.png" } },
                    ],
                },
            ],
        });

        const assistant = (body.input as Record<string, unknown>[]).filter(
            (i) => i.type === "message" && i.role === "assistant"
        );
        assert.strictEqual(assistant.length, 1, "assistant turn must be a single message item");
        assert.deepStrictEqual(assistant[0].content, [
            { type: "input_text", text: "This image shows a sunset." },
            { type: "input_image", image_url: "https://example.com/image.png" },
        ] satisfies LiteLLMResponsesContentItem[]);
    });

    test("transformToResponsesFormat collapses an all-text content array to a plain string (#154 regression guard)", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "first" },
                        { type: "text", text: "second" },
                    ],
                },
            ],
        });

        assert.strictEqual(body.input.length, 1);
        const message = asMessage(body.input[0]);
        assert.strictEqual(typeof message.content, "string", "all-text arrays use LiteLLM's string shortcut");
        assert.strictEqual(message.content, "first\nsecond");
    });

    test("transformToResponsesFormat preserves cache_control on an input_text part (#154)", () => {
        const body = transformToResponsesFormat({
            model: "claude-opus-5",
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "reuse this prefix", cache_control: { type: "ephemeral" } }],
                },
            ],
        });

        assert.strictEqual(body.input.length, 1);
        const message = asMessage(body.input[0]);
        // A cache-stamped text part must NOT collapse to a string — the stamp would be lost.
        assert.deepStrictEqual(message.content, [
            { type: "input_text", text: "reuse this prefix", cache_control: { type: "ephemeral" } },
        ] satisfies LiteLLMResponsesContentItem[]);
    });

    test("transformToResponsesFormat drops malformed content parts but keeps the rest (#154)", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "image_url" }, // missing image_url.url
                        { type: "file", file: { filename: "x.pdf" } }, // missing file.file_data
                        { type: "text", text: "still here" },
                        { type: "image_url", image_url: { url: "https://example.com/ok.png" } },
                    ] as unknown as string,
                },
            ],
        });

        assert.strictEqual(body.input.length, 1);
        const message = asMessage(body.input[0]);
        assert.deepStrictEqual(message.content, [
            { type: "input_text", text: "still here" },
            { type: "input_image", image_url: "https://example.com/ok.png" },
        ] satisfies LiteLLMResponsesContentItem[]);
    });

    test("transformToResponsesFormat skips a content array whose parts are all malformed (#154)", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [{ role: "user", content: [{ type: "image_url" }] }],
        });

        assert.strictEqual(body.input.length, 0);
    });

    test("transformToResponsesFormat maps max_tokens to max_output_tokens and drops chat-only params (#154)", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 123,
            frequency_penalty: 0.1,
            presence_penalty: 0.2,
            stop: ["END"],
            stream_options: { include_usage: true },
        });

        assert.strictEqual(body.max_output_tokens, 123);

        const raw = body as unknown as Record<string, unknown>;
        for (const key of ["max_tokens", "frequency_penalty", "presence_penalty", "stop", "stream_options"]) {
            assert.strictEqual(key in raw, false, `${key} is not a Responses API parameter and must not be emitted`);
        }
    });

    test("transformToResponsesFormat still forwards Responses-valid params unchanged (#154)", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [
                { role: "system", content: "sys" },
                { role: "user", content: "hi" },
            ],
            stream: true,
            temperature: 0.3,
            top_p: 0.9,
            reasoning_effort: "high",
            extra_body: { cache: { "no-cache": true } },
            cache_control: { type: "ephemeral" },
        });

        assert.strictEqual(body.stream, true);
        assert.strictEqual(body.instructions, "sys");
        assert.strictEqual(body.temperature, 0.3);
        assert.strictEqual(body.top_p, 0.9);
        assert.strictEqual(body.reasoning_effort, "high");
        assert.deepStrictEqual(body.reasoning, { effort: "high", summary: "auto" });
        assert.deepStrictEqual(body.extra_body, { cache: { "no-cache": true } });
        assert.deepStrictEqual(body.cache_control, { type: "ephemeral" });
    });

    test("transformToResponsesFormat array-wraps a lone user image as input_image (never a bare dict)", () => {
        // Historical addendum bug: LiteLLM raises ValueError: Invalid content type: <class 'dict'>
        // when content is a bare object. Content arrays are always emitted as arrays.
        const body = transformToResponsesFormat({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }],
                },
            ],
        });

        assert.strictEqual(body.input.length, 1, "Should produce one input item");
        const message = asMessage(body.input[0]);
        assert.strictEqual(message.role, "user");
        assert.ok(Array.isArray(message.content), "content must be an array, not a bare dict");
        assert.deepStrictEqual(message.content, [
            { type: "input_image", image_url: "https://example.com/image.png" },
        ] satisfies LiteLLMResponsesContentItem[]);
    });

    test("transformToResponsesFormat array-wraps a lone assistant image as input_image (never a bare dict)", () => {
        const body = transformToResponsesFormat({
            model: "gpt-4o",
            messages: [
                { role: "user", content: [{ type: "text", text: "describe this image" }] },
                {
                    role: "assistant",
                    content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }],
                },
            ],
        });

        const assistant = (body.input as Record<string, unknown>[]).find(
            (i) => i.type === "message" && i.role === "assistant"
        );
        assert.ok(assistant, "Should find assistant message");
        assert.deepStrictEqual(assistant.content, [
            { type: "input_image", image_url: "https://example.com/image.png" },
        ] satisfies LiteLLMResponsesContentItem[]);
    });

    test("transformToResponsesFormat keeps a mixed user content array as one multi-part message", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "  " }, // whitespace-only text is preserved as a part
                        { type: "text", text: "hello" },
                        { type: "image_url", image_url: { url: "https://example.com/image.png" } },
                    ] as unknown as string,
                },
            ],
        });

        // One turn → one message item (was previously exploded into three).
        assert.strictEqual(body.input.length, 1);
        const message = asMessage(body.input[0]);
        assert.strictEqual(message.role, "user");
        assert.deepStrictEqual(message.content, [
            { type: "input_text", text: "  " },
            { type: "input_text", text: "hello" },
            { type: "input_image", image_url: "https://example.com/image.png" },
        ] satisfies LiteLLMResponsesContentItem[]);
    });

    test("transformToResponsesFormat never emits chat-completions part types on /responses", () => {
        const body = transformToResponsesFormat({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "look" },
                        { type: "image_url", image_url: { url: "https://example.com/image.png" } },
                        {
                            type: "file",
                            file: { filename: "doc.pdf", file_data: "data:application/pdf;base64,JVBERi0=" },
                        },
                    ],
                },
            ],
        });

        const serialized = JSON.stringify(body.input);
        assert.ok(!serialized.includes('"type":"text"'), "chat `text` part leaked into /responses body");
        assert.ok(!serialized.includes('"type":"image_url"'), "chat `image_url` part leaked into /responses body");
        assert.ok(!serialized.includes('"type":"file"'), "chat `file` part leaked into /responses body");
    });

    test("transformToResponsesFormat handles tool message with missing id", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [{ role: "tool", content: "ok" } as unknown as OpenAIChatMessage],
        });
        // inputArray should be empty for this message
        assert.strictEqual(body.input.length, 0);
    });

    test("transformToResponsesFormat emits native reasoning with summary for a selected effort", () => {
        const body = transformToResponsesFormat({
            model: "gpt-5.6",
            messages: [{ role: "user", content: "hi" }],
            reasoning_effort: "high",
        });
        assert.strictEqual(body.reasoning_effort, "high");
        // summary:"auto" is required for OpenAI o-series/gpt-5 to return any
        // reasoning summary text on /responses (issue #149).
        assert.deepStrictEqual(body.reasoning, { effort: "high", summary: "auto" });
    });

    test("transformToResponsesFormat preserves explicit adaptive Claude fields", () => {
        const body = transformToResponsesFormat({
            model: "claude-opus-5",
            messages: [{ role: "user", content: "hi" }],
            reasoning_effort: "high",
            thinking: { type: "adaptive" },
            output_config: { effort: "high" },
        });

        assert.deepStrictEqual(body.thinking, { type: "adaptive" });
        assert.deepStrictEqual(body.output_config, { effort: "high" });
        assert.strictEqual(body.reasoning, undefined);
    });

    test("transformToResponsesFormat omits native reasoning for none", () => {
        const body = transformToResponsesFormat({
            model: "gpt-5.6",
            messages: [{ role: "user", content: "hi" }],
            reasoning_effort: "none",
        });

        assert.strictEqual(body.reasoning_effort, "none");
        assert.strictEqual(body.reasoning, undefined);
    });

    test("transformToResponsesFormat omits reasoning_effort when source request did not set it", () => {
        const body = transformToResponsesFormat({
            model: "m",
            messages: [{ role: "user", content: "hi" }],
        });
        assert.strictEqual(body.reasoning_effort, undefined);
    });

    // Regression: bug #98 — inline-edit caller with image content sent to /responses endpoint.
    //
    // The inline-edit workflow produces large multi-turn conversations that include
    // image_url content items (e.g. editor screenshots). Before the fix, the responses
    // adapter set `content: contentItem` (a bare object) instead of `content: [contentItem]`
    // (an array), causing Azure to reject the request with:
    //   "Invalid type for 'input[N].content': expected one of an array of objects or string,
    //    but got an object instead."
    //
    // This test builds a representative inline-edit session — system prompt, several
    // user/assistant turns, one turn carrying an image, a tool invocation, and a final
    // edit request — and asserts that every message-type input item produced by the
    // adapter carries content that is either a string or an array, never a bare object.
    test("transformToResponsesFormat inline-edit session with image content never produces bare-object content (bug #98)", () => {
        const imageUrl =
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

        const body = transformToResponsesFormat({
            model: "gpt-5.3-codex",
            reasoning_effort: "medium",
            messages: [
                // Turn 0: system prompt
                { role: "system", content: "You are a helpful inline code editor." },
                // Turn 1: user sends a plain text description
                { role: "user", content: "Please refactor this function to be more readable." },
                // Turn 2: assistant responds with text
                { role: "assistant", content: "Sure, here is the refactored version:" },
                // Turn 3: user sends a follow-up with an image (editor screenshot) alongside text — the
                // combination that triggers the inline-edit image path and previously produced a bare dict
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Here is a screenshot of the current code:" },
                        { type: "image_url", image_url: { url: imageUrl } },
                    ],
                },
                // Turn 4: assistant invokes a tool
                {
                    role: "assistant",
                    content: null as unknown as string,
                    tool_calls: [
                        {
                            id: "call_abc123",
                            type: "function",
                            function: { name: "read_file", arguments: '{"path":"src/utils.ts"}' },
                        },
                    ],
                },
                // Turn 5: tool result
                { role: "tool", tool_call_id: "call_abc123", content: "export function foo() { return 42; }" },
                // Turn 6: assistant text reply
                { role: "assistant", content: "I have read the file. Here is the improved version:" },
                // Turn 7: user sends final edit instruction with another image
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Apply this change to the highlighted region." },
                        { type: "image_url", image_url: { url: imageUrl } },
                    ],
                },
            ],
        });

        const input = body.input as Record<string, unknown>[];

        // Every message-type item must carry content that is a string or an array.
        // A bare object (typeof === "object" && !Array.isArray) is the invalid shape
        // that Azure rejects and that was produced by the pre-fix adapter code.
        const invalidItems = input.filter((item) => {
            if (item.type !== "message") {
                return false;
            }
            const content = item.content;
            return content !== null && typeof content === "object" && !Array.isArray(content);
        });

        assert.strictEqual(
            invalidItems.length,
            0,
            `Found ${invalidItems.length} message item(s) with bare-object content — Azure will reject these. ` +
                `Offending items: ${JSON.stringify(invalidItems, null, 2)}`
        );

        // Additionally verify the two image-bearing user turns each produce ONE message whose
        // content array carries the accompanying text as `input_text` and the screenshot as
        // `input_image` (issue #154 — Responses-native part types).
        const imageBearingMessages = input.filter(
            (item) =>
                item.type === "message" &&
                Array.isArray(item.content) &&
                (item.content as Record<string, unknown>[]).some((c) => c.type === "input_image")
        );
        assert.strictEqual(
            imageBearingMessages.length,
            2,
            `Expected exactly 2 image-bearing message items (one per user image turn), got ${imageBearingMessages.length}`
        );

        const expectedTexts = [
            "Here is a screenshot of the current code:",
            "Apply this change to the highlighted region.",
        ];
        imageBearingMessages.forEach((msg, index) => {
            assert.strictEqual(msg.role, "user");
            assert.deepStrictEqual(msg.content, [
                { type: "input_text", text: expectedTexts[index] },
                { type: "input_image", image_url: imageUrl },
            ] satisfies LiteLLMResponsesContentItem[]);
        });

        // Layout sanity: 7 input items — user, assistant, user(text+image), function_call,
        // function_call_output, assistant, user(text+image). The system prompt becomes `instructions`.
        assert.strictEqual(input.length, 7, `Unexpected input layout: ${JSON.stringify(input.map((i) => i.type))}`);
        assert.strictEqual(body.instructions, "You are a helpful inline code editor.");

        // Sanity-check: function_call and function_call_output items are present and correctly linked.
        const functionCall = input.find((i) => i.type === "function_call") as Record<string, unknown> | undefined;
        const functionOutput = input.find((i) => i.type === "function_call_output") as
            Record<string, unknown> | undefined;
        assert.ok(functionCall, "function_call item must be present");
        assert.ok(functionOutput, "function_call_output item must be present");
        assert.strictEqual(functionCall.call_id, functionOutput.call_id, "call_id must match between call and output");
    });
});
