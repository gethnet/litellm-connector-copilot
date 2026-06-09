import * as assert from "assert";
import { convertMessagesToOpenAI } from "./messageConverter";
import type { V2ChatMessage } from "../providers/v2Types";
import type { MessageConversionOptions } from "./messageConverter";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

suite("Message Converters Tool Name Sanitization", () => {
    test("applies tool name sanitization in convertMessagesToOpenAI for Bedrock compliance", () => {
        // Create a V2 chat message with a tool call part
        const message: V2ChatMessage = {
            role: "assistant",
            name: undefined,
            content: [
                {
                    type: "tool_call",
                    callId: "test-call-1",
                    name: "create-file_with-dash_and_underscore",
                    input: { path: "example.txt" },
                },
            ],
        };

        const options: MessageConversionOptions = {
            normalizeToolCallId: (id: string) => id,
        };

        const result = convertMessagesToOpenAI([message], options);

        // Find tool call in result
        const toolCall = result.find((r) => r.tool_calls && r.tool_calls.length > 0);
        assert.ok(toolCall, "Expected an assistant message with tool calls");
        assert.ok(toolCall.tool_calls);
        assert.ok(toolCall.tool_calls[0]);
        assert.ok(toolCall.tool_calls[0].function);
        assert.ok(toolCall.tool_calls[0].function.name);

        // Sanitization should collapse special chars to underscores, enforce 64-char limit
        const name = toolCall.tool_calls[0].function.name;
        assert.ok(/^[a-zA-Z]/.test(name), `Name should start with letter, got: ${name}`);
        assert.ok(name.length <= 66, `Name should be <=66 chars (tool_ + 64), got length ${name}: ${name}`);
    });

    test("handles tool name exceeding 64 characters (edge case)", () => {
        const longName = "a".repeat(100);
        const message: V2ChatMessage = {
            role: "assistant",
            name: undefined,
            content: [
                {
                    type: "tool_call",
                    callId: "test-call-2",
                    name: longName,
                    input: {},
                },
            ],
        };

        const options: MessageConversionOptions = {
            normalizeToolCallId: (id: string) => id,
        };

        const result = convertMessagesToOpenAI([message], options);

        // Find tool call in result
        const toolCall = result.find((r) => r.tool_calls && r.tool_calls.length > 0);
        assert.ok(toolCall, "Expected an assistant message with tool calls");
        assert.ok(toolCall.tool_calls);
        assert.ok(toolCall.tool_calls[0]);
        assert.ok(toolCall.tool_calls[0].function);
        assert.ok(toolCall.tool_calls[0].function.name);

        const name = toolCall.tool_calls[0].function.name;
        assert.ok(name.length <= 66, `Name should be <=66 chars (tool_ + 64), got length ${name}: ${name}`);
    });

    test("handles tool name starting with number - prefix with tool_", () => {
        const message: V2ChatMessage = {
            role: "assistant",
            name: undefined,
            content: [
                {
                    type: "tool_call",
                    callId: "test-call-3",
                    name: "123start",
                    input: {},
                },
            ],
        };

        const options: MessageConversionOptions = {
            normalizeToolCallId: (id: string) => id,
        };

        const result = convertMessagesToOpenAI([message], options);

        // Find tool call in result
        const toolCall = result.find((r) => r.tool_calls && r.tool_calls.length > 0);
        assert.ok(toolCall, "Expected an assistant message with tool calls");
        assert.ok(toolCall.tool_calls);
        assert.ok(toolCall.tool_calls[0]);
        assert.ok(toolCall.tool_calls[0].function);
        assert.ok(toolCall.tool_calls[0].function.name);

        assert.ok(
            /^tool_/.test(toolCall.tool_calls[0].function.name),
            `Name should start with tool_, got: ${toolCall.tool_calls[0].function.name}`
        );
    });
});
