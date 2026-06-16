export type { V2EmittedPart as EmittedPart } from "../../providers/v2Types";
import type { V2EmittedPart as EmittedPart } from "../../providers/v2Types";
import type { OpenAIUsageCompletionTokenDetails, OpenAIUsagePayload, OpenAIUsagePromptTokenDetails } from "../../types";
import { isCacheControlMimeType, normalizeToolCallId } from "../../utils";
import { sanitizeToolName } from "../../utils/toolNameUtils";
import { Logger } from "../../utils/logger";
import { StructuredLogger } from "../../observability/structuredLogger";

export interface StreamingState {
    toolCallBuffers: Map<number, { id?: string; name?: string; args: string }>;
    completedToolCallIndices: Set<number>;
    emittedTextToolCallIds: Set<string>;
    textToolParserBuffer: string;
    responseToolCallBuffers: Map<string, { id: string; name?: string; args: string }>;
    responseToolCallOrder: string[];
    mergeReasoningContentInChoices: boolean;
    /**
     * Anonymous tool buffering — used when upstream streams tool args before emitting a stable
     * call_id (preserved from ResponsesClient robustness).
     * Note: if multiple anonymous calls interleave without call_ids they cannot be disambiguated.
     */
    anonymousResponseToolName: string | undefined;
    anonymousResponseToolArgs: string;
}

export function createInitialStreamingState(): StreamingState {
    return {
        toolCallBuffers: new Map(),
        completedToolCallIndices: new Set(),
        emittedTextToolCallIds: new Set(),
        textToolParserBuffer: "",
        responseToolCallBuffers: new Map(),
        responseToolCallOrder: [],
        mergeReasoningContentInChoices: false,
        anonymousResponseToolName: undefined,
        anonymousResponseToolArgs: "",
    };
}

interface RawUsagePayload {
    prompt_tokens?: number;
    completion_tokens?: number;
    system_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
    completion_tokens_details?: {
        reasoning_tokens?: number;
        tool_tokens?: number;
        accepted_prediction_tokens?: number;
        rejected_prediction_tokens?: number;
    };
    input_token_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
    output_token_details?: {
        reasoning_tokens?: number;
        tool_tokens?: number;
        accepted_prediction_tokens?: number;
        rejected_prediction_tokens?: number;
    };
}

function normalizeUsagePayload(usage: RawUsagePayload): OpenAIUsagePayload {
    const promptTokenDetails: OpenAIUsagePromptTokenDetails = {};
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.input_token_details?.cached_tokens;
    if (typeof cachedTokens === "number") {
        promptTokenDetails.cached_tokens = cachedTokens;
    } else if (usage.input_token_details !== undefined || usage.prompt_tokens_details !== undefined) {
        promptTokenDetails.cached_tokens = 0;
    }

    const cacheCreationInputTokens =
        usage.prompt_tokens_details?.cache_creation_input_tokens ??
        usage.input_token_details?.cache_creation_input_tokens;
    if (typeof cacheCreationInputTokens === "number") {
        promptTokenDetails.cache_creation_input_tokens = cacheCreationInputTokens;
    }

    const completionTokenDetails: OpenAIUsageCompletionTokenDetails = {};
    const reasoningTokens =
        usage.completion_tokens_details?.reasoning_tokens ?? usage.output_token_details?.reasoning_tokens;
    if (typeof reasoningTokens === "number") {
        completionTokenDetails.reasoning_tokens = reasoningTokens;
    } else if (usage.output_token_details !== undefined || usage.completion_tokens_details !== undefined) {
        completionTokenDetails.reasoning_tokens = 0;
    }
    const toolTokens = usage.completion_tokens_details?.tool_tokens ?? usage.output_token_details?.tool_tokens;
    if (typeof toolTokens === "number") {
        completionTokenDetails.tool_tokens = toolTokens;
    }
    const acceptedPredictionTokens =
        usage.completion_tokens_details?.accepted_prediction_tokens ??
        usage.output_token_details?.accepted_prediction_tokens;
    if (typeof acceptedPredictionTokens === "number") {
        completionTokenDetails.accepted_prediction_tokens = acceptedPredictionTokens;
    }
    const rejectedPredictionTokens =
        usage.completion_tokens_details?.rejected_prediction_tokens ??
        usage.output_token_details?.rejected_prediction_tokens;
    if (typeof rejectedPredictionTokens === "number") {
        completionTokenDetails.rejected_prediction_tokens = rejectedPredictionTokens;
    }

    const normalized: OpenAIUsagePayload = {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
    };

    if (Object.keys(promptTokenDetails).length > 0) {
        normalized.prompt_tokens_details = promptTokenDetails;
    }
    if (Object.keys(completionTokenDetails).length > 0) {
        normalized.completion_tokens_details = completionTokenDetails;
    }
    if (typeof usage.system_tokens === "number") {
        normalized.system_prompt_tokens = usage.system_tokens;
    }

    return normalized;
}

interface ParsedTextToolCall {
    id?: string;
    name: string;
    args: string;
}

function toJsonArgumentString(value: unknown): string {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return "{}";
        }
        try {
            JSON.parse(trimmed);
            return trimmed;
        } catch {
            return JSON.stringify({ value });
        }
    }

    if (value === undefined || value === null) {
        return "{}";
    }

    if (typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch {
            return "{}";
        }
    }

    return JSON.stringify({ value });
}

function parseTextToolPayload(payload: unknown): ParsedTextToolCall[] {
    if (!payload || typeof payload !== "object") {
        return [];
    }

    const record = payload as Record<string, unknown>;

    if (Array.isArray(record.tool_calls)) {
        const calls: ParsedTextToolCall[] = [];
        for (const entry of record.tool_calls) {
            if (!entry || typeof entry !== "object") {
                continue;
            }
            const callRecord = entry as Record<string, unknown>;
            const fn =
                callRecord.function && typeof callRecord.function === "object"
                    ? (callRecord.function as Record<string, unknown>)
                    : undefined;
            const name =
                typeof fn?.name === "string"
                    ? fn.name
                    : typeof callRecord.name === "string"
                      ? callRecord.name
                      : undefined;

            if (!name) {
                continue;
            }

            calls.push({
                id: typeof callRecord.id === "string" ? callRecord.id : undefined,
                name,
                args: toJsonArgumentString(fn?.arguments ?? callRecord.arguments),
            });
        }
        return calls;
    }

    const functionObject =
        record.function && typeof record.function === "object"
            ? (record.function as Record<string, unknown>)
            : undefined;
    const name =
        typeof record.name === "string"
            ? record.name
            : typeof functionObject?.name === "string"
              ? functionObject.name
              : undefined;
    if (!name) {
        return [];
    }

    return [
        {
            id: typeof record.id === "string" ? record.id : undefined,
            name,
            args: toJsonArgumentString(record.arguments ?? functionObject?.arguments ?? record.input),
        },
    ];
}

function parseTaggedToolCalls(text: string): { textWithoutParsedCalls: string; toolCalls: ParsedTextToolCall[] } {
    const toolCalls: ParsedTextToolCall[] = [];
    let remaining = text;

    const patterns = [/<tool_call>([\s\S]*?)<\/tool_call>/g, /<\|tool_call_begin\|>([\s\S]*?)<\|tool_call_end\|>/g];

    for (const pattern of patterns) {
        remaining = remaining.replace(pattern, (fullMatch: string, payloadText: string): string => {
            const payloadTrimmed = payloadText.trim();
            if (!payloadTrimmed) {
                return "";
            }
            try {
                const parsedPayload = JSON.parse(payloadTrimmed) as unknown;
                const parsedCalls = parseTextToolPayload(parsedPayload);
                if (parsedCalls.length > 0) {
                    toolCalls.push(...parsedCalls);
                    return "";
                }
            } catch {
                // Keep original text when payload is not valid JSON.
            }
            return fullMatch;
        });
    }

    return { textWithoutParsedCalls: remaining, toolCalls };
}

function splitStableTextAndPendingTaggedContent(text: string): { stableText: string; pendingText: string } {
    const openers = ["<tool_call>", "<|tool_call_begin|>"];
    const closestOpenIndex = Math.max(...openers.map((token) => text.lastIndexOf(token)));
    if (closestOpenIndex < 0) {
        return { stableText: text, pendingText: "" };
    }

    const pendingCandidate = text.slice(closestOpenIndex);
    const hasClosingTag = pendingCandidate.includes("</tool_call>") || pendingCandidate.includes("<|tool_call_end|>");
    if (hasClosingTag) {
        return { stableText: text, pendingText: "" };
    }

    return {
        stableText: text.slice(0, closestOpenIndex),
        pendingText: pendingCandidate,
    };
}

/**
 * Interprets a single JSON frame from LiteLLM (OpenAI or /responses format)
 * and returns a list of emitted parts.
 */
export function interpretStreamEvent(json: unknown, state: StreamingState): EmittedPart[] {
    const thinkingParts: EmittedPart[] = [];
    const textParts: EmittedPart[] = [];
    const toolCallParts: EmittedPart[] = [];
    const dataParts: EmittedPart[] = [];
    const responseParts: EmittedPart[] = [];
    const finishParts: EmittedPart[] = [];
    const data = json as Record<string, unknown>;

    // Log the incoming event at trace level
    Logger.trace("[interpretStreamEvent] Processing event", {
        eventType: typeof data.type === "string" ? data.type : "unknown",
        hasChoices: !!data.choices,
        hasUsage: !!data.usage,
    });
    StructuredLogger.trace("stream.event_received", {
        eventType: typeof data.type === "string" ? data.type : undefined,
        hasChoices: !!data.choices,
        hasUsage: !!data.usage,
        mergeReasoning: state.mergeReasoningContentInChoices,
    });

    if (typeof data.merge_reasoning_content_in_choices === "boolean") {
        state.mergeReasoningContentInChoices = data.merge_reasoning_content_in_choices;
        Logger.trace(
            `[interpretStreamEvent] Set mergeReasoningContentInChoices=${data.merge_reasoning_content_in_choices}`
        );
        StructuredLogger.trace("stream.merge_reasoning_setting", {
            mergeReasoningContentInChoices: data.merge_reasoning_content_in_choices,
        });
    }

    // 0. Handle VS Code DataPart carrier objects. Cache-control carrier parts
    // are opaque prompt-cache metadata; if re-emitted, VS Code can preserve
    // them into the next request and the LLM sees the carrier instead of the
    // user's task. Literal text mentioning cache_control still flows through
    // the normal text branches below.
    if (typeof data.$mid === "number" && typeof data.mimeType === "string") {
        if (isCacheControlMimeType(data.mimeType)) {
            StructuredLogger.trace("stream.cache_control_carrier_dropped", { mimeType: data.mimeType });
            return [];
        }

        // Preserve the original payload value when present; fallback to the carrier itself.
        const carrierValue = Object.prototype.hasOwnProperty.call(data, "data")
            ? (data as { data: unknown }).data
            : data;

        dataParts.push({
            type: "data",
            mimeType: data.mimeType,
            value: carrierValue,
        });
        return dataParts;
    }

    // 1. Handle OpenAI chat-completions format
    if (data.choices && Array.isArray(data.choices) && data.choices[0]) {
        const choice = data.choices[0] as Record<string, unknown>;
        const delta = choice.delta as Record<string, unknown> | undefined;

        const reasoningContent =
            typeof delta?.reasoning_content === "string" && delta.reasoning_content
                ? delta.reasoning_content
                : undefined;
        const mergeReasoningIntoContent = state.mergeReasoningContentInChoices && !!reasoningContent;

        if (reasoningContent && !mergeReasoningIntoContent) {
            thinkingParts.push({ type: "thinking", value: reasoningContent });
            Logger.trace(`[interpretStreamEvent] Emitted thinking part, length=${reasoningContent.length}`);
            StructuredLogger.trace("stream.reasoning_emitted", {
                length: reasoningContent.length,
                preview: reasoningContent.slice(0, 50),
            });
        } else if (reasoningContent && mergeReasoningIntoContent) {
            Logger.trace(`[interpretStreamEvent] Merging reasoning into content, length=${reasoningContent.length}`);
            StructuredLogger.trace("stream.reasoning_merged", {
                length: reasoningContent.length,
            });
        }

        const deltaContent = typeof delta?.content === "string" && delta.content ? delta.content : undefined;
        const contentForParsing = mergeReasoningIntoContent
            ? `${reasoningContent ?? ""}${deltaContent ?? ""}`
            : deltaContent;

        if (contentForParsing) {
            // Some LiteLLM backends emit tool calls as tagged text payloads
            // (for example <tool_call>{...}</tool_call>) instead of structured
            // delta.tool_calls arrays. Parse those tags here so VS Code receives
            // LanguageModelToolCallPart instead of raw JSON text.
            const combinedText = `${state.textToolParserBuffer}${contentForParsing}`;
            const { stableText, pendingText } = splitStableTextAndPendingTaggedContent(combinedText);
            const { textWithoutParsedCalls, toolCalls } = parseTaggedToolCalls(stableText);
            state.textToolParserBuffer = pendingText;

            if (textWithoutParsedCalls) {
                textParts.push({ type: "text", value: textWithoutParsedCalls });
                Logger.trace(`[interpretStreamEvent] Emitted text part, length=${textWithoutParsedCalls.length}`);
                StructuredLogger.trace("stream.text_emitted", {
                    length: textWithoutParsedCalls.length,
                    preview: textWithoutParsedCalls.slice(0, 50),
                });
            }

            for (const parsedToolCall of toolCalls) {
                const normalizedId = normalizeToolCallId(
                    parsedToolCall.id && parsedToolCall.id.trim().length > 0
                        ? parsedToolCall.id
                        : `text_tool_call_${state.emittedTextToolCallIds.size + toolCallParts.length + 1}`
                );
                if (state.emittedTextToolCallIds.has(normalizedId)) {
                    continue;
                }
                toolCallParts.push({
                    type: "tool_call",
                    index: toolCallParts.length,
                    id: normalizedId,
                    name: parsedToolCall.name,
                    args: parsedToolCall.args,
                });
                state.emittedTextToolCallIds.add(normalizedId);
            }
        }

        if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
            for (const tcItem of delta.tool_calls) {
                const tc = tcItem as Record<string, unknown>;
                const index = (tc.index as number) ?? 0;
                let buffer = state.toolCallBuffers.get(index);

                // If we get a new ID for the same index, it's a new call; clear the old one.
                // This prevents corruption if finish_reason was missed in a previous turn.
                // Normalize incoming ID before comparison since buffer stores normalized IDs
                const incomingId = tc.id ? normalizeToolCallId(tc.id as string) : undefined;
                if (incomingId && buffer && buffer.id !== incomingId) {
                    state.toolCallBuffers.delete(index);
                    buffer = undefined;
                }

                if (!buffer) {
                    const fn = tc.function as Record<string, string> | undefined;
                    // Normalize the tool call ID to ensure it meets OpenAI/LiteLLM requirements
                    // (starts with 'fc_' and is <= 40 chars)
                    const rawId = (tc.id as string) || "";
                    const newId = rawId ? normalizeToolCallId(rawId) : "";
                    // Skip if this tool call ID was already emitted in a previous turn
                    if (newId && state.emittedTextToolCallIds.has(newId)) {
                        Logger.trace(`[interpretStreamEvent] Skipping duplicate tool call ID: ${newId}`);
                        StructuredLogger.trace("stream.tool_call_skipped_duplicate", { id: newId });
                        continue;
                    }
                    // Apply tool name sanitization for AWS Bedrock Converse API compliance (64-char limit)
                    const { name: sanitizedName } = sanitizeToolName(fn?.name || "");
                    buffer = { id: newId, name: sanitizedName, args: fn?.arguments || "" };
                    state.toolCallBuffers.set(index, buffer);
                    Logger.trace(`[interpretStreamEvent] Buffered new tool call: ${sanitizedName} (id: ${newId})`);
                    StructuredLogger.trace("stream.tool_call_buffered", {
                        toolName: fn?.name,
                        rawId,
                        normalizedId: newId,
                        index,
                    });
                } else {
                    if (tc.id) {
                        // Normalize the tool call ID when updating
                        const normalizedId = normalizeToolCallId(tc.id as string);
                        StructuredLogger.trace("stream.tool_call_id_updated", {
                            rawId: tc.id,
                            normalizedId,
                            index,
                        });
                        buffer.id = normalizedId;
                    }
                    const tcFn = tc.function as Record<string, string> | undefined;
                    if (tcFn?.name) {
                        buffer.name = tcFn.name;
                    }
                    if (tcFn?.arguments) {
                        buffer.args += tcFn.arguments;
                    }
                }
            }
        }

        if (choice.finish_reason && typeof choice.finish_reason === "string") {
            if (state.textToolParserBuffer.trim().length > 0) {
                const { textWithoutParsedCalls, toolCalls } = parseTaggedToolCalls(state.textToolParserBuffer);
                if (textWithoutParsedCalls) {
                    textParts.push({ type: "text", value: textWithoutParsedCalls });
                }
                for (const parsedToolCall of toolCalls) {
                    const normalizedId = normalizeToolCallId(
                        parsedToolCall.id && parsedToolCall.id.trim().length > 0
                            ? parsedToolCall.id
                            : `text_tool_call_${state.emittedTextToolCallIds.size + toolCallParts.length + 1}`
                    );
                    if (state.emittedTextToolCallIds.has(normalizedId)) {
                        continue;
                    }
                    toolCallParts.push({
                        type: "tool_call",
                        index: toolCallParts.length,
                        id: normalizedId,
                        name: parsedToolCall.name,
                        args: parsedToolCall.args,
                    });
                    state.emittedTextToolCallIds.add(normalizedId);
                }
                state.textToolParserBuffer = "";
            }

            for (const [index, buffer] of state.toolCallBuffers) {
                if (buffer.id && buffer.name && buffer.args) {
                    const isDuplicate = state.emittedTextToolCallIds.has(buffer.id);
                    const finishReason = choice.finish_reason;
                    let isJsonValid = true;
                    try {
                        JSON.parse(buffer.args);
                    } catch {
                        isJsonValid = false;
                        StructuredLogger.warn("stream.tool_call_args_invalid_json", {
                            toolName: buffer.name,
                            normalizedId: buffer.id,
                            index,
                        });
                    }

                    // Only emit invalid JSON tool calls when finish_reason is tool_calls
                    const allowEmit = isJsonValid || finishReason === "tool_calls";

                    if (!isDuplicate && allowEmit) {
                        toolCallParts.push({
                            type: "tool_call",
                            index,
                            id: buffer.id,
                            name: buffer.name,
                            args: buffer.args,
                        });
                        state.emittedTextToolCallIds.add(buffer.id);
                        StructuredLogger.trace("stream.tool_call_emitted", {
                            toolName: buffer.name,
                            normalizedId: buffer.id,
                            index,
                            finishReason,
                        });
                    }
                    state.completedToolCallIndices.add(index);
                }
            }
            state.toolCallBuffers.clear();

            finishParts.push({ type: "finish", reason: choice.finish_reason });
        }

        if (data.usage && typeof data.usage === "object") {
            dataParts.push({
                type: "data",
                mimeType: "usage",
                value: normalizeUsagePayload(data.usage as RawUsagePayload),
            });
        }
    }

    // Handle usage-only frames (OpenAI /responses sometimes emit standalone usage objects)
    if (!dataParts.length && data.usage && typeof data.usage === "object") {
        dataParts.push({
            type: "data",
            mimeType: "usage",
            value: normalizeUsagePayload(data.usage as RawUsagePayload),
        });
    }

    // 2. Handle LiteLLM /responses format
    if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
        Logger.trace(`[interpretStreamEvent] Emitting /responses text delta: ${data.delta.length} chars`);
        textParts.push({ type: "text", value: data.delta });
        StructuredLogger.trace("stream.responses_text_delta", {
            length: data.delta.length,
            preview: data.delta.substring(0, 100),
        });
    }
    if (data.type === "response.output_reasoning.delta" && typeof data.delta === "string") {
        Logger.trace(`[interpretStreamEvent] Emitting /responses thinking delta: ${data.delta.length} chars`);
        thinkingParts.push({ type: "thinking", value: data.delta });
        StructuredLogger.trace("stream.responses_reasoning_delta", {
            length: data.delta.length,
            preview: data.delta.substring(0, 100),
        });
    }

    // 2b. Robust event shape: response.output_item.delta (keyed on item.call_id)
    // This is the event shape used by ResponsesClient — preserved here for providers
    // that stream tool args via output_item.delta rather than output_tool_call.*.
    if (data.type === "response.output_item.delta") {
        const item = data.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
            const callId = typeof item.call_id === "string" ? item.call_id : undefined;
            const name = typeof item.name === "string" ? item.name : undefined;
            const argsDelta = typeof item.arguments === "string" ? item.arguments : undefined;

            if (callId) {
                const existing = state.responseToolCallBuffers.get(callId) ?? { id: callId, name: undefined, args: "" };
                if (name) {
                    // Apply tool name sanitization for AWS Bedrock Converse API compliance (64-char limit)
                    const { name: sanitizedName } = sanitizeToolName(name);
                    existing.name = sanitizedName;
                    Logger.trace(`[interpretStreamEvent] /responses output_item.delta tool name: ${sanitizedName}`);
                }
                if (argsDelta) {
                    existing.args += argsDelta;
                    Logger.trace(
                        `[interpretStreamEvent] /responses output_item.delta args delta: ${argsDelta.length} chars accumulated`
                    );
                }
                state.responseToolCallBuffers.set(callId, existing);
                if (!state.responseToolCallOrder.includes(callId)) {
                    state.responseToolCallOrder.push(callId);
                    StructuredLogger.trace("stream.responses_tool_call_delta", {
                        callId,
                        name,
                        argsLength: argsDelta?.length ?? 0,
                    });
                }
            } else {
                // No call_id yet — buffer anonymously (providers that stream args before id)
                if (name) {
                    // Apply tool name sanitization for AWS Bedrock Converse API compliance (64-char limit)
                    const { name: sanitizedName } = sanitizeToolName(name);
                    state.anonymousResponseToolName = sanitizedName;
                    Logger.trace(
                        `[interpretStreamEvent] /responses output_item.delta anonymous tool name: ${sanitizedName}`
                    );
                }
                if (argsDelta) {
                    state.anonymousResponseToolArgs += argsDelta;
                    Logger.trace(
                        `[interpretStreamEvent] /responses output_item.delta anonymous args delta: ${argsDelta.length} chars accumulated`
                    );
                    StructuredLogger.trace("stream.responses_anonymous_tool_delta", {
                        argsLength: argsDelta.length,
                    });
                }
            }
        }
    }

    // 2c. Legacy event shape: response.output_tool_call.* (keyed on delta.id)
    if (typeof data.type === "string" && data.type.startsWith("response.output_tool_call")) {
        const delta = data.delta as Record<string, unknown> | undefined;
        const id = typeof delta?.id === "string" ? delta.id : undefined;
        if (id) {
            Logger.trace(`[interpretStreamEvent] /responses legacy output_tool_call.* delta for id: ${id}`);
            const existing = state.responseToolCallBuffers.get(id) ?? { id, name: undefined, args: "" };
            if (typeof delta?.name === "string") {
                // Apply tool name sanitization for AWS Bedrock Converse API compliance (64-char limit)
                const { name: sanitizedName } = sanitizeToolName(delta.name);
                existing.name = sanitizedName;
                Logger.trace(`[interpretStreamEvent] /responses legacy tool name: ${sanitizedName}`);
            }
            if (typeof delta?.arguments === "string") {
                existing.args += delta.arguments;
                Logger.trace(
                    `[interpretStreamEvent] /responses legacy args delta: ${delta.arguments.length} chars accumulated`
                );
            }
            state.responseToolCallBuffers.set(id, existing);
            if (!state.responseToolCallOrder.includes(id)) {
                state.responseToolCallOrder.push(id);
                StructuredLogger.trace("stream.responses_legacy_tool_call_delta", {
                    id,
                    name: delta?.name as string | undefined,
                    argsLength: typeof delta?.arguments === "string" ? delta.arguments.length : 0,
                });
            }
        }
    }
    if (data.type === "response.completed") {
        Logger.info(`[interpretStreamEvent] Received /responses response.completed event`);
        const response = data.response as
            | {
                  usage?: {
                      input_tokens?: number;
                      output_tokens?: number;
                      system_tokens?: number;
                      input_token_details?: { cached_tokens?: number; cache_creation_input_tokens?: number };
                      output_token_details?: {
                          reasoning_tokens?: number;
                          tool_tokens?: number;
                          accepted_prediction_tokens?: number;
                          rejected_prediction_tokens?: number;
                      };
                  };
              }
            | undefined;
        responseParts.push({
            type: "response",
            usage: {
                inputTokens: response?.usage?.input_tokens,
                outputTokens: response?.usage?.output_tokens,
            },
        });
        // Flush buffered /responses tool calls
        let flushedToolCallCount = 0;
        for (const id of state.responseToolCallOrder) {
            const buffer = state.responseToolCallBuffers.get(id);
            if (!buffer) {
                continue;
            }
            if (buffer.name && buffer.args) {
                try {
                    JSON.parse(buffer.args);
                    Logger.trace(
                        `[interpretStreamEvent] Flushing /responses tool call: ${buffer.name} (id: ${buffer.id})`
                    );
                    toolCallParts.push({
                        type: "tool_call",
                        index: toolCallParts.length,
                        id: buffer.id,
                        name: buffer.name,
                        args: buffer.args,
                    });
                    flushedToolCallCount++;
                } catch {
                    // drop malformed tool call
                    Logger.warn(`[interpretStreamEvent] Dropped malformed tool call args for ${buffer.name}`);
                }
            }
        }
        state.responseToolCallBuffers.clear();
        state.responseToolCallOrder = [];
        Logger.trace(`[interpretStreamEvent] Flushed ${flushedToolCallCount} tool calls on response.completed`);

        if (typeof response?.usage?.input_tokens === "number" || typeof response?.usage?.output_tokens === "number") {
            const usageValue = normalizeUsagePayload({
                prompt_tokens: response?.usage?.input_tokens,
                completion_tokens: response?.usage?.output_tokens,
                system_tokens: response?.usage?.system_tokens,
                input_token_details: response?.usage?.input_token_details,
                output_token_details: response?.usage?.output_token_details,
            });

            if (!usageValue.prompt_tokens_details) {
                usageValue.prompt_tokens_details = { cached_tokens: 0 };
            }
            if (!usageValue.completion_tokens_details) {
                usageValue.completion_tokens_details = { reasoning_tokens: 0 };
            }

            Logger.debug(
                `[interpretStreamEvent] Recording usage: input=${usageValue.prompt_tokens} output=${usageValue.completion_tokens}`
            );
            dataParts.push({
                type: "data",
                mimeType: "usage",
                value: usageValue,
            });
            StructuredLogger.trace("stream.responses_usage", {
                inputTokens: usageValue.prompt_tokens,
                outputTokens: usageValue.completion_tokens,
                systemPromptTokens: usageValue.system_prompt_tokens,
                toolCallsEmitted: flushedToolCallCount,
            });
        }
    }
    if (data.type === "response.output_item.done") {
        Logger.debug(`[interpretStreamEvent] Received /responses output_item.done event`);
        const item = data.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
            const callId = typeof item.call_id === "string" ? item.call_id : undefined;
            const nameFromDone = typeof item.name === "string" ? item.name : undefined;
            const argsFromDone = typeof item.arguments === "string" ? item.arguments : undefined;

            if (callId) {
                // Per-callId flush: emit the specific buffered call and remove it from the order
                // list so response.completed does not double-emit it.
                const buffer = state.responseToolCallBuffers.get(callId);
                const name = nameFromDone ?? buffer?.name;
                const args = argsFromDone ?? buffer?.args;
                Logger.trace(
                    `[interpretStreamEvent] Flushing keyed tool call on output_item.done: ${name} (id: ${callId})`
                );
                if (name && args) {
                    try {
                        JSON.parse(args);
                        toolCallParts.push({
                            type: "tool_call",
                            index: toolCallParts.length,
                            id: callId,
                            name,
                            args,
                        });
                        StructuredLogger.trace("stream.responses_tool_call_done", {
                            callId,
                            name,
                            argsLength: args.length,
                        });
                    } catch {
                        // drop malformed tool call
                        Logger.warn(`[interpretStreamEvent] Dropped malformed tool call ${name} on output_item.done`);
                    }
                }
                state.responseToolCallBuffers.delete(callId);
                state.responseToolCallOrder = state.responseToolCallOrder.filter((id) => id !== callId);
            } else {
                // Anonymous tool call (no stable call_id) — emit best-effort from anonymous buffer.
                // Preserved from ResponsesClient for providers that never emit a call_id.
                const name = nameFromDone ?? state.anonymousResponseToolName;
                const args = argsFromDone ?? state.anonymousResponseToolArgs;
                Logger.trace(`[interpretStreamEvent] Flushing anonymous tool call on output_item.done: ${name}`);
                if (name && args) {
                    try {
                        JSON.parse(args);
                        toolCallParts.push({
                            type: "tool_call",
                            index: toolCallParts.length,
                            id: "anonymous",
                            name,
                            args,
                        });
                        StructuredLogger.trace("stream.responses_anonymous_tool_done", {
                            name,
                            argsLength: args.length,
                        });
                    } catch {
                        // drop malformed tool call
                        Logger.warn(`[interpretStreamEvent] Dropped malformed anonymous tool call ${name}`);
                    }
                }
            }

            // Reset anonymous buffer regardless of whether we emitted
            state.anonymousResponseToolName = undefined;
            state.anonymousResponseToolArgs = "";
        } else {
            // No function_call item (e.g., text item, or no item at all) — legacy flush-all.
            // Preserves backward compat with output_tool_call.* path which relies on
            // output_item.done to drain all buffered calls when no response.completed follows.
            Logger.debug(`[interpretStreamEvent] Legacy flush-all on output_item.done (non-function_call item)`);
            let legacyFlushedCount = 0;
            for (const id of state.responseToolCallOrder) {
                const buffer = state.responseToolCallBuffers.get(id);
                if (!buffer) {
                    continue;
                }
                if (buffer.name && buffer.args) {
                    try {
                        JSON.parse(buffer.args);
                        Logger.trace(
                            `[interpretStreamEvent] Legacy flushed tool call: ${buffer.name} (id: ${buffer.id})`
                        );
                        toolCallParts.push({
                            type: "tool_call",
                            index: toolCallParts.length,
                            id: buffer.id,
                            name: buffer.name,
                            args: buffer.args,
                        });
                        legacyFlushedCount++;
                    } catch {
                        // drop malformed tool call
                        Logger.warn(
                            `[interpretStreamEvent] Dropped malformed tool call ${buffer.name} on legacy flush`
                        );
                    }
                }
            }
            state.responseToolCallBuffers.clear();
            state.responseToolCallOrder = [];
            Logger.debug(`[interpretStreamEvent] Legacy flushed ${legacyFlushedCount} tool calls on output_item.done`);
            StructuredLogger.trace("stream.responses_legacy_flush", {
                toolCallsEmitted: legacyFlushedCount,
            });
        }

        finishParts.push({ type: "finish" });
    }

    // 3. Handle Gemini-style native format (sometimes passed through by LiteLLM)
    if (data.candidates && Array.isArray(data.candidates) && data.candidates[0]) {
        Logger.debug(`[interpretStreamEvent] Handling Gemini-format candidates`);
        const candidate = data.candidates[0] as Record<string, unknown>;
        const content = candidate.content as Record<string, unknown> | undefined;
        if (content && Array.isArray(content.parts) && content.parts[0]) {
            const part = content.parts[0] as Record<string, unknown>;
            if (typeof part.text === "string" && part.text) {
                Logger.trace(`[interpretStreamEvent] Gemini text part: ${part.text.length} chars`);
                textParts.push({ type: "text", value: part.text });
                StructuredLogger.trace("stream.gemini_text", {
                    length: part.text.length,
                    preview: part.text.substring(0, 100),
                });
            }
            const functionCall = part.functionCall as { name?: string; args?: unknown; id?: string } | undefined;
            if (functionCall?.name) {
                const argsJson = JSON.stringify(functionCall.args ?? {});
                Logger.trace(`[interpretStreamEvent] Gemini function call: ${functionCall.name}`);
                toolCallParts.push({
                    type: "tool_call",
                    index: 0,
                    id: functionCall.id,
                    name: functionCall.name,
                    args: argsJson,
                });
                StructuredLogger.trace("stream.gemini_function_call", {
                    name: functionCall.name,
                    id: functionCall.id,
                    argsLength: argsJson.length,
                });
            }
        }
    }

    // Emit in deterministic order to match VS Code expectations
    const allParts = [...thinkingParts, ...textParts, ...toolCallParts, ...responseParts, ...dataParts, ...finishParts];
    Logger.trace(
        `[interpretStreamEvent] Returning ${allParts.length} parts: thinking=${thinkingParts.length} text=${textParts.length} toolCall=${toolCallParts.length} response=${responseParts.length} data=${dataParts.length} finish=${finishParts.length}`
    );
    StructuredLogger.trace("stream.event_interpretation_complete", {
        totalParts: allParts.length,
        thinkingParts: thinkingParts.length,
        textParts: textParts.length,
        toolCallParts: toolCallParts.length,
        responseParts: responseParts.length,
        dataParts: dataParts.length,
        finishParts: finishParts.length,
    });
    return allParts;
}
