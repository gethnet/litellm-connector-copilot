import * as assert from "assert";
import * as vscode from "vscode";
import { convertMessages, normalizeMessagesForV2Pipeline } from "../../utils";

suite("Message Normalization", () => {
    suite("convertMessages", () => {
        test("maps User role to 'user'", () => {
            const messages: { role: number; content: vscode.LanguageModelTextPart[] }[] = [
                {
                    role: 1,
                    content: [new vscode.LanguageModelTextPart("User prompt")],
                },
            ];

            const out = convertMessages(messages as unknown as vscode.LanguageModelChatRequestMessage[]);
            assert.strictEqual(out[0].role, "user");
        });

        test("maps System role (3) to 'system'", () => {
            const messages: { role: number; content: vscode.LanguageModelTextPart[] }[] = [
                {
                    role: 3,
                    content: [new vscode.LanguageModelTextPart("System prompt")],
                },
            ];

            const out = convertMessages(messages as unknown as vscode.LanguageModelChatRequestMessage[]);
            assert.strictEqual(out[0].role, "system");
        });

        test("maps Assistant role (2) to 'assistant'", () => {
            const messages: { role: number; content: vscode.LanguageModelTextPart[] }[] = [
                {
                    role: 2,
                    content: [new vscode.LanguageModelTextPart("Assistant response")],
                },
            ];

            const out = convertMessages(messages as unknown as vscode.LanguageModelChatRequestMessage[]);
            assert.strictEqual(out[0].role, "assistant");
        });

        test("preserves signed thinking as an assistant thinking block", () => {
            const messages = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        new vscode.LanguageModelTextPart("I will continue from the prior response."),
                        {
                            value: "I need to retain the prior reasoning summary.",
                            id: "thought-1",
                            metadata: { encrypted_content: "signed-thinking-state" },
                        },
                    ],
                },
            ];

            const out = convertMessages(messages as unknown as vscode.LanguageModelChatRequestMessage[]);

            assert.strictEqual(out.length, 1);
            assert.strictEqual(out[0].role, "assistant");
            assert.strictEqual(out[0].content, "I will continue from the prior response.");
            assert.deepStrictEqual(out[0].thinking_blocks, [
                {
                    type: "thinking",
                    thinking: "I need to retain the prior reasoning summary.",
                    signature: "signed-thinking-state",
                },
            ]);
        });

        test("preserves redacted thinking as opaque data without visible content", () => {
            const messages = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        {
                            value: "",
                            metadata: { redactedData: "opaque-redacted-thinking" },
                        },
                    ],
                },
            ];

            const out = convertMessages(messages as unknown as vscode.LanguageModelChatRequestMessage[]);

            assert.strictEqual(out.length, 1);
            assert.strictEqual(out[0].role, "assistant");
            assert.strictEqual(out[0].content, undefined);
            assert.deepStrictEqual(out[0].thinking_blocks, [
                { type: "redacted_thinking", data: "opaque-redacted-thinking" },
            ]);
        });

        test("drops bare thinking text that has no opaque continuity state", () => {
            const messages = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        {
                            value: "Do not expose this thought as normal assistant content.",
                            metadata: { display: "summarized" },
                        },
                    ],
                },
            ];

            const out = convertMessages(messages as unknown as vscode.LanguageModelChatRequestMessage[]);

            assert.deepStrictEqual(out, []);
        });

        test("recombines adjacent streamed thinking text with its following signature", () => {
            const messages = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        { value: "first reasoning chunk " },
                        { value: "second reasoning chunk" },
                        { value: "", metadata: { signature: "signed-thinking-state" } },
                        new vscode.LanguageModelTextPart("Visible answer"),
                    ],
                },
            ];

            const out = convertMessages(messages as unknown as vscode.LanguageModelChatRequestMessage[]);

            assert.strictEqual(out.length, 1);
            assert.strictEqual(out[0].content, "Visible answer");
            assert.deepStrictEqual(out[0].thinking_blocks, [
                {
                    type: "thinking",
                    thinking: "first reasoning chunk second reasoning chunk",
                    signature: "signed-thinking-state",
                },
            ]);
        });

        test("omits a signature-only block instead of serializing an invalid native block", () => {
            const messages = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [{ value: "", metadata: { signature: "orphaned-signature" } }],
                },
            ];

            const out = convertMessages(messages as unknown as vscode.LanguageModelChatRequestMessage[]);

            assert.deepStrictEqual(out, []);
        });

        test("does not pair thinking text across an ordinary text boundary", () => {
            const messages = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        { value: "old thought" },
                        new vscode.LanguageModelTextPart("Visible answer"),
                        { value: "", metadata: { signature: "later-signature" } },
                    ],
                },
            ];

            const out = convertMessages(messages as unknown as vscode.LanguageModelChatRequestMessage[]);

            assert.strictEqual(out[0].content, "Visible answer");
            assert.strictEqual(out[0].thinking_blocks, undefined);
        });

        test("recombines multiple adjacent thinking blocks independently", () => {
            const messages = [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    content: [
                        { value: "first thought" },
                        { value: "", metadata: { signature: "first-signature" } },
                        { value: "second thought" },
                        { value: "", metadata: { signature: "second-signature" } },
                    ],
                },
            ];

            const out = convertMessages(messages as unknown as vscode.LanguageModelChatRequestMessage[]);

            assert.deepStrictEqual(out[0].thinking_blocks, [
                { type: "thinking", thinking: "first thought", signature: "first-signature" },
                { type: "thinking", thinking: "second thought", signature: "second-signature" },
            ]);
        });
    });

    suite("normalizeMessagesForV2Pipeline", () => {
        test("stringifies User role to 'user'", () => {
            const messages: { role: number; content: vscode.LanguageModelTextPart[] }[] = [
                {
                    role: 1,
                    content: [new vscode.LanguageModelTextPart("User prompt")],
                },
            ];

            const out = normalizeMessagesForV2Pipeline(messages as unknown as vscode.LanguageModelChatRequestMessage[]);
            assert.strictEqual(typeof out[0].role, "string", "User role should be a string");
            assert.strictEqual(out[0].role, "user", "User role should be 'user'");
        });

        test("stringifies System role (3) to 'system'", () => {
            const messages: { role: number; content: vscode.LanguageModelTextPart[] }[] = [
                {
                    role: 1, // User prompt (index 0)
                    content: [new vscode.LanguageModelTextPart("User prompt")],
                },
                {
                    role: 3, // System prompt (index 1)
                    content: [new vscode.LanguageModelTextPart("System prompt")],
                },
            ];

            const out = normalizeMessagesForV2Pipeline(messages as unknown as vscode.LanguageModelChatRequestMessage[]);
            assert.strictEqual(typeof out[1].role, "string", "System role should be a string");
            assert.strictEqual(out[1].role, "system", "System role should be 'system'");
        });

        test("handles mixed User + System messages", () => {
            const messages: { role: number; content: vscode.LanguageModelTextPart[] }[] = [
                {
                    role: 1,
                    content: [new vscode.LanguageModelTextPart("User prompt")],
                },
                {
                    role: 3,
                    content: [new vscode.LanguageModelTextPart("System prompt")],
                },
            ];

            const out = normalizeMessagesForV2Pipeline(messages as unknown as vscode.LanguageModelChatRequestMessage[]);
            assert.strictEqual(out[0].role, "user");
            assert.strictEqual(out[1].role, "system");
        });
    });
});
