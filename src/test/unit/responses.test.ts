import * as assert from "assert";
import * as vscode from "vscode";
import { ResponsesClient } from "../../adapters/responsesClient";
import { LiteLLMConfig } from "../../types";

suite("Responses Client Unit Tests", () => {
	const config: LiteLLMConfig = { url: "http://localhost:4000", key: "test-key" };
	const userAgent = "test-ua";

	test("handleEvent processes text delta", async () => {
		const client = new ResponsesClient(config, userAgent);
		const reportedParts: vscode.LanguageModelResponsePart[] = [];
		const progress: vscode.Progress<vscode.LanguageModelResponsePart> = {
			report: (part) => reportedParts.push(part),
		};

		// @ts-expect-error - accessing private method for testing
		await client.handleEvent({ type: "response.output_text.delta", delta: "Hello" }, progress);

		assert.strictEqual(reportedParts.length, 1);
		assert.ok(reportedParts[0] instanceof vscode.LanguageModelTextPart);
		assert.strictEqual((reportedParts[0] as vscode.LanguageModelTextPart).value, "Hello");
	});

	test("handleEvent processes reasoning delta", async () => {
		const client = new ResponsesClient(config, userAgent);
		const reportedParts: vscode.LanguageModelResponsePart[] = [];
		const progress: vscode.Progress<vscode.LanguageModelResponsePart> = {
			report: (part) => reportedParts.push(part),
		};

		// @ts-expect-error - accessing private method for testing
		await client.handleEvent({ type: "response.output_reasoning.delta", delta: "Thinking..." }, progress);

		assert.strictEqual(reportedParts.length, 1);
		assert.ok(reportedParts[0] instanceof vscode.LanguageModelTextPart);
		assert.strictEqual((reportedParts[0] as vscode.LanguageModelTextPart).value, "*Thinking...*");
	});

	test("handleEvent buffers and emits tool calls", async () => {
		const client = new ResponsesClient(config, userAgent);
		const reportedParts: vscode.LanguageModelResponsePart[] = [];
		const progress: vscode.Progress<vscode.LanguageModelResponsePart> = {
			report: (part) => reportedParts.push(part),
		};

		// @ts-expect-error - accessing private method for testing
		await client.handleEvent(
			{
				type: "response.output_item.delta",
				item: { type: "function_call", call_id: "call_1", name: "test_tool", arguments: '{"a":' },
			},
			progress
		);

		// @ts-expect-error - accessing private method for testing
		await client.handleEvent(
			{
				type: "response.output_item.delta",
				item: { type: "function_call", arguments: "1}" },
			},
			progress
		);

		assert.strictEqual(reportedParts.length, 0, "Should not emit until done");

		// @ts-expect-error - accessing private method for testing
		await client.handleEvent(
			{
				type: "response.output_item.done",
				item: { type: "function_call", call_id: "call_1" },
			},
			progress
		);

		assert.strictEqual(reportedParts.length, 1);
		assert.ok(reportedParts[0] instanceof vscode.LanguageModelToolCallPart);
		const toolCall = reportedParts[0] as vscode.LanguageModelToolCallPart;
		assert.strictEqual(toolCall.callId, "call_1");
		assert.strictEqual(toolCall.name, "test_tool");
		assert.deepStrictEqual(toolCall.input, { a: 1 });
	});
});
