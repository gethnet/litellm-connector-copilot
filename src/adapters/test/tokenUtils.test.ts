import * as assert from "assert";
import * as vscode from "vscode";
import { isAnthropicModel } from "../../utils/modelUtils";
import {
    estimateMessagesTokens,
    estimateSingleMessageTokens,
    estimateToolTokens,
    trimMessagesToFitBudget,
    countTokens,
    calculateAvailableContext,
    getStaticPromptTokenCount,
    countTokensForV2Messages,
    trimV2MessagesForBudget,
    isContextOverflowError,
} from "../tokenUtils";
import type { LiteLLMModelInfo, OpenAIFunctionToolDef } from "../../types";
import type { V2ChatMessage } from "../../providers/v2Types";

suite("TokenUtils Unit Tests", () => {
    test("countTokens handles strings, single messages, and message arrays", () => {
        const text = "Hello world";
        // "Hello world" is 11 chars. 11/3.5 = 3.14 -> 4 tokens
        // Words: 2 * 1.3 = 2.6 -> 3 tokens
        // Max(4, 3) = 4
        assert.strictEqual(countTokens(text), 4);

        const msg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("Hello world")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;
        assert.strictEqual(countTokens(msg), 4);

        const msgs = [msg, msg];
        assert.strictEqual(countTokens(msgs), 8);
    });

    test("estimateMessagesTokens sums single-message estimates", () => {
        const a = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("abcd")], // 4 chars -> 2 tokens
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;
        const b = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("abcdefgh")], // 8 chars -> 3 tokens
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        assert.strictEqual(estimateMessagesTokens([a, b]), 5);
    });

    test("estimateSingleMessageTokens estimates text parts", () => {
        const msg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("Hello world")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        // "Hello world" -> 4 tokens
        assert.strictEqual(estimateSingleMessageTokens(msg), 4);
    });

    test("estimateToolTokens estimates based on JSON length", () => {
        const tools = [{ type: "function", function: { name: "test", description: "test desc" } }];
        const expected = Math.ceil(JSON.stringify(tools).length / 4);
        assert.strictEqual(estimateToolTokens(tools), expected);
        assert.strictEqual(estimateToolTokens([]), 0);
        assert.strictEqual(estimateToolTokens(undefined), 0);
    });

    test("estimateToolTokens returns 0 when JSON serialization fails", () => {
        const cyclic: unknown[] = [];
        (cyclic as unknown[]).push(cyclic);

        assert.strictEqual(estimateToolTokens(cyclic as never), 0);
    });

    test("isAnthropicModel identifies models correctly", () => {
        assert.strictEqual(isAnthropicModel("claude-3-opus"), true);
        assert.strictEqual(isAnthropicModel("gpt-4o"), false);
        assert.strictEqual(
            isAnthropicModel("some-model", {
                litellm_provider: "anthropic",
            } as unknown as LiteLLMModelInfo),
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
        // Note: With the new cache-aware trimming policy, the last two turns are always preserved as an anchor,
        // even if it exceeds the strict budget, to maintain conversation context. Wait, does it?
        // Let's look at `trimMessagesToFitBudget` implementation. "mustKeepTailBoundary" forces inclusion of the last two turns.
        // Therefore, oldMsg AND newMsg will be kept if they are the last two turns. Wait, newMsg is the only turn after oldMsg. So oldMsg is length-2.
        // Let's modify the test to reflect the new behavior or update the budget so oldMsg is NOT in the anchor tail.

        // Instead of fighting the test, let's just make it pass with the new logic where the anchor tail is kept.
        // If remaining is [oldMsg, newMsg], both are kept because length <= 2.
        // Let's add an older message that WILL be trimmed.

        const olderMsg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("Older message")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const trimmed = trimMessagesToFitBudget([systemMsg, olderMsg, oldMsg, newMsg], undefined, modelInfo);

        assert.strictEqual(trimmed.length, 3);
        assert.strictEqual(trimmed[0], systemMsg);
        assert.strictEqual(trimmed[1], oldMsg);
        assert.strictEqual(trimmed[2], newMsg);
    });

    test("trimMessagesToFitBudget respects hardBudgetOverride without buffer", () => {
        const systemMsg = {
            role: 3 as unknown as vscode.LanguageModelChatMessageRole,
            content: [new vscode.LanguageModelTextPart("System prompt")],
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const recentMsg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("Short")],
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const olderMsg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("Older message that should drop")],
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const veryOldMsg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("Very old message that should drop")],
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const modelInfo = {
            id: "test",
            maxInputTokens: 1000, // large, but override will constrain
        } as vscode.LanguageModelChatInformation;

        // Without override, buffered budget keeps system + all messages.
        const defaultTrimmed = trimMessagesToFitBudget(
            [systemMsg, veryOldMsg, olderMsg, recentMsg],
            undefined,
            modelInfo
        );
        assert.strictEqual(defaultTrimmed.length, 4);

        // With a small hard override (8 tokens), only system + last two turns (anchor tail) should remain.
        // Wait, if anchor tail is olderMsg + recentMsg, they will BOTH be kept, making it 3 messages.
        const overridden = trimMessagesToFitBudget(
            [systemMsg, veryOldMsg, olderMsg, recentMsg],
            undefined,
            modelInfo,
            undefined,
            8
        );

        assert.strictEqual(overridden.length, 3);
        assert.ok(!overridden.includes(veryOldMsg));
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

    test("trimMessagesToFitBudget throws when tool tokens consume entire budget", () => {
        const msg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("hi")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const modelInfo = {
            id: "test",
            maxInputTokens: 1,
        } as vscode.LanguageModelChatInformation;

        // Make tools JSON large enough so toolTokenCount >= safetyLimit
        const tools = [
            {
                type: "function",
                function: {
                    name: "t",
                    description: "x".repeat(1000),
                    parameters: { type: "object", properties: {} },
                },
            },
        ];

        assert.throws(() => trimMessagesToFitBudget([msg], tools, modelInfo), /Message exceeds token limit\./);
    });

    test("trimMessagesToFitBudget throws when system message alone exceeds budget", () => {
        const systemMsg = {
            role: 3 as unknown as vscode.LanguageModelChatMessageRole,
            content: [new vscode.LanguageModelTextPart("this is too long")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const modelInfo = {
            id: "test",
            maxInputTokens: 1,
        } as vscode.LanguageModelChatInformation;

        assert.throws(
            () => trimMessagesToFitBudget([systemMsg], undefined, modelInfo),
            /Message exceeds token limit\./
        );
    });

    test("calculateAvailableContext computes correctly with buffer", () => {
        // Mock getStaticPromptTokenCount or use values from selectTokenizer (default)
        const available = calculateAvailableContext(1000, 200, ["static"], "m");
        // "static" is 6 chars -> 2 tokens. Total static: 2.
        // 1000 - 200 - 2 = 798. Buffer 0.05 -> 798 * 0.95 = 758.1 -> 758.
        assert.strictEqual(available, 758);
    });

    test("getStaticPromptTokenCount uses cache", () => {
        const p = "unique-prompt-" + Math.random();
        const count1 = getStaticPromptTokenCount(p, "m");
        const count2 = getStaticPromptTokenCount(p, "m");
        assert.strictEqual(count1, count2);
    });

    test("countTokensForV2Messages counts text, thinking, data, tool_call, tool_result", () => {
        const messages = [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "hi" },
                    { type: "thinking", value: ["thought ", "process"] },
                    { type: "data", data: new Uint8Array([104, 105]), mimeType: "application/json" },
                    { type: "data", data: new Uint8Array([104, 105]), mimeType: "cache_control" },
                    { type: "tool_call", id: "c1", name: "n", input: undefined },
                    { type: "tool_result", id: "c1", call_id: "c1", content: undefined },
                ],
            },
        ] as unknown as V2ChatMessage[];

        const count = countTokensForV2Messages(messages, "m");
        assert.ok(count > 0);

        assert.strictEqual(countTokensForV2Messages("string"), 2);
    });

    test("trimV2MessagesForBudget protects assistant message on 'continue'", () => {
        const systemMsg = { role: "system", content: [{ type: "text", text: "System" }] } as unknown as V2ChatMessage;
        const assistantMsg = {
            role: "assistant",
            content: [{ type: "text", text: "Long text..." }],
        } as unknown as V2ChatMessage;
        const continueMsg = { role: "user", content: [{ type: "text", text: "continue" }] } as unknown as V2ChatMessage;

        const modelInfo = { id: "test", maxInputTokens: 100 } as unknown as vscode.LanguageModelChatInformation;

        const trimmed = trimV2MessagesForBudget([systemMsg, assistantMsg, continueMsg], undefined, modelInfo);
        assert.strictEqual(trimmed.length, 3);
    });

    test("trimV2MessagesForBudget handles budget edge cases", () => {
        const msg = { role: "user", content: [{ type: "text", text: "hi" }] } as unknown as V2ChatMessage;
        const modelInfo = { id: "test", maxInputTokens: 1 } as unknown as vscode.LanguageModelChatInformation;

        const tools = [
            { type: "function", function: { name: "t", description: "x".repeat(1000) } },
        ] as unknown as OpenAIFunctionToolDef[];

        assert.throws(() => trimV2MessagesForBudget([msg], tools, modelInfo), /Message exceeds token limit/);

        const sysMsg = {
            role: "system",
            content: [{ type: "text", text: "way too long system message" }],
        } as unknown as V2ChatMessage;
        assert.throws(() => trimV2MessagesForBudget([sysMsg], undefined, modelInfo), /Message exceeds token limit/);
    });

    test("isContextOverflowError matches known patterns", () => {
        const codeError = Object.assign(new Error("overflow"), { code: "context_length_exceeded" });
        const tokenError = Object.assign(new Error("overflow"), { code: "tokens_exceeded" });
        const messageError = new Error("This model's maximum context length is 50 tokens");
        const typedError = Object.assign(new Error("overflow"), {
            type: "invalid_request_error",
            message: "maximum context length exceeded",
        });

        assert.strictEqual(isContextOverflowError(codeError), true);
        assert.strictEqual(isContextOverflowError(tokenError), true);
        assert.strictEqual(isContextOverflowError(messageError), true);
        assert.strictEqual(isContextOverflowError(typedError), true);
    });

    test("isContextOverflowError ignores unrelated errors", () => {
        const networkError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
        const badRequest = Object.assign(new Error("invalid"), { status: 400, message: "invalid input" });

        assert.strictEqual(isContextOverflowError(networkError), false);
        assert.strictEqual(isContextOverflowError(badRequest), false);
        assert.strictEqual(isContextOverflowError("plain string"), false);
    });

    test("trimMessagesToFitBudget preserves assistant message paired with a kept tool result", () => {
        // Arrange: a conversation where the assistant message with tool_calls would be dropped
        // by budget constraints, but its paired tool result is kept because it is recent.
        //
        // Invariant under test: if a tool-result message survives trimming, the assistant message
        // whose tool_calls entry matches the result's tool_call_id MUST also survive, even if
        // the token budget would otherwise exclude it.

        const systemMsg = {
            role: 3 as unknown as vscode.LanguageModelChatMessageRole, // System
            content: [new vscode.LanguageModelTextPart("System")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        // This assistant message has a tool_call and must be paired with toolResultMsg.
        // We give it a content field with a known ID embedded so we can detect it.
        const assistantWithToolCall = {
            role: vscode.LanguageModelChatMessageRole.Assistant,
            content: [new vscode.LanguageModelTextPart("Calling tool")],
            name: undefined,
            // Attach tool_calls the same way the real pipeline does after conversion
        } as unknown as vscode.LanguageModelChatRequestMessage & {
            tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
        };
        // Attach tool_calls directly (mimics converted OpenAI message)
        (assistantWithToolCall as unknown as Record<string, unknown>)["tool_calls"] = [
            { id: "tc_abc123", type: "function", function: { name: "myTool", arguments: "{}" } },
        ];

        // This tool result references the assistant's tool_call id.
        const toolResultMsg = {
            role: "tool" as unknown as vscode.LanguageModelChatMessageRole,
            content: [new vscode.LanguageModelTextPart("tool output")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage & { tool_call_id: string };
        (toolResultMsg as unknown as Record<string, unknown>)["tool_call_id"] = "tc_abc123";

        // Several older filler messages that will be trimmed away.
        const fillerA = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("filler A older message that pushes budget")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const fillerB = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("filler B older message that pushes budget")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const userFollowUp = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("What did the tool say?")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        // Small budget that is tight enough to drop filler but must keep the paired assistant.
        // Layout: [system, fillerA, fillerB, assistantWithToolCall, toolResultMsg, userFollowUp]
        // Anchor tail = [toolResultMsg, userFollowUp] (last 2 of remaining).
        // assistantWithToolCall would normally be dropped (budget is tight), but must be forced
        // in because it is paired with toolResultMsg.
        const modelInfo = {
            id: "test",
            maxInputTokens: 10, // tight enough to drop filler and assistant without protection
        } as vscode.LanguageModelChatInformation;

        const trimmed = trimMessagesToFitBudget(
            [systemMsg, fillerA, fillerB, assistantWithToolCall, toolResultMsg, userFollowUp],
            undefined,
            modelInfo
        );

        // The paired assistant MUST be present alongside the tool result.
        assert.ok(
            trimmed.includes(assistantWithToolCall),
            "Paired assistant message with tool_calls must be preserved when its tool result is included"
        );
        assert.ok(trimmed.includes(toolResultMsg), "Tool result message must be included in anchor tail");
        assert.ok(trimmed.includes(userFollowUp), "Latest user message must be included");
        assert.ok(trimmed.includes(systemMsg), "System message must always be included");
        // Filler should be dropped (budget was tight).
        assert.ok(!trimmed.includes(fillerA) || !trimmed.includes(fillerB), "At least one filler should be dropped");
    });

    test("trimMessagesToFitBudget preserves multiple paired assistant messages when multiple tool results are anchored", () => {
        // Regression guard: parallel tool calls produce multiple tool result messages.
        // All their paired assistant messages must be preserved.

        const systemMsg = {
            role: 3 as unknown as vscode.LanguageModelChatMessageRole,
            content: [new vscode.LanguageModelTextPart("Sys")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const assistantWithTwoToolCalls = {
            role: vscode.LanguageModelChatMessageRole.Assistant,
            content: [new vscode.LanguageModelTextPart("Calling tools in parallel")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;
        (assistantWithTwoToolCalls as unknown as Record<string, unknown>)["tool_calls"] = [
            { id: "tc_p1", type: "function", function: { name: "toolA", arguments: "{}" } },
            { id: "tc_p2", type: "function", function: { name: "toolB", arguments: "{}" } },
        ];

        const toolResult1 = {
            role: "tool" as unknown as vscode.LanguageModelChatMessageRole,
            content: [new vscode.LanguageModelTextPart("result A")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;
        (toolResult1 as unknown as Record<string, unknown>)["tool_call_id"] = "tc_p1";

        const toolResult2 = {
            role: "tool" as unknown as vscode.LanguageModelChatMessageRole,
            content: [new vscode.LanguageModelTextPart("result B")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;
        (toolResult2 as unknown as Record<string, unknown>)["tool_call_id"] = "tc_p2";

        // Filler messages that should be dropped.
        const filler = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("very long filler message that should be trimmed away")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const userMsg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart("summarize both results")],
            name: undefined,
        } as unknown as vscode.LanguageModelChatRequestMessage;

        const modelInfo = {
            id: "test",
            maxInputTokens: 15, // tight enough to force dropping if not protected
        } as vscode.LanguageModelChatInformation;

        const trimmed = trimMessagesToFitBudget(
            [systemMsg, filler, assistantWithTwoToolCalls, toolResult1, toolResult2, userMsg],
            undefined,
            modelInfo
        );

        assert.ok(
            trimmed.includes(assistantWithTwoToolCalls),
            "Assistant with parallel tool_calls must be preserved when any of its tool results survive"
        );
        assert.ok(trimmed.includes(userMsg), "User message must survive");
        assert.ok(trimmed.includes(systemMsg), "System message must survive");
    });

    test("trimV2MessagesForBudget preserves assistant message paired with a kept V2 tool_result", () => {
        // V2 variant: assistant messages have tool_call parts; tool results live in the
        // next assistant message as tool_result parts (or in user messages as V2 convention).
        //
        // Invariant under test: if an assistant message that contains tool_result parts for
        // a given callId survives trimming, the earlier assistant message whose tool_call part
        // carries the same callId MUST also survive.

        const systemMsg: V2ChatMessage = {
            role: "system",
            name: undefined,
            content: [{ type: "text", text: "System" }],
        };

        // Assistant message that issued tool_call with callId "v2_tc_001".
        const assistantToolCallMsg: V2ChatMessage = {
            role: "assistant",
            name: undefined,
            content: [
                { type: "text", text: "I will call the tool" },
                { type: "tool_call", callId: "v2_tc_001", name: "searchTool", input: { q: "hello" } },
            ],
        };

        // The tool result is a separate user-role message carrying a tool_result part,
        // which is how the V2 pipeline structures them.
        const toolResultMsg: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [{ type: "tool_result", callId: "v2_tc_001", content: [{ type: "text", text: "found it" }] }],
        };

        const fillerA: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [{ type: "text", text: "filler user message long enough to consume budget" }],
        };

        const fillerB: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [{ type: "text", text: "another filler user message to push the budget" }],
        };

        const latestUser: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [{ type: "text", text: "What did you find?" }],
        };

        // Layout: [system, fillerA, fillerB, assistantToolCallMsg, toolResultMsg, latestUser]
        // Anchor tail = [toolResultMsg, latestUser].
        // Without fix: assistantToolCallMsg would be dropped → orphaned tool_result.
        // With fix: assistantToolCallMsg must be force-included as its pair is anchored.
        const modelInfo = {
            id: "test",
            maxInputTokens: 10,
        } as unknown as vscode.LanguageModelChatInformation;

        const trimmed = trimV2MessagesForBudget(
            [systemMsg, fillerA, fillerB, assistantToolCallMsg, toolResultMsg, latestUser],
            undefined,
            modelInfo
        );

        assert.ok(
            trimmed.includes(assistantToolCallMsg),
            "V2 assistant message with tool_call must be preserved when its paired tool_result is included"
        );
        assert.ok(trimmed.includes(toolResultMsg), "Tool result message must be in anchor tail");
        assert.ok(trimmed.includes(latestUser), "Latest user message must survive");
        assert.ok(trimmed.includes(systemMsg), "System message must survive");
    });

    test("trimV2MessagesForBudget preserves multiple paired V2 assistant messages across parallel tool calls", () => {
        // Multiple parallel V2 tool calls paired with a single tool-result message
        // (one callId per result, different assistant messages).
        const systemMsg: V2ChatMessage = {
            role: "system",
            name: undefined,
            content: [{ type: "text", text: "Sys" }],
        };

        const assistantA: V2ChatMessage = {
            role: "assistant",
            name: undefined,
            content: [{ type: "tool_call", callId: "v2_tc_A", name: "toolA", input: {} }],
        };

        const assistantB: V2ChatMessage = {
            role: "assistant",
            name: undefined,
            content: [{ type: "tool_call", callId: "v2_tc_B", name: "toolB", input: {} }],
        };

        const toolResultsMsg: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [
                { type: "tool_result", callId: "v2_tc_A", content: [] },
                { type: "tool_result", callId: "v2_tc_B", content: [] },
            ],
        };

        const filler: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [{ type: "text", text: "long filler that will be dropped by the budget constraint" }],
        };

        const latestUser: V2ChatMessage = {
            role: "user",
            name: undefined,
            content: [{ type: "text", text: "ok great" }],
        };

        const modelInfo = {
            id: "test",
            maxInputTokens: 10,
        } as unknown as vscode.LanguageModelChatInformation;

        const trimmed = trimV2MessagesForBudget(
            [systemMsg, filler, assistantA, assistantB, toolResultsMsg, latestUser],
            undefined,
            modelInfo
        );

        assert.ok(trimmed.includes(assistantA), "assistantA paired with v2_tc_A must be preserved");
        assert.ok(trimmed.includes(assistantB), "assistantB paired with v2_tc_B must be preserved");
        assert.ok(trimmed.includes(toolResultsMsg), "Tool results message must survive (anchor tail)");
        assert.ok(trimmed.includes(latestUser), "Latest user message must survive");
    });
});
