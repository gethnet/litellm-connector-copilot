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
