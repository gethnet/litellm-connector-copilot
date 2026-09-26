import type { EmittedPart } from "./liteLLMStreamInterpreter";

/**
 * Terminal-turn fingerprinting — pure accumulation + classification.
 *
 * Why this exists: three different actors can produce a "nothing came back"
 * turn and they are indistinguishable in today's logs —
 *  1. a gateway classifier that intentionally returns an empty completion
 *     (reject-with-null to trigger a server-side fallback),
 *  2. an upstream 4xx laundered into HTTP 200 + empty `completed` by a
 *     LiteLLM bridge (observed on azure_ai with Anthropic thinking-continuity
 *     rejections),
 *  3. a transport/bridge drop where no terminal event arrives at all.
 * Similarly, truncated answers (max_output_tokens / content_filter) look like
 * healthy completions once the stream ends. This module condenses each turn
 * into one structured fingerprint so operators can attribute failures by
 * grepping a single event instead of correlating trace-level noise.
 *
 * Design: `TerminalStats` is a mutable accumulator fed from the existing part
 * stream (no second parse of SSE frames); `buildTerminalFingerprint` is a pure
 * classification of the final stats. Logging is left to the caller so this
 * module stays side-effect free and trivially testable.
 */

/** Mutable per-request accumulator, fed with every emitted part batch. */
export interface TerminalStats {
    textChars: number;
    thinkingParts: number;
    toolCallCount: number;
    finishReasons: string[];
    promptTokens: number | undefined;
    completionTokens: number | undefined;
    reasoningTokens: number | undefined;
    /** Cache-hit size; contextualizes "huge prompt, instant response" timings. */
    cachedTokens: number | undefined;
    /** True once any terminal signal was seen (finish part or /responses response part). */
    sawTerminalEvent: boolean;
}

export function createTerminalStats(): TerminalStats {
    return {
        textChars: 0,
        thinkingParts: 0,
        toolCallCount: 0,
        finishReasons: [],
        promptTokens: undefined,
        completionTokens: undefined,
        reasoningTokens: undefined,
        cachedTokens: undefined,
        sawTerminalEvent: false,
    };
}

interface UsageShape {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
    prompt_tokens_details?: { cached_tokens?: unknown };
}

/** Folds a batch of interpreter-emitted parts into the running stats. */
export function recordEmittedParts(stats: TerminalStats, parts: readonly EmittedPart[]): void {
    for (const part of parts) {
        switch (part.type) {
            case "text":
                stats.textChars += part.value.length;
                break;
            case "thinking":
                stats.thinkingParts++;
                break;
            case "tool_call":
                stats.toolCallCount++;
                break;
            case "finish":
                stats.sawTerminalEvent = true;
                if (part.reason) {
                    stats.finishReasons.push(part.reason);
                }
                break;
            case "response":
                // /responses happy path emits a `response` part but often no
                // finish part — it still proves a terminal frame arrived.
                stats.sawTerminalEvent = true;
                break;
            case "data": {
                if (part.mimeType !== "usage") {
                    break;
                }
                const usage = part.value as UsageShape;
                if (typeof usage.prompt_tokens === "number") {
                    stats.promptTokens = usage.prompt_tokens;
                }
                if (typeof usage.completion_tokens === "number") {
                    stats.completionTokens = usage.completion_tokens;
                }
                const reasoning = usage.completion_tokens_details?.reasoning_tokens;
                if (typeof reasoning === "number") {
                    stats.reasoningTokens = reasoning;
                }
                const cached = usage.prompt_tokens_details?.cached_tokens;
                if (typeof cached === "number") {
                    stats.cachedTokens = cached;
                }
                break;
            }
        }
    }
}

/**
 * Failure-mode buckets, ordered by triage priority. `ok` is the only healthy
 * outcome; everything else is logged at `warn` so it survives default
 * verbosity (per the logging-levels decision table: graceful degradation).
 */
export type TerminalClassification = "refusal" | "truncated" | "failed" | "no_terminal_event" | "empty_response" | "ok";

/** Finish reasons that mean "output was cut short", not "model chose to stop". */
const TRUNCATION_REASONS = new Set(["max_output_tokens", "content_filter", "incomplete", "length"]);

export interface FingerprintContext {
    requestId: string;
    model: string;
    endpoint: string;
    /** Did the request we sent carry prior-turn thinking_blocks? (continuity signal) */
    requestHadThinkingBlocks: boolean;
    /** Assistant tool-call history size in the request (agentic depth signal). */
    requestToolCallCount: number;
    durationMs: number;
}

export interface TerminalFingerprint {
    classification: TerminalClassification;
    /** Log level the caller should use: warn for anything abnormal, debug for ok. */
    level: "warn" | "debug";
    /** Flat payload ready for StructuredLogger — no nested objects, no PII. */
    data: {
        classification: TerminalClassification;
        finishReasons: string;
        textChars: number;
        thinkingParts: number;
        toolCallCount: number;
        promptTokens: number | undefined;
        completionTokens: number | undefined;
        reasoningTokens: number | undefined;
        cachedTokens: number | undefined;
        sawTerminalEvent: boolean;
        requestHadThinkingBlocks: boolean;
        requestToolCallCount: number;
        durationMs: number;
    };
}

/**
 * Classifies the finished turn. Rules, first match wins:
 *  1. refusal finish → `refusal` (model/classifier explicitly declined)
 *  2. failed finish → `failed` (upstream error surfaced on the stream)
 *  3. truncation finish → `truncated` (output cut: budget or filter)
 *  4. no terminal event at all → `no_terminal_event` (transport/bridge drop)
 *  5. terminal arrived but zero productive output (no text, no tool calls,
 *     0/absent completion-token signal beyond reasoning) → `empty_response`
 *     — the classifier-reject / laundered-400 signature
 *  6. otherwise → `ok`
 *
 * A tool-call-only round is `ok`: in agentic loops the tool call IS the output.
 * Reasoning tokens alone do NOT count as productive output — a turn that burned
 * reasoning budget but emitted nothing visible is still empty to the user.
 */
export function buildTerminalFingerprint(stats: TerminalStats, context: FingerprintContext): TerminalFingerprint {
    const hasProductiveOutput = stats.textChars > 0 || stats.toolCallCount > 0;

    let classification: TerminalClassification;
    if (stats.finishReasons.includes("refusal")) {
        classification = "refusal";
    } else if (stats.finishReasons.includes("failed")) {
        classification = "failed";
    } else if (stats.finishReasons.some((reason) => TRUNCATION_REASONS.has(reason))) {
        classification = "truncated";
    } else if (!stats.sawTerminalEvent) {
        classification = "no_terminal_event";
    } else if (!hasProductiveOutput) {
        classification = "empty_response";
    } else {
        classification = "ok";
    }

    return {
        classification,
        level: classification === "ok" ? "debug" : "warn",
        data: {
            classification,
            finishReasons: stats.finishReasons.join(","),
            textChars: stats.textChars,
            thinkingParts: stats.thinkingParts,
            toolCallCount: stats.toolCallCount,
            promptTokens: stats.promptTokens,
            completionTokens: stats.completionTokens,
            reasoningTokens: stats.reasoningTokens,
            cachedTokens: stats.cachedTokens,
            sawTerminalEvent: stats.sawTerminalEvent,
            requestHadThinkingBlocks: context.requestHadThinkingBlocks,
            requestToolCallCount: context.requestToolCallCount,
            durationMs: context.durationMs,
        },
    };
}
