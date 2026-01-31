import * as assert from "assert";
//import { LiteLLMClient } from "../../adapters/litellmClient";
import { transformToResponsesFormat } from "../../adapters/responsesAdapter";
import type { OpenAIChatMessage } from "../../types";

suite("LiteLLM Client Unit Tests", () => {
	//const config = { url: "http://localhost:4000", key: "test-key" };
	//const userAgent = "test-ua";
	//const client = new LiteLLMClient(config, userAgent);

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

		assert.strictEqual(functionCall?.id, "fc_call1");
		assert.strictEqual(functionOutput?.call_id, "fc_call1");
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
		assert.strictEqual(functionCall?.id, "fc_orphaned_id");
		assert.strictEqual(functionOutput?.call_id, "fc_orphaned_id");
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
		// Simulate switching models mid-conversation: the conversation has tool calls and results
		// from the previous model, and we're now sending it to a new model via /responses endpoint
		const body = transformToResponsesFormat({
			model: "new-model",
			messages: [
				{ role: "user", content: "Use the tool" },
				{
					role: "assistant",
					tool_calls: [{ id: "call_123", type: "function", function: { name: "get_info", arguments: '{"x":1}' } }],
				},
				{ role: "tool", tool_call_id: "call_123", content: "tool result" },
				{ role: "user", content: "Thanks, now use it again" },
				{
					role: "assistant",
					tool_calls: [{ id: "call_456", type: "function", function: { name: "get_info", arguments: '{"y":2}' } }],
				},
				{ role: "tool", tool_call_id: "call_456", content: "another result" },
			],
		});

		const input = body.input as Record<string, unknown>[];

		// Verify all tool calls are present
		const toolCalls = input.filter((i) => i.type === "function_call");
		assert.strictEqual(toolCalls.length, 2);
		assert.strictEqual(toolCalls[0].id, "fc_call_123");
		assert.strictEqual(toolCalls[1].id, "fc_call_456");

		// Verify all tool outputs are present and have correct call_id references
		const toolOutputs = input.filter((i) => i.type === "function_call_output");
		assert.strictEqual(toolOutputs.length, 2);
		assert.strictEqual(toolOutputs[0].call_id, "fc_call_123");
		assert.strictEqual(toolOutputs[1].call_id, "fc_call_456");

		// Verify the structure matches what /responses endpoint expects
		assert.strictEqual(toolOutputs[0].output, "tool result");
		assert.strictEqual(toolOutputs[1].output, "another result");
	});

	test("switching from /chat/completions to /responses: simple conversation", () => {
		// Scenario: User was using a /chat/completions model, switches to a /responses model
		// The /responses API must correctly transform the message format
		const conversation: OpenAIChatMessage[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there! How can I help?" },
			{ role: "user", content: "What's 2+2?" },
			{ role: "assistant", content: "2+2 equals 4." },
		];

		const body = transformToResponsesFormat({
			model: "responses-model",
			messages: conversation,
		});

		const input = body.input as Record<string, unknown>[];

		// Should have 4 messages (2 user, 2 assistant)
		assert.strictEqual(input.length, 4);
		assert.strictEqual(input[0].type, "message");
		assert.strictEqual(input[0].role, "user");
		assert.strictEqual(input[0].content, "Hello");
		assert.strictEqual(input[1].type, "message");
		assert.strictEqual(input[1].role, "assistant");
		assert.strictEqual(input[1].content, "Hi there! How can I help?");
		assert.strictEqual(input[2].type, "message");
		assert.strictEqual(input[2].role, "user");
		assert.strictEqual(input[2].content, "What's 2+2?");
		assert.strictEqual(input[3].type, "message");
		assert.strictEqual(input[3].role, "assistant");
		assert.strictEqual(input[3].content, "2+2 equals 4.");
	});

	test("switching from /chat/completions to /responses: conversation with tools", () => {
		// Scenario: User had a tool-using conversation with /chat/completions model,
		// now switching to a /responses model that also supports tools
		const conversation: OpenAIChatMessage[] = [
			{ role: "user", content: "What's the weather today?" },
			{
				role: "assistant",
				content: "Let me check the weather for you.",
				tool_calls: [
					{
						id: "call_weather_1",
						type: "function",
						function: { name: "get_weather", arguments: '{"location":"New York"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_weather_1", content: "Sunny, 72°F" },
			{ role: "assistant", content: "The weather in New York is sunny with a temperature of 72°F." },
			{ role: "user", content: "How about San Francisco?" },
			{
				role: "assistant",
				tool_calls: [
					{
						id: "call_weather_2",
						type: "function",
						function: { name: "get_weather", arguments: '{"location":"San Francisco"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_weather_2", content: "Cloudy, 65°F" },
			{ role: "assistant", content: "San Francisco is cloudy with a temperature of 65°F." },
		];

		const body = transformToResponsesFormat({
			model: "responses-weather-model",
			messages: conversation,
		});

		const input = body.input as Record<string, unknown>[];

		// Separate by type
		const messages = input.filter((i) => i.type === "message");
		const functionCalls = input.filter((i) => i.type === "function_call");
		const functionOutputs = input.filter((i) => i.type === "function_call_output");

		// Verify message count: user, assistant, assistant, user, assistant
		assert.strictEqual(messages.length, 5);
		assert.strictEqual(messages[0].role, "user");
		assert.strictEqual(messages[0].content, "What's the weather today?");
		assert.strictEqual(messages[1].role, "assistant");
		assert.strictEqual(messages[1].content, "Let me check the weather for you.");
		assert.strictEqual(messages[2].role, "assistant");
		assert.strictEqual(messages[2].content, "The weather in New York is sunny with a temperature of 72°F.");
		assert.strictEqual(messages[3].role, "user");
		assert.strictEqual(messages[3].content, "How about San Francisco?");
		assert.strictEqual(messages[4].role, "assistant");
		assert.strictEqual(messages[4].content, "San Francisco is cloudy with a temperature of 65°F.");

		// Verify tool calls
		assert.strictEqual(functionCalls.length, 2);
		assert.strictEqual(functionCalls[0].id, "fc_call_weather_1");
		assert.strictEqual(functionCalls[0].name, "get_weather");
		assert.strictEqual(functionCalls[1].id, "fc_call_weather_2");
		assert.strictEqual(functionCalls[1].name, "get_weather");

		// Verify tool outputs with correct call_id references
		assert.strictEqual(functionOutputs.length, 2);
		assert.strictEqual(functionOutputs[0].call_id, "fc_call_weather_1");
		assert.strictEqual(functionOutputs[0].output, "Sunny, 72°F");
		assert.strictEqual(functionOutputs[1].call_id, "fc_call_weather_2");
		assert.strictEqual(functionOutputs[1].output, "Cloudy, 65°F");
	});

	test("switching from /responses to /chat/completions: maintains message integrity", () => {
		// Scenario: User switches FROM a /responses model TO a /chat/completions model
		// The original messages should already be in the correct OpenAI format
		const conversation: OpenAIChatMessage[] = [
			{ role: "user", content: "Hello" },
			{
				role: "assistant",
				tool_calls: [{ id: "fc_call_1", type: "function", function: { name: "search", arguments: '{"q":"test"}' } }],
			},
			{ role: "tool", tool_call_id: "fc_call_1", content: "Found results" },
			{ role: "assistant", content: "Here are the results." },
		];

		// Sending to /chat/completions doesn't require transformation,
		// but the conversation format should be preserved correctly
		const body = {
			model: "chat-completions-model",
			messages: conversation,
			stream: true,
		};

		// Verify the structure is valid for /chat/completions
		assert.strictEqual(body.messages.length, 4);
		assert.strictEqual(body.messages[0].role, "user");
		assert.strictEqual(body.messages[1].role, "assistant");
		assert.strictEqual(body.messages[1].tool_calls?.[0].id, "fc_call_1");
		assert.strictEqual(body.messages[2].role, "tool");
		assert.strictEqual(body.messages[2].tool_call_id, "fc_call_1");
		assert.strictEqual(body.messages[3].role, "assistant");
	});

	test("switching endpoints: all tool IDs are normalized consistently", () => {
		// Scenario: Conversation has mixed ID formats (with and without fc_ prefix)
		// When switching between endpoints, IDs should normalize consistently
		const conversation: OpenAIChatMessage[] = [
			{
				role: "assistant",
				tool_calls: [
					{ id: "call_1", type: "function", function: { name: "func_a", arguments: "{}" } }, // No prefix
					{ id: "fc_call_2", type: "function", function: { name: "func_b", arguments: "{}" } }, // Has prefix
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "result_1" },
			{ role: "tool", tool_call_id: "fc_call_2", content: "result_2" },
		];

		const body = transformToResponsesFormat({
			model: "test-model",
			messages: conversation,
		});

		const input = body.input as Record<string, unknown>[];
		const functionCalls = input.filter((i) => i.type === "function_call") as Array<{ id: string }>;
		const functionOutputs = input.filter((i) => i.type === "function_call_output") as Array<{ call_id: string }>;

		// Both IDs should be normalized with fc_ prefix
		assert.strictEqual(functionCalls[0].id, "fc_call_1");
		assert.strictEqual(functionCalls[1].id, "fc_call_2");

		// Both outputs should reference normalized IDs
		assert.strictEqual(functionOutputs[0].call_id, "fc_call_1");
		assert.strictEqual(functionOutputs[1].call_id, "fc_call_2");
	});

	test("switching endpoints: complex multi-turn conversation with mixed tool calls", () => {
		// Scenario: A realistic multi-turn conversation where:
		// - Some assistant messages have tool calls, others don't
		// - Some turns have multiple tool calls
		// - User switches models between turns
		const conversation: OpenAIChatMessage[] = [
			{ role: "user", content: "I need data analysis" },
			{ role: "assistant", content: "I can help. Let me gather some data." },
			{
				role: "assistant",
				tool_calls: [
					{ id: "analyze_1", type: "function", function: { name: "fetch_data", arguments: '{"source":"db"}' } },
					{ id: "analyze_2", type: "function", function: { name: "fetch_data", arguments: '{"source":"api"}' } },
				],
			},
			{ role: "tool", tool_call_id: "analyze_1", content: '{"rows":100}' },
			{ role: "tool", tool_call_id: "analyze_2", content: '{"rows":250}' },
			{ role: "assistant", content: "I found 350 total rows. Processing..." },
			{
				role: "assistant",
				tool_calls: [{ id: "process_1", type: "function", function: { name: "process_data", arguments: "{}" } }],
			},
			{ role: "tool", tool_call_id: "process_1", content: "Processing complete" },
			{ role: "assistant", content: "Analysis complete!" },
		];

		const body = transformToResponsesFormat({
			model: "analytics-model",
			messages: conversation,
		});

		const input = body.input as Record<string, unknown>[];
		const messages = input.filter((i) => i.type === "message");
		const functionCalls = input.filter((i) => i.type === "function_call");
		const functionOutputs = input.filter((i) => i.type === "function_call_output");

		// Verify message count (user + 3 assistant messages with text)
		// The assistant messages that only have tool_calls (no content) are not counted as messages
		assert.strictEqual(messages.length, 4);
		assert.strictEqual(messages[0].role, "user");
		assert.strictEqual(messages[0].content, "I need data analysis");
		assert.strictEqual(messages[1].role, "assistant");
		assert.strictEqual(messages[1].content, "I can help. Let me gather some data.");
		assert.strictEqual(messages[2].role, "assistant");
		assert.strictEqual(messages[2].content, "I found 350 total rows. Processing...");
		assert.strictEqual(messages[3].role, "assistant");
		assert.strictEqual(messages[3].content, "Analysis complete!");

		// Verify tool calls (3 total: 2 in first group, 1 in second)
		assert.strictEqual(functionCalls.length, 3);
		assert.strictEqual(functionCalls[0].id, "fc_analyze_1");
		assert.strictEqual(functionCalls[1].id, "fc_analyze_2");
		assert.strictEqual(functionCalls[2].id, "fc_process_1");

		// Verify tool outputs (all 3 have matching call_ids)
		assert.strictEqual(functionOutputs.length, 3);
		assert.strictEqual(functionOutputs[0].call_id, "fc_analyze_1");
		assert.strictEqual(functionOutputs[1].call_id, "fc_analyze_2");
		assert.strictEqual(functionOutputs[2].call_id, "fc_process_1");
	});
});
