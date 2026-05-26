import * as assert from "assert";
import * as vscode from "vscode";
import { StreamTokenCapture } from "../streamTokenCapture";

suite("StreamTokenCapture", () => {
    function createInnerProgress(): {
        parts: vscode.LanguageModelResponsePart[];
        progress: vscode.Progress<vscode.LanguageModelResponsePart>;
    } {
        const parts: vscode.LanguageModelResponsePart[] = [];
        const progress: vscode.Progress<vscode.LanguageModelResponsePart> = {
            report: (part) => parts.push(part),
        };
        return { parts, progress };
    }

    function asTextPart(value: string): vscode.LanguageModelTextPart {
        return new vscode.LanguageModelTextPart(value);
    }

    function asThinkingPart(value: string | string[]): vscode.LanguageModelResponsePart {
        const ThinkingPartCtor = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as
            | (new (
                  value: string | string[],
                  id?: string,
                  metadata?: Record<string, unknown>
              ) => vscode.LanguageModelResponsePart)
            | undefined;
        if (ThinkingPartCtor) {
            return new ThinkingPartCtor(value);
        }
        // Fallback: encoded as TextPart("*value*")
        const str = Array.isArray(value) ? value.join("") : value;
        return new vscode.LanguageModelTextPart(`*${str}*`);
    }

    function asToolCallPart(
        name: string,
        args: Record<string, unknown>,
        callId = "id-1"
    ): vscode.LanguageModelToolCallPart {
        return new vscode.LanguageModelToolCallPart(callId, name, args);
    }

    function asUsagePart(payload: Record<string, unknown>): vscode.LanguageModelDataPart {
        const bytes = new TextEncoder().encode(JSON.stringify(payload));
        return new vscode.LanguageModelDataPart(bytes, "usage");
    }

    test("captures text and reasoning into snapshot when no upstream usage", () => {
        const { parts, progress } = createInnerProgress();
        const capture = new StreamTokenCapture("model-x", progress);

        const tracking = capture.progress;
        tracking.report(asTextPart("Hello "));
        tracking.report(asThinkingPart("thoughts"));
        tracking.report(asTextPart("world"));

        const snapshot = capture.getSnapshot();
        assert.strictEqual(parts.length, 3);
        assert.strictEqual(snapshot.sawUpstreamUsage, false);
        assert.ok(snapshot.completionTokens > 0, "should count completion tokens");
        assert.ok(snapshot.reasoningTokens > 0, "should count reasoning tokens");
        assert.strictEqual(snapshot.promptTokens, 0);
        assert.strictEqual(snapshot.cachedTokens, 0);
        assert.strictEqual(snapshot.toolTokens, 0);
    });

    test("captures tool call token estimate", () => {
        const { progress } = createInnerProgress();
        const capture = new StreamTokenCapture("model-x", progress);
        const tracking = capture.progress;

        tracking.report(asToolCallPart("myTool", { a: 1 }));

        const snapshot = capture.getSnapshot();
        assert.ok(snapshot.toolTokens > 0, "expected tool tokens to be estimated");
    });

    test("captures upstream usage from data part and prefers it over internal counts", () => {
        const { parts, progress } = createInnerProgress();
        const capture = new StreamTokenCapture("model-x", progress);
        const tracking = capture.progress;

        tracking.report(asTextPart("ignored"));
        tracking.report(asUsagePart({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }));

        const snapshot = capture.getSnapshot();
        assert.strictEqual(snapshot.promptTokens, 5);
        assert.strictEqual(snapshot.completionTokens, 2);
        assert.strictEqual(snapshot.sawUpstreamUsage, true);
        // Ensure enriched usage was forwarded
        const usage = parts.find((p) => p instanceof vscode.LanguageModelDataPart) as vscode.LanguageModelDataPart;
        assert.ok(usage, "expected forwarded usage data part");
        assert.strictEqual(usage.mimeType, "usage");
    });

    test("forwards every part to inner progress", () => {
        const { parts, progress } = createInnerProgress();
        const capture = new StreamTokenCapture("model-x", progress);
        const tracking = capture.progress;

        const text = asTextPart("hi");
        const tool = asToolCallPart("t", {});
        const usage = asUsagePart({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        const thinking = asThinkingPart("hmm");

        tracking.report(text);
        tracking.report(tool);
        tracking.report(usage);
        tracking.report(thinking);

        assert.strictEqual(parts.length, 4);
        assert.ok(parts[0] instanceof vscode.LanguageModelTextPart);
        assert.ok(parts[1] instanceof vscode.LanguageModelToolCallPart);
        assert.ok(parts[2] instanceof vscode.LanguageModelDataPart);
        // Thinking fallback may be TextPart or ThinkingPart depending on host
        const thinkingPart = parts[3];
        const ThinkingCtor = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as
            | (new (
                  value: string | string[],
                  id?: string,
                  metadata?: Record<string, unknown>
              ) => vscode.LanguageModelResponsePart)
            | undefined;
        const isThinking = ThinkingCtor
            ? thinkingPart instanceof ThinkingCtor
            : thinkingPart instanceof vscode.LanguageModelTextPart;
        assert.ok(isThinking, "expected fourth part to be thinking/text part");

        const payload = JSON.parse(Buffer.from((parts[2] as vscode.LanguageModelDataPart).data).toString("utf-8")) as {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
            completion_tokens_details?: { tool_tokens?: number };
        };
        assert.strictEqual(payload.prompt_tokens, 1);
        assert.strictEqual(payload.completion_tokens, 1);
        assert.strictEqual(payload.total_tokens, 2);
        assert.strictEqual((payload.completion_tokens_details?.tool_tokens ?? 0) > 0, true);
    });

    test("merge is monotonic across multiple usage frames", () => {
        const { progress } = createInnerProgress();
        const capture = new StreamTokenCapture("model-x", progress);
        const tracking = capture.progress;

        tracking.report(asUsagePart({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }));
        tracking.report(asUsagePart({ prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }));

        const snapshot = capture.getSnapshot();
        assert.strictEqual(snapshot.promptTokens, 4);
        assert.strictEqual(snapshot.completionTokens, 2, "should pick max completion tokens");
    });

    test("thinking detection checks ThinkingPart before TextPart fallback", () => {
        const { progress } = createInnerProgress();
        const capture = new StreamTokenCapture("model-x", progress);
        const tracking = capture.progress;

        const thinking = asThinkingPart("ponder");
        const text = asTextPart("plain");

        tracking.report(thinking);
        tracking.report(text);

        const snapshot = capture.getSnapshot();
        assert.ok(snapshot.reasoningTokens > 0);
        assert.ok(snapshot.completionTokens >= snapshot.reasoningTokens);
    });

    test("input estimates are honored when no upstream usage", () => {
        const { progress } = createInnerProgress();
        const capture = new StreamTokenCapture("model-x", progress);
        capture.setEstimatedPromptTokens(10);
        capture.setEstimatedSystemPromptTokens(2);
        capture.setReservedOutputTokens(50);
        capture.setTotalTokenMax(100);

        const snapshot = capture.getSnapshot();
        assert.strictEqual(snapshot.promptTokens, 10);
        assert.strictEqual(snapshot.systemPromptTokens, 2);
    });

    test("enriches forwarded usage with reserved and tool tokens", () => {
        const { parts, progress } = createInnerProgress();
        const capture = new StreamTokenCapture("model-x", progress);
        capture.setReservedOutputTokens(77);
        capture.setTotalTokenMax(123);
        const tracking = capture.progress;

        tracking.report(asToolCallPart("toolA", { x: 1 }));
        tracking.report(
            asUsagePart({
                prompt_tokens: 2,
                completion_tokens: 1,
                total_tokens: 3,
                completion_tokens_details: {},
            })
        );

        const usage = parts.find((p) => p instanceof vscode.LanguageModelDataPart) as vscode.LanguageModelDataPart;
        assert.ok(usage, "expected forwarded usage part");
        const payload = JSON.parse(Buffer.from(usage.data).toString("utf-8")) as {
            reserved_output_tokens?: number;
            total_token_max?: number;
            completion_tokens_details?: { tool_tokens?: number };
        };
        assert.strictEqual(payload.reserved_output_tokens, 77);
        assert.strictEqual(payload.total_token_max, 123);
        assert.strictEqual(typeof payload.completion_tokens_details?.tool_tokens, "number");

        const snapshot = capture.getSnapshot();
        assert.ok(snapshot.toolTokens > 0, "snapshot should still reflect tool estimate");
    });
});
