import type { TerminalFingerprint, TerminalClassification } from "./streamTerminalFingerprint";

/**
 * Abnormal-termination surfacing — pure decision logic.
 *
 * Why this exists: the VS Code LanguageModelChatProvider API has no
 * finish-reason channel. A truncated or empty turn that ends without a thrown
 * error looks like a successful empty response, and Copilot's host silently
 * retries those — which we observed replaying a poisoned LiteLLM response
 * cache 3× with byte-identical usage (2026-09-25 captures). The ONLY
 * mechanisms a provider has are emitted parts and thrown errors, so an
 * abnormal terminal must end the turn with a throw to become visible.
 *
 * Deployment contract (agreed 2026-09-28): server-side recovery — LiteLLM
 * fallback model chains — is the intended handler for classifier rejects and
 * upstream failures, transparently to this client. Therefore any abnormal
 * terminal that reaches us means that recovery is unconfigured or exhausted:
 * surfacing an error is correct, and a blind client-side retry would only
 * mask a misconfigured proxy (or re-read a poisoned cache entry).
 *
 * Decision rules (see `evaluateAbnormalTermination`):
 *  - `ok` and `refusal` never throw. Refusals are an explicit model decision
 *    already carried on the stream; re-raising them as transport errors would
 *    misattribute them.
 *  - Any turn that produced a tool call never throws — in agentic loops the
 *    tool call IS the productive output and Copilot will act on it.
 *  - `truncated` / `failed` / `empty_response` throw. For truncated turns
 *    with partial text the parts already emitted remain rendered; the throw
 *    replaces the silent amputation with a visible cause (user explicitly
 *    chose this over injecting synthetic marker text into history).
 *  - `no_terminal_event` throws only when no text arrived: some
 *    chat-completions backends legitimately close streams without a terminal
 *    frame after streaming a full answer.
 *
 * The error message embeds a stable sentinel
 * (`[litellm-connector:abnormal-termination]`). Working assumption: thrown
 * provider errors are rendered as error blocks and never replayed into
 * conversation context. If live verification ever disproves that, the
 * sentinel is the redaction anchor — matching must then be role-gated to
 * assistant-authored content so user-pasted error text is never touched.
 */

/** Stable anchor for potential future context redaction. Never change casually. */
export const ABNORMAL_TERMINATION_SENTINEL = "[litellm-connector:abnormal-termination]";

/** Typed error so transport/retry layers can discriminate this from HTTP failures. */
export class StreamAbnormalTerminationError extends Error {
    public readonly classification: TerminalClassification;
    public readonly finishReasons: string;

    constructor(classification: TerminalClassification, finishReasons: string, message: string) {
        super(message);
        this.name = "StreamAbnormalTerminationError";
        this.classification = classification;
        this.finishReasons = finishReasons;
    }
}

/** Human-facing cause line per classification (kept terse — this renders in chat). */
const CLASSIFICATION_SUMMARIES: Record<Exclude<TerminalClassification, "ok" | "refusal">, string> = {
    truncated: "The response was truncated upstream before completion",
    failed: "The upstream provider reported a failure for this response",
    empty_response: "The backend returned an empty response",
    no_terminal_event: "The stream ended without any terminal event (transport drop)",
};

/**
 * Decides whether a finished stream must be surfaced as a thrown error.
 * Returns the error to throw, or `undefined` for healthy/acceptable turns.
 * Pure function of the fingerprint — no logging, no side effects.
 */
export function evaluateAbnormalTermination(
    fingerprint: TerminalFingerprint
): StreamAbnormalTerminationError | undefined {
    const { classification, data } = fingerprint;

    if (classification === "ok" || classification === "refusal") {
        return undefined;
    }
    // A tool call is productive output — throwing would discard work the
    // host is about to execute. Truncation after a complete tool call is
    // indistinguishable from a normal agentic round from the user's side.
    if (data.toolCallCount > 0) {
        return undefined;
    }
    // Some backends close chat-completions streams without a terminal frame
    // after a complete answer; only treat that as a failure when nothing
    // user-visible arrived.
    if (classification === "no_terminal_event" && data.textChars > 0) {
        return undefined;
    }

    const summary = CLASSIFICATION_SUMMARIES[classification];
    const reasonSuffix = data.finishReasons ? ` (reason: ${data.finishReasons})` : "";
    const tokenDetail =
        typeof data.completionTokens === "number"
            ? ` ${data.completionTokens} output tokens (${data.reasoningTokens ?? 0} reasoning), ${data.textChars} visible characters.`
            : "";

    const message =
        `${ABNORMAL_TERMINATION_SENTINEL} ${summary}${reasonSuffix} — classification: ${classification}.` +
        tokenDetail +
        " Do not blindly retry the identical request: if the LiteLLM proxy has fallback models configured they were already exhausted, and identical retries can be served a cached copy of this same failure. " +
        "Consider retrying manually, reducing the conversation size, or checking the proxy's fallback/caching configuration.";

    return new StreamAbnormalTerminationError(classification, data.finishReasons, message);
}
