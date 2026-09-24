import * as assert from "assert";
import { createTerminalStats, recordEmittedParts, buildTerminalFingerprint } from "../streamTerminalFingerprint";
import type { EmittedPart } from "../liteLLMStreamInterpreter";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

/**
 * The terminal fingerprint exists to attribute "nothing came back" turns to a
 * concrete cause: gateway classifier reject (completed + 0 output), upstream
 * truncation (incomplete/max_output_tokens), bridge-laundered error (completed
 * with an error field), or transport drop (no terminal event at all). These
 * tests protect the discrimination logic, not the logging plumbing.
 */
suite("streamTerminalFingerprint", () => {
    const finish = (reason?: string): EmittedPart => ({ type: "finish", reason });
    const text = (value: string): EmittedPart => ({ type: "text", value });
    const toolCall = (name: string): EmittedPart => ({
        type: "tool_call",
        index: 0,
        id: `id_${name}`,
        name,
        args: "{}",
    });
    const usage = (promptTokens: number, completionTokens: number, reasoningTokens?: number): EmittedPart => ({
        type: "data",
        mimeType: "usage",
        value: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            ...(reasoningTokens !== undefined
                ? { completion_tokens_details: { reasoning_tokens: reasoningTokens } }
                : {}),
        },
    });

    test("counts text, tool calls, thinking, usage, and finish reasons", () => {
        const stats = createTerminalStats();
        recordEmittedParts(stats, [
            text("hello"),
            { type: "thinking", value: "hmm" },
            toolCall("read_file"),
            usage(100, 20, 5),
            finish("stop"),
        ]);

        assert.strictEqual(stats.textChars, 5);
        assert.strictEqual(stats.thinkingParts, 1);
        assert.strictEqual(stats.toolCallCount, 1);
        assert.strictEqual(stats.finishReasons.length, 1);
        assert.strictEqual(stats.finishReasons[0], "stop");
        assert.strictEqual(stats.promptTokens, 100);
        assert.strictEqual(stats.completionTokens, 20);
        assert.strictEqual(stats.reasoningTokens, 5);
        assert.strictEqual(stats.sawTerminalEvent, true);
    });

    test("empty productive output is classified empty_response and logged at warn", () => {
        // Classifier-reject / laundered-400 signature: terminal arrived, zero
        // text, zero tool calls, zero completion tokens.
        const stats = createTerminalStats();
        recordEmittedParts(stats, [usage(500, 0), finish("stop")]);

        const fp = buildTerminalFingerprint(stats, {
            requestId: "r1",
            model: "azure_ai/gpt-x",
            endpoint: "responses",
            requestHadThinkingBlocks: true,
            requestToolCallCount: 38,
            durationMs: 700,
        });

        assert.strictEqual(fp.classification, "empty_response");
        assert.strictEqual(fp.level, "warn");
        assert.strictEqual(fp.data.requestHadThinkingBlocks, true);
        assert.strictEqual(fp.data.requestToolCallCount, 38);
        assert.strictEqual(fp.data.completionTokens, 0);
    });

    test("truncation finish reasons are classified truncated and logged at warn", () => {
        const stats = createTerminalStats();
        recordEmittedParts(stats, [
            text("partial answer that just sto"),
            usage(100, 4096),
            finish("max_output_tokens"),
        ]);

        const fp = buildTerminalFingerprint(stats, {
            requestId: "r2",
            model: "glm-5.3",
            endpoint: "responses",
            requestHadThinkingBlocks: false,
            requestToolCallCount: 0,
            durationMs: 30000,
        });

        assert.strictEqual(fp.classification, "truncated");
        assert.strictEqual(fp.level, "warn");
        assert.strictEqual(fp.data.finishReasons, "max_output_tokens");
    });

    test("refusal finish is classified refusal and logged at warn", () => {
        const stats = createTerminalStats();
        recordEmittedParts(stats, [finish("refusal")]);

        const fp = buildTerminalFingerprint(stats, {
            requestId: "r3",
            model: "fable-5",
            endpoint: "responses",
            requestHadThinkingBlocks: false,
            requestToolCallCount: 2,
            durationMs: 400,
        });

        assert.strictEqual(fp.classification, "refusal");
        assert.strictEqual(fp.level, "warn");
    });

    test("stream ending with no terminal event is classified no_terminal_event", () => {
        // Transport/bridge drop: deltas arrived but neither a finish part nor a
        // response.completed frame ever came.
        const stats = createTerminalStats();
        recordEmittedParts(stats, [text("some out")]);

        const fp = buildTerminalFingerprint(stats, {
            requestId: "r4",
            model: "m",
            endpoint: "chat",
            requestHadThinkingBlocks: false,
            requestToolCallCount: 0,
            durationMs: 1200,
        });

        assert.strictEqual(fp.classification, "no_terminal_event");
        assert.strictEqual(fp.level, "warn");
    });

    test("healthy turn with output is classified ok and logged at debug", () => {
        const stats = createTerminalStats();
        recordEmittedParts(stats, [text("a full answer"), usage(100, 42), finish("stop")]);

        const fp = buildTerminalFingerprint(stats, {
            requestId: "r5",
            model: "m",
            endpoint: "chat",
            requestHadThinkingBlocks: false,
            requestToolCallCount: 0,
            durationMs: 900,
        });

        assert.strictEqual(fp.classification, "ok");
        assert.strictEqual(fp.level, "debug");
    });

    test("tool-call-only turn (agentic round) is classified ok", () => {
        // Agentic rounds legitimately produce zero text — a tool call IS the output.
        const stats = createTerminalStats();
        recordEmittedParts(stats, [toolCall("run_tests"), usage(2000, 60), finish("tool_calls")]);

        const fp = buildTerminalFingerprint(stats, {
            requestId: "r6",
            model: "m",
            endpoint: "chat",
            requestHadThinkingBlocks: true,
            requestToolCallCount: 4,
            durationMs: 1500,
        });

        assert.strictEqual(fp.classification, "ok");
        assert.strictEqual(fp.level, "debug");
    });

    test("reasoning-only turn with zero visible output is classified empty_response", () => {
        // GLM/Fable burn reasoning tokens then emit nothing visible: the operator
        // must see this as empty (reasoningTokens in data tells the story).
        const stats = createTerminalStats();
        recordEmittedParts(stats, [
            { type: "thinking", value: "long deliberation" },
            usage(100, 900, 900),
            finish("stop"),
        ]);

        const fp = buildTerminalFingerprint(stats, {
            requestId: "r7",
            model: "glm-5.3",
            endpoint: "responses",
            requestHadThinkingBlocks: false,
            requestToolCallCount: 0,
            durationMs: 20000,
        });

        assert.strictEqual(fp.classification, "empty_response");
        assert.strictEqual(fp.data.reasoningTokens, 900);
        assert.strictEqual(fp.data.thinkingParts, 1);
    });

    test("response part marks the terminal as seen even without a finish part", () => {
        // /responses completed frames emit a `response` part but no finish part
        // on the happy path — that still counts as a terminal event.
        const stats = createTerminalStats();
        recordEmittedParts(stats, [text("answer"), { type: "response", usage: { inputTokens: 1, outputTokens: 2 } }]);

        const fp = buildTerminalFingerprint(stats, {
            requestId: "r8",
            model: "m",
            endpoint: "responses",
            requestHadThinkingBlocks: false,
            requestToolCallCount: 0,
            durationMs: 800,
        });

        assert.strictEqual(fp.classification, "ok");
    });
});
