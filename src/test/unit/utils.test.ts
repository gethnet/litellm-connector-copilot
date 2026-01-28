import * as assert from "assert";
import * as vscode from "vscode";
import { convertMessages, validateRequest, validateTools, tryParseJSONObject } from "../../utils";

suite("Utility Unit Tests", () => {
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
});
