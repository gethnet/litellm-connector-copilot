import type { OpenAIChatCompletionRequest, OpenAIChatMessage } from "../../types";

/**
 * Pure helpers for one-shot recovery from model-switch continuity rejection.
 *
 * These functions own only detection, redaction, and retry classification of
 * prior-turn `thinking_blocks`. They never touch top-level native reasoning
 * fields (`reasoning_effort`, adaptive `thinking`, `output_config`) so the
 * live retry coordinator can redact continuity without regressing native
 * reasoning transport.
 */

/** Resolves an HTTP-like status from an error object or embedded message text. */
function getErrorStatus(error: unknown): number | undefined {
    if (error && typeof error === "object") {
        const status = (error as { status?: unknown }).status;
        const statusCode = (error as { statusCode?: unknown }).statusCode;
        if (typeof status === "number") {
            return status;
        }
        if (typeof statusCode === "number") {
            return statusCode;
        }
    }

    // Some LiteLLM errors surface the status only inside the message body,
    // e.g. "LiteLLM API error: 400 Bad Request\n<details>".
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    const match = /LiteLLM API error:\s*(\d{3})/i.exec(message);
    return match ? Number(match[1]) : undefined;
}

/** Best-effort extraction of a human-readable message from an unknown error. */
function getErrorText(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === "string") {
        return error;
    }
    if (error && typeof error === "object" && "message" in error) {
        const message = (error as { message?: unknown }).message;
        return typeof message === "string" ? message : "";
    }
    return "";
}

/**
 * Returns `true` only when at least one assistant message carries a non-empty
 * `thinking_blocks` array. Used to gate the continuity retry so requests that
 * never carried continuity are never redacted.
 */
export function requestHasThinkingBlocks(request: OpenAIChatCompletionRequest): boolean {
    return request.messages.some(
        (message) => Array.isArray(message.thinking_blocks) && message.thinking_blocks.length > 0
    );
}

function stripThinkingBlocksFromMessages(messages: readonly OpenAIChatMessage[]): OpenAIChatMessage[] {
    return messages.map((message) => {
        if (!Array.isArray(message.thinking_blocks) || message.thinking_blocks.length === 0) {
            return message;
        }
        // Shallow-copy the message and remove only the continuity field so the
        // caller's original message array and all other fields stay intact.
        const copy: OpenAIChatMessage = { ...message };
        delete copy.thinking_blocks;
        return copy;
    });
}

/**
 * Removes prior-turn continuity only; top-level native reasoning is preserved.
 * Returns a new request with a new messages array; the original request is not
 * mutated.
 */
export function stripThinkingBlocksFromRequest(request: OpenAIChatCompletionRequest): OpenAIChatCompletionRequest {
    return {
        ...request,
        messages: stripThinkingBlocksFromMessages(request.messages),
    };
}

/**
 * Allows one retry only for HTTP 400 errors that identify rejected continuity.
 *
 * Recognized rejections:
 * - messages mentioning thinking blocks with rejection wording
 *   (invalid / not supported / unsupported / unknown parameter / unexpected)
 * - a missing-block-discriminant validation error
 *   (`messages.N.content.M.type: Field required`) — a narrow compatibility
 *   exception for the exact shape produced when the prior serializer omitted
 *   the `type` discriminant.
 *
 * Authentication, authorization, quota, cancellation, overflow, 5xx, network,
 * and configuration failures are intentionally excluded so the retry cannot
 * mask unrelated failures.
 */
export function isThinkingBlockRetryableError(error: unknown): boolean {
    if (getErrorStatus(error) !== 400) {
        return false;
    }

    // Strip backticks and quotes so provider messages like
    // "Invalid `signature` in `thinking` block" still match the `thinking block`
    // substring. This is normalization of formatting, not of the error class.
    const text = getErrorText(error)
        .toLowerCase()
        .replace(/[`"'*]/g, "");
    const identifiesThinking =
        text.includes("thinking_blocks") ||
        text.includes("thinking block") ||
        text.includes("thinking.signature") ||
        text.includes("redacted_thinking");
    const identifiesRejection =
        text.includes("invalid") ||
        text.includes("not supported") ||
        text.includes("unsupported") ||
        text.includes("unknown parameter") ||
        text.includes("unexpected");

    const identifiesMissingBlockDiscriminant = /messages\.\d+\.content\.\d+\.type:\s*field required/.test(text);

    return (identifiesThinking && identifiesRejection) || identifiesMissingBlockDiscriminant;
}
