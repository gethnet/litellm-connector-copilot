import * as vscode from "vscode";
import type { LanguageModelChatRequestMessage } from "vscode";
import type { OpenAIChatCompletionRequest } from "../../types";
import type { LiteLLMModelInfo } from "../../types";
import { Logger } from "../../utils/logger";
import { LiteLLMTelemetry } from "../../utils/telemetry";

/**
 * Tools the detector knows how to redact. Kept narrow on purpose — the
 * legacy detector only knew `insert_edit_into_file` and
 * `replace_string_in_file`. Adding more here is a deliberate code change
 * and must come with a test that exercises a real tool result for the new
 * tool name (not just a substring match in prompt scaffolding).
 */
export const REDACTABLE_TOOL_NAMES: readonly string[] = ["insert_edit_into_file", "replace_string_in_file"] as const;

export const QUOTA_PHRASE_REGEX =
    /(\b429\b|rate\s*limit\s*exceeded|rate\s*limited|too\s*many\s*requests|insufficient\s*quota|quota\s*exceeded|exceeded\s*your\s*current\s*quota)/i;

/**
 * Dependencies the pure quota-redaction detector needs from its caller.
 * Injecting these (instead of closing over `this`) keeps the module pure
 * and testable in isolation; the base provider wires real implementations.
 */
export interface QuotaRedactionDeps {
    /** Reports a quota-redaction telemetry metric. Defaults to `LiteLLMTelemetry.reportMetric`. */
    reportMetric?: (metric: {
        requestId: string;
        model: string;
        status: "success" | "failure" | "caching_bypassed";
        error: string;
        caller?: string;
    }) => void;
}

/**
 * Result of scanning message history for a quota error.
 *
 * - `high`   — a real provider 429 attached to a tool result for a redactable tool.
 * - `low`    — a quota phrase in non-tool-result text (observability only, no redaction).
 * - `none`   — no quota phrase found anywhere actionable.
 */
export type QuotaRedactionConfidence = "none" | "low" | "high";

export interface QuotaRedactionResult {
    tools: readonly vscode.LanguageModelChatTool[];
    confidence: QuotaRedactionConfidence;
}

/**
 * Decides whether the conversation history contains a real provider-side
 * quota error attached to a tool call we know how to redact, and if so
 * returns a filtered tools list with the offending tool removed for the
 * current turn.
 *
 * High-confidence match: a `LanguageModelToolResultPart` whose text
 * contains a quota phrase AND whose `callId` resolves to one of the
 * `REDACTABLE_TOOL_NAMES` tools (verified by walking the messages in
 * reverse to find the matching `LanguageModelToolCallPart`).
 *
 * Low-confidence match: a quota phrase appearing in any other text
 * content. This is returned for observability (DEBUG log, telemetry
 * counter) but does NOT trigger redaction.
 *
 * None: no quota phrase anywhere actionable.
 */
export function detectQuotaToolRedaction(
    messages: readonly LanguageModelChatRequestMessage[],
    tools: readonly vscode.LanguageModelChatTool[],
    requestId: string,
    modelId: string,
    disableRedaction: boolean,
    caller: string | undefined,
    deps: QuotaRedactionDeps = {}
): QuotaRedactionResult {
    // Wrap the static call in an arrow function so `LiteLLMTelemetry` keeps its
    // `this` binding. Taking a bare method reference (`LiteLLMTelemetry.reportMetric`)
    // would detach it from the class and crash on `this._telemetryService`.
    const reportMetric = deps.reportMetric ?? ((metric) => LiteLLMTelemetry.reportMetric(metric));

    if (disableRedaction || !tools.length || !messages.length) {
        return { tools, confidence: "none" };
    }

    const quotaMatch = findQuotaErrorInMessages(messages);
    if (!quotaMatch) {
        return { tools, confidence: "none" };
    }

    const { toolName, errorText, turnIndex, confidence } = quotaMatch;

    // Low-confidence matches (e.g. a quota phrase mentioned in
    // <reminderInstructions> or a user prompt about quotas) are logged
    // at DEBUG and do NOT trigger redaction or telemetry. High-confidence
    // matches (a real provider 429 in a tool result) keep the existing
    // WARN + telemetry behavior.
    if (confidence !== "high") {
        // For low-confidence matches, only report as "low" if there's a
        // redactable tool in the tools list. Otherwise, treat as "none"
        // since there's nothing actionable.
        const hasRedactableTool = tools.some((t) => REDACTABLE_TOOL_NAMES.includes(t.name));
        const reportedConfidence = hasRedactableTool ? confidence : "none";
        Logger.debug("Quota phrase detected in non-tool-result text; not redacting", {
            toolName,
            modelId,
            requestId,
            turnIndex,
            confidence: reportedConfidence,
        });
        return { tools, confidence: reportedConfidence };
    }

    const toolNames = new Set(tools.map((tool) => tool.name));
    if (!toolNames.has(toolName)) {
        Logger.debug("Quota error detected, but tool not present", { toolName, requestId, modelId, turnIndex });
        return { tools, confidence };
    }

    const filteredTools = tools.filter((tool) => tool.name !== toolName);
    Logger.warn("Quota error detected; redacting tool for current turn", {
        toolName,
        errorText,
        modelId,
        requestId,
        turnIndex,
    });
    reportMetric({
        requestId,
        model: modelId,
        status: "failure",
        error: `quota_exceeded:${toolName}`,
        ...(caller && { caller }),
    });

    return { tools: filteredTools, confidence };
}

/**
 * Detects whether the conversation history contains a real provider-side
 * quota error attached to a tool call we know how to redact.
 *
 * High-confidence match: a `LanguageModelToolResultPart` whose text
 * contains a quota phrase AND whose `callId` resolves to one of the
 * `REDACTABLE_TOOL_NAMES` tools (verified by walking the messages in
 * reverse to find the matching `LanguageModelToolCallPart`).
 *
 * Low-confidence match: a quota phrase appearing in any other text
 * content. This is returned for observability (DEBUG log, telemetry
 * counter) but does NOT trigger redaction.
 *
 * None: no quota phrase anywhere in the message text.
 */
export function findQuotaErrorInMessages(messages: readonly LanguageModelChatRequestMessage[]):
    | {
          toolName: string;
          errorText: string;
          turnIndex: number;
          confidence: QuotaRedactionConfidence;
      }
    | undefined {
    // 1. Walk messages in reverse to find a tool result that contains a
    //    quota phrase. The result's `callId` anchors the match.
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        const toolResultHit = findQuotaInToolResults(message);
        if (toolResultHit) {
            const owningToolName = lookupToolNameForCallId(messages, toolResultHit.callId);
            if (owningToolName && REDACTABLE_TOOL_NAMES.includes(owningToolName)) {
                return {
                    toolName: owningToolName,
                    errorText: sanitizeErrorTextForLogs(toolResultHit.text),
                    turnIndex: i,
                    confidence: "high",
                };
            }
            // Tool result is for a tool we don't redact. Treat as
            // low-confidence (observability only) and keep walking.
            return {
                toolName: owningToolName ?? toolResultHit.callId,
                errorText: sanitizeErrorTextForLogs(toolResultHit.text),
                turnIndex: i,
                confidence: "low",
            };
        }
    }

    // 2. No qualifying tool result. Look for a quota phrase in any
    //    OTHER text content. Strip Copilot wrappers first so we never
    //    match the scaffolding. Only report as "low" if we find BOTH
    //    a quota phrase AND a tool name in the text (mimicking original
    //    behavior). If only quota is found without a tool name, treat
    //    as "none" since there's nothing to redact.
    const toolRegex = /(insert_edit_into_file|replace_string_in_file)/i;
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        const text = collectMessageText(message);
        if (!text) {
            continue;
        }
        const stripped = stripCopilotWrappers(text);
        if (!stripped) {
            continue;
        }
        if (!QUOTA_PHRASE_REGEX.test(stripped)) {
            continue;
        }
        // Check if there's also a tool name in the text
        const toolMatch = stripped.match(toolRegex);
        if (!toolMatch) {
            // Quota phrase found but no tool name - not actionable
            continue;
        }
        return {
            toolName: "",
            errorText: sanitizeErrorTextForLogs(text),
            turnIndex: i,
            confidence: "low",
        };
    }

    return undefined;
}

/**
 * Returns the first quota phrase match that lives inside a
 * `LanguageModelToolResultPart` on this message, plus the `callId` of
 * that tool result. Returns `undefined` if no tool result part contains
 * a quota phrase.
 */
export function findQuotaInToolResults(
    message: LanguageModelChatRequestMessage
): { callId: string; text: string } | undefined {
    const parts = message.content ?? [];
    for (const part of parts) {
        if (!(part instanceof vscode.LanguageModelToolResultPart)) {
            continue;
        }
        const text = collectPartText(part.content);
        if (!text) {
            continue;
        }
        if (!QUOTA_PHRASE_REGEX.test(text)) {
            continue;
        }
        return { callId: part.callId, text };
    }
    return undefined;
}

/**
 * Walks messages in reverse to find the assistant turn that produced
 * `callId` via a `LanguageModelToolCallPart` and returns the tool name
 * declared there. Returns `undefined` if no matching tool call is found.
 */
export function lookupToolNameForCallId(
    messages: readonly LanguageModelChatRequestMessage[],
    callId: string
): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const parts = messages[i].content ?? [];
        for (const part of parts) {
            if (part instanceof vscode.LanguageModelToolCallPart && part.callId === callId) {
                return part.name;
            }
        }
    }
    return undefined;
}

/**
 * Text-only projection of a tool result's content array. Mirrors
 * `collectMessageText` but operates on a single part's `content` field
 * (which is itself an array of `LanguageModelTextPart`-shaped objects).
 */
export function collectPartText(content: readonly unknown[]): string {
    let text = "";
    for (const part of content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            text += part.value;
        } else if (typeof part === "string") {
            text += part;
        }
    }
    return text.trim();
}

/**
 * Text-only projection of a chat message's content parts. Concatenates
 * `LanguageModelTextPart` values and bare string parts into a single
 * trimmed string. Returns the empty string when no text parts are present.
 */
export function collectMessageText(message: LanguageModelChatRequestMessage): string {
    const parts = message.content ?? [];
    let text = "";
    for (const part of parts) {
        if (part instanceof vscode.LanguageModelTextPart) {
            text += part.value;
        } else if (typeof part === "string") {
            text += part;
        }
    }
    return text.trim();
}

/**
 * Strips Copilot-injected prompt scaffolding wrappers from `text` and
 * returns the cleaned, trimmed result. Applied *before* the quota regex
 * runs so the detector never matches on prompt scaffolding.
 *
 * Why this exists: Copilot Chat injects `<context>`, `<editorContext>`,
 * `<reminderInstructions>`, and `<userRequest>` blocks into every user
 * message. The `<reminderInstructions>` block routinely documents the
 * exact tool-error handling rules that contain both the quota phrase
 * and the `insert_edit_into_file` / `replace_string_in_file` tool names
 * — a structural false positive for the legacy regex-pair detector.
 *
 * Invariant: this function is pure (no I/O, no side effects). The
 * original `text` is not mutated.
 */
export function stripCopilotWrappers(text: string): string {
    const trimmed = (text || "").trim();
    if (!trimmed) {
        return "";
    }
    return trimmed
        .replace(/<context>[\s\S]*?<\/context>/gi, "")
        .replace(/<editorContext>[\s\S]*?<\/editorContext>/gi, "")
        .replace(/<reminderInstructions>[\s\S]*?<\/reminderInstructions>/gi, "")
        .replace(/<userRequest>[\s\S]*?<\/userRequest>/gi, "")
        .trim();
}

/**
 * Sanitizes an error string for logging: collapses Copilot context
 * wrappers to ellipsis placeholders and truncates the result to 500
 * characters so logs never carry full prompt payloads.
 */
export function sanitizeErrorTextForLogs(text: string): string {
    const trimmed = (text || "").trim();
    if (!trimmed) {
        return "";
    }

    const withoutCopilotContext = trimmed
        .replace(/<context>[\s\S]*?<\/context>/gi, "<context>…</context>")
        .replace(/<editorContext>[\s\S]*?<\/editorContext>/gi, "<editorContext>…</editorContext>")
        .replace(
            /<reminderInstructions>[\s\S]*?<\/reminderInstructions>/gi,
            "<reminderInstructions>…</reminderInstructions>"
        );

    return withoutCopilotContext.length > 500 ? `${withoutCopilotContext.slice(0, 500)}…` : withoutCopilotContext;
}

/**
 * Context passed to {@link logRequestPayloadOnFailure} describing where in
 * the request lifecycle the failure occurred and which model/caller was
 * involved.
 */
export interface RequestFailureLogContext {
    stage: "sendRequestWithRetry" | "provideLanguageModelChatResponse";
    modelId: string;
    caller?: string;
    modelInfoMode?: string;
}

/**
 * Logs a sanitized summary of a failed request payload at `trace` level,
 * pairing it with the sanitized error message. Used by the retry loop
 * and the chat response handler so failure triage can reconstruct the
 * request shape without exposing raw user content.
 */
export function logRequestPayloadOnFailure(
    request: OpenAIChatCompletionRequest,
    error: unknown,
    context: RequestFailureLogContext
): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const sanitizedError = sanitizeErrorTextForLogs(errorMessage);
    const payloadSummary = summarizeRequestPayloadForLogs(request);

    Logger.trace(
        `[request-failure] stage=${context.stage} model=${context.modelId} caller=${context.caller ?? "unknown"} mode=${context.modelInfoMode ?? "unknown"} error=${sanitizedError}`,
        payloadSummary
    );
}

/**
 * Builds a structured, log-safe summary of an OpenAI chat completion
 * request: per-message content shape (not content), tool presence, and
 * the scalar parameters that influence routing. Never includes raw
 * message text or tool argument bodies.
 */
export function summarizeRequestPayloadForLogs(request: OpenAIChatCompletionRequest): Record<string, unknown> {
    const summarizeMessages = (request.messages ?? []).map(
        (message: { role?: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }) => {
            const content = message.content;
            const contentSummary =
                typeof content === "string"
                    ? `text(${content.length})`
                    : Array.isArray(content)
                      ? `parts(${content.length})`
                      : typeof content;

            return {
                role: message.role,
                content: contentSummary,
                hasToolCalls: Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
                toolCallId: message.tool_call_id,
            };
        }
    );

    const summarizeTools = (request.tools ?? []).map((tool) => ({
        type: tool.type,
        name: tool.function?.name,
        hasDescription: typeof tool.function?.description === "string" && tool.function.description.length > 0,
    }));

    return {
        model: request.model,
        stream: request.stream,
        max_tokens: request.max_tokens,
        temperature: request.temperature,
        top_p: request.top_p,
        frequency_penalty: request.frequency_penalty,
        presence_penalty: request.presence_penalty,
        stop: request.stop,
        reasoning_effort: request.reasoning_effort,
        stream_options: request.stream_options,
        tool_choice: request.tool_choice,
        messageCount: request.messages?.length ?? 0,
        messages: summarizeMessages,
        toolCount: request.tools?.length ?? 0,
        tools: summarizeTools,
        hasExtraBody: typeof request.extra_body === "object" && request.extra_body !== null,
    };
}

// `LiteLLMModelInfo` is re-exported for callers that pair this module with
// capability lookups; the redaction module itself does not consume it.
export type { LiteLLMModelInfo };
