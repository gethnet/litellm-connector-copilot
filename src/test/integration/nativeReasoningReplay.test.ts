import * as assert from "assert";
import * as vscode from "vscode";
import { transformToResponsesFormat } from "../../adapters/responsesAdapter";
import { createInitialStreamingState, interpretStreamEvent } from "../../adapters/streaming/liteLLMStreamInterpreter";
import { emitPartsToVSCode } from "../../adapters/streaming/vscodePartEmitter";
import { stripThinkingBlocksFromRequest } from "../../providers/base/thinkingBlockRetry";
import { convertMessages, normalizeToolCallId } from "../../utils";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../../types";

/** SSE → ThinkingPart → history → /responses must retain native reasoning ids. */
suite("Native Responses reasoning replay", () => {
    const model = "chatgpt/gpt-6.1-sol";
    const modelInfo: LiteLLMModelInfo = { provider: "chatgpt", supports_reasoning: true };

    function streamedAssistantTurn(): vscode.LanguageModelResponsePart[] {
        const state = createInitialStreamingState();
        const content: vscode.LanguageModelResponsePart[] = [];
        const frames: unknown[] = [
            { type: "response.output_item.added", item: { type: "reasoning", id: "rs_original_123" } },
            { type: "response.reasoning_summary_text.delta", item_id: "rs_original_123", delta: "Summary" },
            {
                type: "response.output_item.done",
                item: {
                    type: "reasoning",
                    id: "rs_original_123",
                    summary: [{ type: "summary_text", text: "Summary" }],
                    encrypted_content: "SYNTHETIC_OPAQUE_STATE",
                },
            },
        ];
        for (const frame of frames) {
            emitPartsToVSCode(interpretStreamEvent(frame, state), { report: (part) => content.push(part) });
        }
        content.push(new vscode.LanguageModelTextPart("Visible answer"));
        content.push(new vscode.LanguageModelToolCallPart("call_example", "read_file", { path: "test.txt" }));
        return content;
    }

    function requestFor(content: vscode.LanguageModelResponsePart[]): OpenAIChatCompletionRequest {
        const messages = convertMessages([
            { role: vscode.LanguageModelChatMessageRole.Assistant, name: undefined, content },
            {
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [
                    new vscode.LanguageModelToolResultPart("call_example", [new vscode.LanguageModelTextPart("ok")]),
                ],
            },
        ]);
        return { model, messages, reasoning_effort: "high" };
    }

    test("preserves original id, item order, and tool pairing end to end", () => {
        const body = transformToResponsesFormat(requestFor(streamedAssistantTurn()), modelInfo);
        assert.deepStrictEqual(
            body.input.map((entry) => entry.type),
            ["reasoning", "message", "function_call", "function_call_output"]
        );
        assert.deepStrictEqual(body.input[0], {
            type: "reasoning",
            id: "rs_original_123",
            summary: [{ type: "summary_text", text: "Summary" }],
            encrypted_content: "SYNTHETIC_OPAQUE_STATE",
        });
        assert.strictEqual(
            body.input.find((entry) => entry.type === "function_call")?.id,
            normalizeToolCallId("call_example")
        );
        assert.deepStrictEqual(body.include, ["reasoning.encrypted_content"]);
        assert.ok(!JSON.stringify(body.input).includes("reasoning_"));
    });

    test("preserves id and encrypted state through JSON-serialized chat history", () => {
        const restored = JSON.parse(JSON.stringify(streamedAssistantTurn())) as vscode.LanguageModelResponsePart[];
        const [assistant] = convertMessages([
            { role: vscode.LanguageModelChatMessageRole.Assistant, name: undefined, content: restored },
        ]);
        assert.deepStrictEqual(assistant.thinking_blocks, [
            {
                type: "thinking",
                thinking: "Summary",
                signature: "SYNTHETIC_OPAQUE_STATE",
                id: "rs_original_123",
            },
        ]);
    });

    test("existing one-shot continuity recovery strips invalid reasoning without mutating request", () => {
        const request = requestFor(streamedAssistantTurn());
        const before = JSON.stringify(request);
        const stripped = stripThinkingBlocksFromRequest(request);
        const body = transformToResponsesFormat(stripped, modelInfo);
        assert.ok(!body.input.some((entry) => entry.type === "reasoning"));
        assert.strictEqual(stripped.reasoning_effort, "high");
        assert.strictEqual(JSON.stringify(request), before);
    });
});
