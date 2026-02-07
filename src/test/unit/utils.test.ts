import * as assert from "assert";
import * as vscode from "vscode";
import {
	convertMessages,
	convertTools,
	isToolResultPart,
	tryParseJSONObject,
	validateRequest,
	validateTools,
} from "../../utils";

suite("Utility Unit Tests", () => {
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
				content: [new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart("ok"), { a: 2 }])],
				name: undefined,
			},
		];

		const out = convertMessages(messages) as Array<{
			role: string;
			content: unknown;
			tool_calls?: Array<{ function: { name: string; arguments: string } }>;
			tool_call_id?: string;
		}>;
		assert.strictEqual(out.length, 2);
		const assistant = out[0];
		assert.strictEqual(assistant.role, "assistant");
		assert.ok(Array.isArray(assistant.tool_calls));
		assert.strictEqual(assistant.tool_calls[0].function.name, "run");
		assert.strictEqual(assistant.tool_calls[0].function.arguments, '{"x":1}');
		const toolResult = out[1];
		assert.strictEqual(toolResult.role, "tool");
		assert.strictEqual(toolResult.tool_call_id, callId);
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

		const res = convertTools({ tools, toolMode: vscode.LanguageModelChatToolMode.Required });
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
		const res = convertTools({ tools: [], toolMode: vscode.LanguageModelChatToolMode.Auto });
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
});
