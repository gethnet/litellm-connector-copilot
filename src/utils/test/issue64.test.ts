import * as assert from "assert";
import * as vscode from "vscode";
import { convertMessages, normalizeMessagesForV2Pipeline } from "../../utils";

suite("Issue #64 Regression Tests (Gemini Role Support)", () => {
    test("convertMessages maps System role to system by default", () => {
        // In the VS Code API, roles are numbers.
        // User = 1, Assistant = 2 (in stable)
        // System is often not directly available in stable but we simulate it
        const messages: { role: number; content: vscode.LanguageModelTextPart[] }[] = [
            {
                role: 1, // User
                content: [new vscode.LanguageModelTextPart("User prompt")],
            },
            {
                role: 3, // System (simulated)
                content: [new vscode.LanguageModelTextPart("System prompt")],
            },
        ];

        const out = convertMessages(messages as unknown as vscode.LanguageModelChatRequestMessage[]);
        assert.strictEqual(out[0].role, "user");
        assert.strictEqual(out[1].role, "system");
    });

    test("normalizeMessagesForV2Pipeline stringifies roles for LiteLLM spec alignment", () => {
        const messages: { role: number; content: vscode.LanguageModelTextPart[] }[] = [
            {
                role: 1, // User
                content: [new vscode.LanguageModelTextPart("User prompt")],
            },
            {
                role: 3, // System (simulated)
                content: [new vscode.LanguageModelTextPart("System prompt")],
            },
        ];

        const out = normalizeMessagesForV2Pipeline(messages as unknown as vscode.LanguageModelChatRequestMessage[]);
        // This is expected to fail before the fix as it currently returns raw enum values
        assert.strictEqual(typeof out[0].role, "string", "User role should be a string");
        assert.strictEqual(out[0].role, "user", "User role should be 'user'");
        assert.strictEqual(typeof out[1].role, "string", "System role should be a string");
        assert.strictEqual(out[1].role, "system", "System role should be 'system'");
    });
});
