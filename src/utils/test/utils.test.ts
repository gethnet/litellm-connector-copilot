import * as assert from "assert";
import * as vscode from "vscode";
import {
    convertMessages,
    convertTools,
    isToolResultPart,
    normalizeToolCallId,
    stripMarkdownCodeBlocks,
    tryParseJSONObject,
    validateRequest,
    validateTools,
    normalizeMessagesForV2Pipeline,
    convertV2MessagesToProviderMessages,
    convertV2MessagesToTransportMessages,
    convertV2MessagesToOpenAI,
    validateV2Messages,
} from "../../utils";
import type { OpenAIChatMessage } from "../../types";

suite("Utility Unit Tests", () => {
    test("normalizeToolCallId handles edge cases", () => {
        // Empty ID
        assert.ok(normalizeToolCallId("").startsWith("fc_"));

        // Already valid ID
        assert.strictEqual(normalizeToolCallId("fc_abc"), "fc_abc");

        // Too long ID starting with fc_
        const longFc = "fc_" + "a".repeat(50);
        const normFc = normalizeToolCallId(longFc);
        assert.ok(normFc.length <= 40);
        assert.ok(normFc.startsWith("fc_"));

        // ID with prefix call_ or tc_
        assert.ok(normalizeToolCallId("call_abc").startsWith("fc_abc_"));
        assert.ok(normalizeToolCallId("tc_abc").startsWith("fc_abc_"));

        // ID with special characters
        assert.ok(normalizeToolCallId("some!@#id").startsWith("fc_some___id_"));
    });

    test("stripMarkdownCodeBlocks handles various formats", () => {
        assert.strictEqual(stripMarkdownCodeBlocks("just text"), "just text");
        assert.strictEqual(stripMarkdownCodeBlocks("```\ncontent\n```"), "content");
        assert.strictEqual(stripMarkdownCodeBlocks("```python\nprint(1)\n```"), "print(1)");
        assert.strictEqual(stripMarkdownCodeBlocks("```\na\n```\n\n```\nb\n```"), "a\n\nb");

        // Backticks but no complete block
        assert.strictEqual(stripMarkdownCodeBlocks("text with `backticks`"), "text with `backticks`");
    });

    test("convertMessages handles text and images", () => {
        const imgData = new Uint8Array(Buffer.from("abc"));
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelTextPart("see this"),
                    vscode.LanguageModelDataPart.image(imgData, "image/png"),
                ],
                name: undefined,
            },
        ];

        const out = convertMessages(messages) as unknown as Record<string, unknown>[];
        assert.strictEqual(out.length, 1);
        const content = out[0].content as unknown[];
        assert.ok(Array.isArray(content));
        assert.strictEqual((content[0] as { type: string }).type, "text");
        assert.strictEqual((content[0] as { text: string }).text, "see this");
        assert.strictEqual((content[1] as { type: string }).type, "image_url");
        const url = (content[1] as { image_url: { url: string } }).image_url.url;
        assert.ok(url.startsWith("data:image/png;base64,"));
    });

    test("convertMessages emits tool calls and tool results", () => {
        const callId = "call-1";
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [
                    new vscode.LanguageModelTextPart("do"),
                    new vscode.LanguageModelToolCallPart(callId, "run", { x: 1 }),
                ],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok"), { a: 2 }]),
                ],
                name: undefined,
            },
        ];

        const out = convertMessages(messages) as Array<{
            role: string;
            content: unknown;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
            tool_call_id?: string;
        }>;
        assert.strictEqual(out.length, 2);
        const assistant = out[0];
        assert.strictEqual(assistant.role, "assistant");
        assert.ok(Array.isArray(assistant.tool_calls));
        assert.strictEqual(assistant.tool_calls[0].function.name, "run");
        assert.strictEqual(assistant.tool_calls[0].function.arguments, '{"x":1}');

        // Verify the new fc_ prefix normalization
        assert.ok(
            assistant.tool_calls[0].id.startsWith("fc_"),
            `Expected ID to start with fc_, got ${assistant.tool_calls[0].id}`
        );

        const toolResult = out[1];
        assert.strictEqual(toolResult.role, "tool");
        // The tool_call_id should match the normalized ID from the assistant message
        assert.strictEqual(toolResult.tool_call_id, assistant.tool_calls[0].id);
        assert.strictEqual(toolResult.content, 'ok{"a":2}');
    });

    test("convertMessages maps user/assistant text", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelTextPart("hello")],
                name: undefined,
            },
        ];
        const out = convertMessages(messages) as unknown as Record<string, unknown>[];
        assert.deepEqual(out, [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
        ]);
    });

    test("convertMessages defaults unknown roles to system", () => {
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                // Force an unknown role value to exercise the default branch.
                role: "weird" as unknown as vscode.LanguageModelChatMessageRole,
                content: [new vscode.LanguageModelTextPart("sys")],
                name: undefined,
            },
        ];
        const out = convertMessages(messages) as unknown as Array<{ role: string; content: unknown }>;
        assert.strictEqual(out[0].role, "system");
        assert.strictEqual(out[0].content, "sys");
    });

    test("convertMessages emits assistant tool call even without text", () => {
        const callId = "call-2";
        const messages: vscode.LanguageModelChatMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart(callId, "run", { x: 1 })],
                name: undefined,
            },
        ];

        const out = convertMessages(messages) as Array<{ role: string; tool_calls?: Array<{ id: string }> }>;
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].role, "assistant");
        assert.ok(Array.isArray(out[0].tool_calls));
        assert.strictEqual(out[0].tool_calls?.length, 1);
        assert.ok(out[0].tool_calls?.[0].id.startsWith("fc_"));
    });

    test("validateRequest throws when tool call is followed by non-user message", () => {
        const callId = "abc";
        const toolCall = new vscode.LanguageModelToolCallPart(callId, "toolA", { q: 1 });
        const invalid: vscode.LanguageModelChatMessage[] = [
            { role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
            // Next message is assistant (should be user tool result)
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelTextPart("x")],
                name: undefined,
            },
        ];
        assert.throws(() => validateRequest(invalid));
    });

    test("convertTools throws when ToolMode.Required with multiple tools", () => {
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "t1", description: "", inputSchema: {} },
            { name: "t2", description: "", inputSchema: {} },
        ];
        assert.throws(() =>
            convertTools({ tools, toolMode: vscode.LanguageModelChatToolMode.Required, requestInitiator: "test" })
        );
    });

    test("tryParseJSONObject handles valid and invalid JSON", () => {
        assert.deepEqual(tryParseJSONObject('{"a":1}'), { ok: true, value: { a: 1 } });
        assert.deepEqual(tryParseJSONObject("[1,2,3]"), { ok: false });
        assert.deepEqual(tryParseJSONObject("not json"), { ok: false });
    });

    test("validateTools rejects invalid names", () => {
        const badTools: vscode.LanguageModelChatTool[] = [{ name: "bad name!", description: "", inputSchema: {} }];
        assert.throws(() => validateTools(badTools));
    });

    test("validateRequest enforces tool result pairing", () => {
        const callId = "xyz";
        const toolCall = new vscode.LanguageModelToolCallPart(callId, "toolA", { q: 1 });
        const toolRes = new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok")]);
        const valid: vscode.LanguageModelChatMessage[] = [
            { role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
            { role: vscode.LanguageModelChatMessageRole.User, content: [toolRes], name: undefined },
        ];
        assert.doesNotThrow(() => validateRequest(valid));

        const invalid: vscode.LanguageModelChatMessage[] = [
            { role: vscode.LanguageModelChatMessageRole.Assistant, content: [toolCall], name: undefined },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("missing")],
                name: undefined,
            },
        ];
        assert.throws(() => validateRequest(invalid));
    });

    test("validateRequest with multiple tool calls requires matching results", () => {
        const callA = new vscode.LanguageModelToolCallPart("a", "ta", {});
        const callB = new vscode.LanguageModelToolCallPart("b", "tb", {});
        const resA = new vscode.LanguageModelToolResultPart("a", [new vscode.LanguageModelTextPart("ra")]);
        const resB = new vscode.LanguageModelToolResultPart("b", [new vscode.LanguageModelTextPart("rb")]);
        const valid: vscode.LanguageModelChatMessage[] = [
            { role: vscode.LanguageModelChatMessageRole.Assistant, content: [callA, callB], name: undefined },
            { role: vscode.LanguageModelChatMessageRole.User, content: [resA, resB], name: undefined },
        ];
        assert.doesNotThrow(() => validateRequest(valid));

        const missing: vscode.LanguageModelChatMessage[] = [
            { role: vscode.LanguageModelChatMessageRole.Assistant, content: [callA, callB], name: undefined },
            { role: vscode.LanguageModelChatMessageRole.User, content: [resA], name: undefined },
        ];
        assert.throws(() => validateRequest(missing));
    });

    test("convertTools sanitizes names and schemas and enforces Required mode", () => {
        const tools: vscode.LanguageModelChatTool[] = [
            {
                name: "-bad name",
                description: "",
                inputSchema: {
                    type: "object",
                    properties: {
                        user_id: { type: "number", additionalProperties: { foo: "bar" } },
                        choice: { anyOf: [{ type: "string" }, { type: "object", custom: true }] },
                        extra: { type: "object", required: ["a", 7], properties: {} },
                    },
                    required: ["user_id", 5],
                    title: "ignored",
                },
            },
        ];

        const res = convertTools({
            tools,
            toolMode: vscode.LanguageModelChatToolMode.Required,
            requestInitiator: "test",
        });
        assert.ok(res.tools);
        assert.strictEqual(res.tools?.length, 1);
        assert.strictEqual(res.tools?.[0].function.name, "tool_-bad_name");
        const params = res.tools?.[0].function.parameters as {
            properties: Record<string, { type?: string; [key: string]: unknown }>;
            required: string[];
        };
        const userId = params.properties.user_id;
        assert.strictEqual(userId.type, "integer");
        assert.deepStrictEqual(params.required, ["user_id"]);
        const choice = params.properties.choice;
        assert.strictEqual(choice.type, "string");
        assert.ok(!("custom" in choice));
        const extra = params.properties.extra;
        assert.deepStrictEqual(extra.required, ["a"]);
        assert.ok(res.tool_choice && typeof res.tool_choice !== "string");
        assert.strictEqual(res.tool_choice?.function.name, "tool_-bad_name");
    });

    test("convertTools returns empty when no tools", () => {
        const res = convertTools({
            tools: [],
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            requestInitiator: "test",
        });
        assert.deepStrictEqual(res, {});
    });

    test("isToolResultPart type guard", () => {
        assert.ok(isToolResultPart({ callId: "x", content: [] }));
        assert.ok(!isToolResultPart({ callId: 1 }));
        assert.ok(!isToolResultPart({}));
    });

    test("tryParseJSONObject rejects empty and arrays", () => {
        assert.deepStrictEqual(tryParseJSONObject(""), { ok: false });
        assert.deepStrictEqual(tryParseJSONObject("[]"), { ok: false });
    });

    test("validateRequest handles edge cases", () => {
        // No messages
        assert.throws(() => validateRequest([]));

        // Empty message content list
        assert.throws(() =>
            validateRequest([{ role: vscode.LanguageModelChatMessageRole.User, content: [], name: undefined }])
        );
    });

    test("convertMessages handles various data parts", () => {
        const jsonPart = new vscode.LanguageModelDataPart(Buffer.from('{"a":1}'), "application/json");
        const textPart = new vscode.LanguageModelDataPart(Buffer.from("extra text"), "text/plain");
        const cachePart = new vscode.LanguageModelDataPart(Buffer.from("cache"), "cache_control");

        const msgs = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [jsonPart, textPart, cachePart],
                name: undefined,
            },
        ];

        const out = convertMessages(msgs) as unknown as OpenAIChatMessage[];
        assert.strictEqual(out.length, 1);
        assert.ok(out[0].content?.toString().includes('{"a":1}'));
        assert.ok(out[0].content?.toString().includes("extra text"));
    });

    test("convertMessages handles tool call with missing id and input", () => {
        const toolCall = new vscode.LanguageModelToolCallPart("", "mytool", undefined as unknown as object);
        const msgs = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [toolCall],
                name: undefined,
            },
        ];

        const out = convertMessages(msgs) as unknown as OpenAIChatMessage[];
        assert.ok(out[0].tool_calls?.[0].id.startsWith("fc_"));
        assert.strictEqual(out[0].tool_calls?.[0].function.arguments, "{}");
    });

    test("V2 pipeline utility functions", () => {
        const v2Msgs = normalizeMessagesForV2Pipeline([
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelTextPart("hi"),
                    new vscode.LanguageModelDataPart(Buffer.from("data"), "text/plain"),
                ],
                name: "user1",
            } as unknown as vscode.LanguageModelChatMessage,
        ]);

        assert.strictEqual(v2Msgs.length, 1);
        assert.strictEqual(v2Msgs[0].role, "user");
        assert.strictEqual(v2Msgs[0].content.length, 2);

        const providerMsgs = convertV2MessagesToProviderMessages(v2Msgs);
        assert.strictEqual(providerMsgs.length, 1);
        assert.ok(providerMsgs[0].content[1] instanceof vscode.LanguageModelDataPart);

        const transportMsgs = convertV2MessagesToTransportMessages(v2Msgs);
        assert.strictEqual(transportMsgs.length, 1);
        assert.ok(transportMsgs[0].content[1] instanceof vscode.LanguageModelTextPart);

        assert.doesNotThrow(() => validateV2Messages(v2Msgs));
    });

    test("V2 pipeline handles tool calls and results", () => {
        const v2Msgs = normalizeMessagesForV2Pipeline([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart("c1", "t1", { a: 1 })],
                name: "assistant",
            } as unknown as vscode.LanguageModelChatMessage,
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelToolResultPart("c1", ["ok"])],
                name: "user",
            } as unknown as vscode.LanguageModelChatMessage,
        ]);

        assert.strictEqual(v2Msgs[0].content[0].type, "tool_call");
        assert.strictEqual(v2Msgs[1].content[0].type, "tool_result");

        const openai = convertV2MessagesToOpenAI(v2Msgs);
        assert.strictEqual(openai[0].role, "assistant");
        assert.ok(openai[0].tool_calls);
        assert.strictEqual(openai[1].role, "tool");
    });

    test("V2 validation allows tool results followed by adjacent user text", () => {
        const v2Msgs = normalizeMessagesForV2Pipeline([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart("write-1", "write_file", { path: "src/example.ts" })],
                name: "assistant",
            } as unknown as vscode.LanguageModelChatMessage,
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart("write-1", ["Wrote src/example.ts"]),
                    new vscode.LanguageModelTextPart("The file write completed successfully."),
                ],
                name: "user",
            } as unknown as vscode.LanguageModelChatMessage,
        ]);

        assert.doesNotThrow(() => validateV2Messages(v2Msgs));
    });

    test("V2 conversion keeps tool result before adjacent trailing text", () => {
        const v2Msgs = normalizeMessagesForV2Pipeline([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart("write-2", "write_file", { path: "src/example.ts" })],
                name: "assistant",
            } as unknown as vscode.LanguageModelChatMessage,
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart("write-2", ["Wrote src/example.ts"]),
                    new vscode.LanguageModelTextPart("No follow-up read is required."),
                ],
                name: "user",
            } as unknown as vscode.LanguageModelChatMessage,
        ]);

        const openai = convertV2MessagesToOpenAI(v2Msgs);

        assert.strictEqual(openai.length, 3);
        assert.strictEqual(openai[0].role, "assistant");
        assert.ok(openai[0].tool_calls);
        assert.strictEqual(openai[1].role, "tool");
        assert.strictEqual(openai[1].content, "Wrote src/example.ts");
        assert.strictEqual(openai[2].role, "user");
        assert.strictEqual(openai[2].content, "No follow-up read is required.");
    });

    test("V2 conversion serializes structured tool results without flat concatenation", () => {
        const v2Msgs = normalizeMessagesForV2Pipeline([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new vscode.LanguageModelToolCallPart("write-3", "write_file", { path: "src/example.ts" })],
                name: "assistant",
            } as unknown as vscode.LanguageModelChatMessage,
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [
                    new vscode.LanguageModelToolResultPart("write-3", [
                        new vscode.LanguageModelTextPart("write result"),
                        { status: "success", path: "src/example.ts", bytesWritten: 42 },
                    ]),
                ],
                name: "user",
            } as unknown as vscode.LanguageModelChatMessage,
        ]);

        const openai = convertV2MessagesToOpenAI(v2Msgs);
        const toolContent = openai[1].content;

        assert.strictEqual(typeof toolContent, "string");
        assert.notStrictEqual(
            toolContent,
            'write result{"status":"success","path":"src/example.ts","bytesWritten":42}'
        );

        const parsed = JSON.parse(toolContent as string) as {
            type: string;
            content: Array<{ type: string; text?: string; value?: unknown }>;
        };
        assert.strictEqual(parsed.type, "tool_result");
        assert.deepStrictEqual(parsed.content[0], { type: "text", text: "write result" });
        assert.deepStrictEqual(parsed.content[1], {
            type: "json",
            value: { status: "success", path: "src/example.ts", bytesWritten: 42 },
        });
    });

    test("V2 pipeline handles thinking parts", () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
        if (!ThinkingPart) {
            return;
        }

        const v2Msgs = normalizeMessagesForV2Pipeline([
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                content: [new ThinkingPart("reasoning", "id1")],
                name: "assistant",
            } as unknown as vscode.LanguageModelChatMessage,
        ]);

        assert.strictEqual(v2Msgs[0].content[0].type, "thinking");

        const transport = convertV2MessagesToTransportMessages(v2Msgs);
        assert.ok(transport[0].content[0] instanceof vscode.LanguageModelTextPart);
        assert.strictEqual((transport[0].content[0] as vscode.LanguageModelTextPart).value, "reasoning");
    });

    // Regression tests for the "$mid / cache_control / json_cache" bug where
    // Anthropic-style prompt-cache metadata was being decoded and injected as
    // raw text into outbound LLM messages. Once that happens, LLMs fixate on
    // the stray "ephemeral" / "$mid" fragment and can no longer proceed with
    // the active task. These tests guard every transport conversion path so
    // the metadata can never reach the wire again.
    suite("cache_control metadata stripping (regression)", () => {
        test("V2 transport drops bare 'cache_control' parts and keeps adjacent text", () => {
            const v2Msgs = normalizeMessagesForV2Pipeline([
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [
                        new vscode.LanguageModelDataPart(new Uint8Array(Buffer.from("ephemeral")), "cache_control"),
                        new vscode.LanguageModelTextPart("keep me"),
                    ],
                } as unknown as vscode.LanguageModelChatMessage,
            ]);

            const openai = convertV2MessagesToOpenAI(v2Msgs);
            assert.strictEqual(openai.length, 1);
            assert.strictEqual(openai[0].content, "keep me");
            assert.ok(
                typeof openai[0].content !== "string" || !openai[0].content.includes("ephemeral"),
                "cache_control payload must not appear in transport content"
            );
        });

        test("V2 transport drops 'application/vnd.cache-control+json' variants", () => {
            // Guard the +json suffix variant — previously the mimeType.includes("json")
            // branch would decode the carrier payload (e.g. a VS Code $mid object)
            // and inject it as literal text into the LLM message.
            const carrier = JSON.stringify({
                $mid: 24,
                mimeType: "cache_control",
                data: "ZXBoZW1lcmFs",
            });
            const v2Msgs = normalizeMessagesForV2Pipeline([
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [
                        new vscode.LanguageModelDataPart(
                            new Uint8Array(Buffer.from(carrier)),
                            "application/vnd.cache-control+json"
                        ),
                        new vscode.LanguageModelTextPart("hello"),
                    ],
                } as unknown as vscode.LanguageModelChatMessage,
            ]);

            const openai = convertV2MessagesToOpenAI(v2Msgs);
            assert.strictEqual(openai.length, 1);
            assert.strictEqual(openai[0].content, "hello");
            const serialized = JSON.stringify(openai);
            assert.ok(!serialized.includes("$mid"), "carrier $mid marker must not leak");
            assert.ok(!serialized.includes("ZXBoZW1lcmFs"), "carrier base64 must not leak");
            assert.ok(!serialized.includes("cache_control"), "cache_control marker must not leak");
        });

        test("V1 convertMessages drops cache_control parts (bare + +json variants)", () => {
            // V1 path: Copilot Chat can deliver the same poisoned data parts to
            // providers using the legacy convertMessages path, so it must be
            // equally strict.
            const msgs: vscode.LanguageModelChatMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [
                        new vscode.LanguageModelDataPart(Buffer.from("ephemeral"), "cache_control"),
                        new vscode.LanguageModelDataPart(
                            Buffer.from('{"$mid":24,"mimeType":"cache_control","data":"ZXBoZW1lcmFs"}'),
                            "application/vnd.cache-control+json"
                        ),
                        new vscode.LanguageModelTextPart("visible"),
                    ],
                },
            ];

            const out = convertMessages(msgs) as Array<{ role: string; content: string }>;
            assert.strictEqual(out.length, 1);
            assert.strictEqual(out[0].content, "visible");
        });

        test("V2 transport preserves legitimate text/plain and application/json data parts", () => {
            // Sanity guard: while stripping cache_control, we must NOT accidentally
            // strip real JSON / text data parts that carry actual model context.
            const v2Msgs = normalizeMessagesForV2Pipeline([
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [
                        new vscode.LanguageModelDataPart(Buffer.from('{"a":1}'), "application/json"),
                        new vscode.LanguageModelDataPart(Buffer.from("plain"), "text/plain"),
                    ],
                } as unknown as vscode.LanguageModelChatMessage,
            ]);

            const openai = convertV2MessagesToOpenAI(v2Msgs);
            assert.strictEqual(openai.length, 1);
            const content = openai[0].content as string;
            assert.ok(content.includes('{"a":1}'));
            assert.ok(content.includes("plain"));
        });
    });
});
