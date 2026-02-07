import * as assert from "assert";
import * as vscode from "vscode";
import { isAnthropicModel } from "../../utils/modelUtils";
import {
	estimateMessagesTokens,
	estimateSingleMessageTokens,
	estimateToolTokens,
	trimMessagesToFitBudget,
} from "../../adapters/tokenUtils";

suite("TokenUtils Unit Tests", () => {
	test("estimateSingleMessageTokens estimates text parts", () => {
		const msg = {
			role: vscode.LanguageModelChatMessageRole.User,
			content: [new vscode.LanguageModelTextPart("Hello world")],
			name: undefined,
		} as unknown as vscode.LanguageModelChatRequestMessage;

		// "Hello world" is 11 chars. 11/4 = 2.75 -> 3
		assert.strictEqual(estimateSingleMessageTokens(msg), 3);
	});

	test("estimateToolTokens estimates based on JSON length", () => {
		const tools = [{ type: "function", function: { name: "test", description: "test desc" } }];
		const expected = Math.ceil(JSON.stringify(tools).length / 4);
		assert.strictEqual(estimateToolTokens(tools), expected);
		assert.strictEqual(estimateToolTokens([]), 0);
		assert.strictEqual(estimateToolTokens(undefined), 0);
	});

	test("isAnthropicModel identifies models correctly", () => {
		assert.strictEqual(isAnthropicModel("claude-3-opus"), true);
		assert.strictEqual(isAnthropicModel("gpt-4o"), false);
		assert.strictEqual(
			isAnthropicModel("some-model", {
				litellm_provider: "anthropic",
			} as unknown as import("../../types").LiteLLMModelInfo),
			true
		);
	});

	test("trimMessagesToFitBudget keeps system message and recent messages", () => {
		const systemMsg = {
			role: 3 as unknown as vscode.LanguageModelChatMessageRole, // System
			content: [new vscode.LanguageModelTextPart("System prompt")],
			name: undefined,
		} as unknown as vscode.LanguageModelChatRequestMessage;

		const oldMsg = {
			role: vscode.LanguageModelChatMessageRole.User,
			content: [new vscode.LanguageModelTextPart("Old message that is very long and should be trimmed")],
			name: undefined,
		} as unknown as vscode.LanguageModelChatRequestMessage;

		const newMsg = {
			role: vscode.LanguageModelChatMessageRole.User,
			content: [new vscode.LanguageModelTextPart("New message")],
			name: undefined,
		} as unknown as vscode.LanguageModelChatRequestMessage;

		const modelInfo = {
			id: "test",
			maxInputTokens: 10, // Smaller budget
		} as vscode.LanguageModelChatInformation;

		// "System prompt" = 13 chars -> 4 tokens
		// "Old message..." = 53 chars -> 14 tokens
		// "New message" = 11 chars -> 3 tokens
		// Total = 4 + 14 + 3 = 21 (exceeds budget of 10)
		// Should keep system (4) and new message (3) = 7 tokens.
		// Old message (14) cannot fit even alone with system (4 + 14 = 18 > 10).

		const trimmed = trimMessagesToFitBudget([systemMsg, oldMsg, newMsg], undefined, modelInfo);

		assert.strictEqual(trimmed.length, 2);
		assert.strictEqual(trimmed[0], systemMsg);
		assert.strictEqual(trimmed[1], newMsg);
	});

	test("trimMessagesToFitBudget throws if budget is too small", () => {
		const msg = {
			role: vscode.LanguageModelChatMessageRole.User,
			content: [new vscode.LanguageModelTextPart("Too long for small budget")],
			name: undefined,
		} as unknown as vscode.LanguageModelChatRequestMessage;

		const modelInfo = {
			id: "test",
			maxInputTokens: 2, // budget will be 2 - 0 = 2. msg is 26 chars -> 7 tokens.
		} as vscode.LanguageModelChatInformation;

		// The current implementation now ensures at least one message is returned
		// if budget allows for the system message or if no system message exists.
		const trimmed = trimMessagesToFitBudget([msg], undefined, modelInfo);
		assert.strictEqual(trimmed.length, 1);
	});

	test("trimMessagesToFitBudget protects assistant message on 'continue'", () => {
		const systemMsg = {
			role: 3 as unknown as vscode.LanguageModelChatMessageRole,
			content: [new vscode.LanguageModelTextPart("System")],
		} as unknown as vscode.LanguageModelChatRequestMessage;

		const assistantMsg = {
			role: vscode.LanguageModelChatMessageRole.Assistant,
			content: [new vscode.LanguageModelTextPart("Truncated response...")],
		} as unknown as vscode.LanguageModelChatRequestMessage;

		const continueMsg = {
			role: vscode.LanguageModelChatMessageRole.User,
			content: [new vscode.LanguageModelTextPart("continue")],
		} as unknown as vscode.LanguageModelChatRequestMessage;

		const modelInfo = {
			id: "test",
			maxInputTokens: 5, // Very small budget
		} as vscode.LanguageModelChatInformation;

		// System: 6 chars -> 2 tokens
		// Assistant: 21 chars -> 6 tokens
		// Continue: 8 chars -> 2 tokens
		// Total: 2 + 6 + 2 = 10 (exceeds budget of 5)
		// Without protection, it might drop the assistant message.
		// With protection, it should keep system, assistant, and continue.

		const trimmed = trimMessagesToFitBudget([systemMsg, assistantMsg, continueMsg], undefined, modelInfo);

		assert.strictEqual(trimmed.length, 3);
		assert.strictEqual(trimmed[0], systemMsg);
		assert.strictEqual(trimmed[1], assistantMsg);
		assert.strictEqual(trimmed[2], continueMsg);
	});
});
