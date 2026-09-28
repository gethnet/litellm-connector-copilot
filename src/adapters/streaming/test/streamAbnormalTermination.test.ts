import * as assert from "assert";
import { evaluateAbnormalTermination, StreamAbnormalTerminationError } from "../streamAbnormalTermination";
import type { TerminalFingerprint, TerminalClassification } from "../streamTerminalFingerprint";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

/**
 * The abnormal-termination evaluator decides when a finished stream should be
 * surfaced to VS Code as a thrown error instead of a silent empty turn.
 *
 * Deployment model this protects (agreed 2026-09-28): server-side recovery
 * (LiteLLM fallback models) is the INTENDED handler for classifier rejects and
 * upstream failures. If an abnormal terminal reaches this client, that
 * recovery either isn't configured or already failed — so the user must see
 * an error rather than Copilot silently retrying into a possibly poisoned
 * proxy cache.
 */
suite("streamAbnormalTermination", () => {
    const fingerprint = (
        classification: TerminalClassification,
        overrides: Partial<TerminalFingerprint["data"]> = {}
    ): TerminalFingerprint => ({
        classification,
        level: classification === "ok" ? "debug" : "warn",
        data: {
            classification,
            finishReasons: "",
            textChars: 0,
            thinkingParts: 0,
            toolCallCount: 0,
            promptTokens: undefined,
            completionTokens: undefined,
            reasoningTokens: undefined,
            cachedTokens: undefined,
            sawTerminalEvent: true,
            requestHadThinkingBlocks: false,
            requestToolCallCount: 0,
            durationMs: 1000,
            ...overrides,
        },
    });

    test("ok turns never produce an error", () => {
        assert.strictEqual(evaluateAbnormalTermination(fingerprint("ok", { textChars: 50 })), undefined);
    });

    test("refusals never produce an error (already surfaced as a finish reason)", () => {
        assert.strictEqual(
            evaluateAbnormalTermination(fingerprint("refusal", { finishReasons: "refusal" })),
            undefined
        );
    });

    test("truncated with zero output throws (the cache-replay/transport-drop signature)", () => {
        const error = evaluateAbnormalTermination(
            fingerprint("truncated", {
                finishReasons: "incomplete",
                promptTokens: 311848,
                completionTokens: 1970,
            })
        );

        assert.ok(error instanceof StreamAbnormalTerminationError);
        assert.strictEqual(error.classification, "truncated");
        assert.strictEqual(error.finishReasons, "incomplete");
    });

    test("truncated with partial text still throws (user chose error over marker text)", () => {
        // Parts already emitted stay rendered in the UI; the throw ends the
        // turn with a visible explanation instead of a silent amputation.
        const error = evaluateAbnormalTermination(
            fingerprint("truncated", { finishReasons: "max_output_tokens", textChars: 800 })
        );

        assert.ok(error instanceof StreamAbnormalTerminationError);
    });

    test("failed terminals throw", () => {
        const error = evaluateAbnormalTermination(fingerprint("failed", { finishReasons: "failed" }));

        assert.ok(error instanceof StreamAbnormalTerminationError);
        assert.strictEqual(error.classification, "failed");
    });

    test("empty_response throws — server-side fallback should have handled it", () => {
        const error = evaluateAbnormalTermination(
            fingerprint("empty_response", { completionTokens: 0, promptTokens: 500 })
        );

        assert.ok(error instanceof StreamAbnormalTerminationError);
        assert.strictEqual(error.classification, "empty_response");
    });

    test("tool-call rounds never throw, even when the terminal says incomplete", () => {
        // An agentic round's tool call IS the productive output; throwing
        // would discard usable work Copilot is about to execute.
        const error = evaluateAbnormalTermination(
            fingerprint("truncated", { finishReasons: "incomplete", toolCallCount: 2 })
        );

        assert.strictEqual(error, undefined);
    });

    test("no_terminal_event with zero text throws (transport drop, nothing arrived)", () => {
        const error = evaluateAbnormalTermination(fingerprint("no_terminal_event", { sawTerminalEvent: false }));

        assert.ok(error instanceof StreamAbnormalTerminationError);
        assert.strictEqual(error.classification, "no_terminal_event");
    });

    test("no_terminal_event with text does NOT throw (backends may close without terminal frames)", () => {
        const error = evaluateAbnormalTermination(
            fingerprint("no_terminal_event", { textChars: 400, sawTerminalEvent: false })
        );

        assert.strictEqual(error, undefined);
    });

    test("error message carries guidance, diagnostics, and the stable sentinel anchor", () => {
        const error = evaluateAbnormalTermination(
            fingerprint("truncated", {
                finishReasons: "incomplete",
                promptTokens: 311848,
                completionTokens: 1970,
                reasoningTokens: 688,
                durationMs: 31566,
            })
        );

        assert.ok(error instanceof StreamAbnormalTerminationError);
        assert.ok(error.message.includes("truncated"), "message names the classification");
        assert.ok(error.message.includes("incomplete"), "message carries the finish reason");
        assert.ok(/retry/i.test(error.message), "message advises against blind retries");
        // Stable sentinel: if verification ever shows error text leaking into
        // conversation context, this is the redaction anchor. Role-gated
        // redaction would match ONLY assistant-authored occurrences.
        assert.ok(error.message.includes("[litellm-connector:abnormal-termination]"));
        assert.strictEqual(error.name, "StreamAbnormalTerminationError");
    });
});
