import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { StructuredLogger } from "../../observability/structuredLogger";
import { convertMessages, normalizeToolCallId } from "../../utils";
import { transformToResponsesFormat } from "../../adapters/responsesAdapter";
import { createInitialStreamingState, interpretStreamEvent } from "../../adapters/streaming/liteLLMStreamInterpreter";
import { emitPartsToVSCode } from "../../adapters/streaming/vscodePartEmitter";
import { createReasoningScope } from "../../adapters/reasoningContinuity";
import type { ReasoningScope } from "../../adapters/reasoningContinuity";
import { stripThinkingBlocksFromRequest } from "../../providers/base/thinkingBlockRetry";
import type { OpenAIChatCompletionRequest, ResponsesReasoningItem } from "../../types";

/** SSE → VS Code ThinkingPart → history converter → /responses input, end to end. */
suite("Native Responses reasoning replay", () => {
    const model = "chatgpt/gpt-6.1-sol";
    const scope = createReasoningScope(model, "https://proxy.example/team-a", "group-a", "session")!;
    const item: ResponsesReasoningItem = {
        type: "reasoning",
        id: "rs_original_123",
        summary: [{ type: "summary_text", text: "Summary" }],
        encrypted_content: "SYNTHETIC_OPAQUE_STATE",
        status: "completed",
    };

    function streamedHistory(items: ResponsesReasoningItem[]): vscode.LanguageModelResponsePart[] {
        const state = createInitialStreamingState(scope);
        const content: vscode.LanguageModelResponsePart[] = [];
        for (const reasoning of items) {
            const parts = interpretStreamEvent({ type: "response.output_item.done", item: reasoning }, state);
            emitPartsToVSCode(parts, { report: (part) => content.push(part) });
        }
        content.push(new vscode.LanguageModelTextPart("Visible answer"));
        content.push(new vscode.LanguageModelToolCallPart("call_example", "read_file", { path: "test.txt" }));
        return content;
    }

    function replay(items: ResponsesReasoningItem[], target: ReasoningScope = scope): OpenAIChatCompletionRequest {
        const messages = convertMessages(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    name: undefined,
                    content: streamedHistory(items),
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [
                        new vscode.LanguageModelToolResultPart("call_example", [
                            new vscode.LanguageModelTextPart("tool result"),
                        ]),
                    ],
                },
            ],
            { nativeResponses: true, reasoningScope: target }
        );
        return {
            model: target.model,
            messages,
            reasoning_effort: "high",
            reasoningContext: { policy: "native", scope: target },
        };
    }

    const reasoningInputs = (request: OpenAIChatCompletionRequest) =>
        transformToResponsesFormat(request).input.filter((entry) => entry.type === "reasoning");

    test("preserves the original item, order, and tool pairing", () => {
        const body = transformToResponsesFormat(replay([item]));
        assert.deepStrictEqual(
            body.input.map((entry) => entry.type),
            ["reasoning", "message", "function_call", "function_call_output"]
        );
        assert.deepStrictEqual(body.input[0], item);
        assert.strictEqual(
            body.input.find((entry) => entry.type === "function_call")?.id,
            normalizeToolCallId("call_example")
        );
        assert.deepStrictEqual(body.include, ["reasoning.encrypted_content"]);
    });

    test("keeps encrypted-only and multiple items with their original IDs", () => {
        const opaqueOnly = { ...item, summary: [] };
        const second = { ...item, id: "rs_original_456", encrypted_content: "OTHER_STATE" };
        assert.deepStrictEqual(reasoningInputs(replay([opaqueOnly, second])), [opaqueOnly, second]);
    });

    test("survives JSON round-trip of chat history", () => {
        const restored = JSON.parse(JSON.stringify(streamedHistory([item]))) as vscode.LanguageModelResponsePart[];
        const messages = convertMessages(
            [{ role: vscode.LanguageModelChatMessageRole.Assistant, name: undefined, content: restored }],
            { nativeResponses: true, reasoningScope: scope }
        );
        assert.deepStrictEqual(messages[0].responses_reasoning, [item]);
    });

    test("never replays into a different backend, model, group, or session", () => {
        const mismatches: ReasoningScope[] = [
            { ...scope, backend: "https://proxy.example/team-b" },
            { ...scope, model: "chatgpt/other-model" },
            { ...scope, group: "group-b" },
            { ...scope, authorization: "other-session" },
        ];
        for (const target of mismatches) {
            assert.deepStrictEqual(reasoningInputs(replay([item], target)), [], JSON.stringify(target));
        }
    });

    test("native routes drop untyped legacy signatures but keep visible content", () => {
        const body = transformToResponsesFormat({
            model,
            reasoningContext: { policy: "native" },
            messages: [
                {
                    role: "assistant",
                    content: "Visible answer",
                    thinking_blocks: [{ type: "thinking", thinking: "Old", signature: "OLD_UNKNOWN_SIGNATURE" }],
                },
            ],
        });
        assert.deepStrictEqual(body.input, [{ type: "message", role: "assistant", content: "Visible answer" }]);
    });

    test("bridged non-native routes keep legacy Anthropic continuity", () => {
        const [reasoning] = reasoningInputs({
            model: "anthropic/claude-opus-5",
            messages: [
                {
                    role: "assistant",
                    thinking_blocks: [{ type: "thinking", thinking: "Claude summary", signature: "CLAUDE_SIGNATURE" }],
                },
            ],
        });
        assert.ok(reasoning?.type === "reasoning" && reasoning.encrypted_content === "CLAUDE_SIGNATURE");
    });

    test("invalid typed metadata never falls back to a legacy signature", () => {
        const messages = convertMessages(
            [
                {
                    role: vscode.LanguageModelChatMessageRole.Assistant,
                    name: undefined,
                    content: [
                        {
                            value: "visible summary",
                            metadata: { litellm_responses_reasoning: { version: 99 }, signature: "DO_NOT_REPLAY" },
                        } as vscode.LanguageModelThinkingPart,
                    ],
                },
            ],
            { nativeResponses: true, reasoningScope: scope }
        );
        assert.deepStrictEqual(messages, []);
    });

    test("conversion summarizes dropped scope and legacy state once without logging payloads", () => {
        const debug = sinon.stub(StructuredLogger, "debug");
        try {
            const legacy = {
                value: "summary",
                metadata: { signature: "PRIVATE_LEGACY_STATE" },
            } as vscode.LanguageModelThinkingPart;
            convertMessages(
                [
                    {
                        role: vscode.LanguageModelChatMessageRole.Assistant,
                        name: undefined,
                        content: [...streamedHistory([item, { ...item, id: "rs_second" }]), legacy, legacy],
                    },
                ],
                { nativeResponses: true, reasoningScope: { ...scope, authorization: "OTHER_SESSION" } }
            );
            const summaries = debug.getCalls().filter((call) => call.args[0] === "request.reasoning_history_filtered");
            assert.strictEqual(summaries.length, 1);
            assert.deepStrictEqual(summaries[0].args, [
                "request.reasoning_history_filtered",
                {
                    droppedNativeItems: 2,
                    droppedLegacyItems: 2,
                },
            ]);
            assert.ok(!JSON.stringify(debug.args).includes("PRIVATE_LEGACY_STATE"));
        } finally {
            debug.restore();
        }
    });

    test("continuity recovery strips native items without touching effort or history", () => {
        const request = replay([item]);
        const before = JSON.stringify(request);
        const stripped = stripThinkingBlocksFromRequest(request);
        assert.deepStrictEqual(reasoningInputs(stripped), []);
        assert.strictEqual(stripped.reasoning_effort, "high");
        assert.strictEqual(JSON.stringify(request), before);
    });
});
