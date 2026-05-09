export type { V2EmittedPart as EmittedPart } from "../../providers/v2Types";
import type { V2EmittedPart as EmittedPart } from "../../providers/v2Types";
import { createUsagePayload, normalizeUsageFromRaw } from "../usageData";
import { isCacheControlMimeType, normalizeToolCallId } from "../../utils";
import { StructuredLogger } from "../../observability/structuredLogger";

export interface StreamingState {
    toolCallBuffers: Map<number, { id?: string; name?: string; args: string }>;
    completedToolCallIndices: Set<number>;
    emittedTextToolCallIds: Set<string>;
    textToolParserBuffer: string;
    responseToolCallBuffers: Map<string, { id: string; name?: string; args: string }>;
    responseToolCallOrder: string[];
}

export function createInitialStreamingState(): StreamingState {
    return {
        toolCallBuffers: new Map(),
        completedToolCallIndices: new Set(),
        emittedTextToolCallIds: new Set(),
        textToolParserBuffer: "",
        responseToolCallBuffers: new Map(),
        responseToolCallOrder: [],
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
        dataParts.push({
            type: "data",
            mimeType: data.mimeType,
            value: data,
        });
        return dataParts;
    }

    // 1. Handle OpenAI chat-completions format
    if (data.choices && Array.isArray(data.choices) && data.choices[0]) {
        const choice = data.choices[0] as Record<string, unknown>;
        const delta = choice.delta as Record<string, unknown> | undefined;

        if (delta && typeof delta.content === "string" && delta.content) {
            textParts.push({ type: "text", value: delta.content });
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
                        continue;
                    }
                    buffer = { id: newId, name: fn?.name || "", args: fn?.arguments || "" };
                    state.toolCallBuffers.set(index, buffer);
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
            for (const [index, buffer] of state.toolCallBuffers) {
                if (buffer.id && buffer.name && buffer.args) {
                    const isDuplicate = state.emittedTextToolCallIds.has(buffer.id);
                    const finishReason = choice.finish_reason;
                    let isJsonValid = true;
                    try {
                        JSON.parse(buffer.args);
                    } catch (err) {
                        isJsonValid = false;
                        StructuredLogger.warn("stream.tool_call_args_invalid_json", {
                            toolName: buffer.name,
                            normalizedId: buffer.id,
                            index,
                            finishReason,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }

                    if (!isDuplicate && isJsonValid) {
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
                    } else if (!isJsonValid) {
                        toolCallParts.push({
                            type: "error",
                            message: `Malformed tool call arguments for ${buffer.name} (id=${buffer.id})`,
                        });
                    }
                    state.completedToolCallIndices.add(index);
                }
            }
            state.toolCallBuffers.clear();

            finishParts.push({ type: "finish", reason: choice.finish_reason });
        }
    }

    // 2. Handle LiteLLM /responses format
    if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
        textParts.push({ type: "text", value: data.delta });
    }
    if (data.type === "response.output_reasoning.delta" && typeof data.delta === "string") {
        thinkingParts.push({ type: "thinking", value: data.delta });
    }
    // The OpenAI Responses API (and LiteLLM's proxy) emits tool call arguments via
    // "response.output_item.delta" events with item.type === "function_call".
    // NOTE: "response.output_tool_call.*" is an invented name that does not appear in
    // the real API; it was previously used here by mistake.
    if (data.type === "response.output_item.delta") {
        const item = data.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
            // call_id is the stable identifier; fall back to id if missing.
            const callId =
                typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : undefined;
            if (callId) {
                const existing = state.responseToolCallBuffers.get(callId) ?? {
                    id: callId,
                    name: undefined,
                    args: "",
                };
                if (typeof item.name === "string") {
                    existing.name = item.name;
                }
                if (typeof item.arguments === "string") {
                    existing.args += item.arguments;
                }
                state.responseToolCallBuffers.set(callId, existing);
                if (!state.responseToolCallOrder.includes(callId)) {
                    state.responseToolCallOrder.push(callId);
                }
            }
        }
    }
    if (data.type === "response.completed") {
        const response = data.response as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
        const normalizedUsage = normalizeUsageFromRaw(response?.usage);
        if (normalizedUsage) {
            responseParts.push({
                type: "response",
                usage: normalizedUsage,
            });
        }
        // Flush buffered /responses tool calls
        for (const id of state.responseToolCallOrder) {
            const buffer = state.responseToolCallBuffers.get(id);
            if (!buffer) {
                continue;
            }
            if (buffer.name && buffer.args) {
                try {
                    JSON.parse(buffer.args);
                    toolCallParts.push({
                        type: "tool_call",
                        index: toolCallParts.length,
                        id: buffer.id,
                        name: buffer.name,
                        args: buffer.args,
                    });
                } catch {
                    // drop malformed tool call
                }
            }
        }
        state.responseToolCallBuffers.clear();
        state.responseToolCallOrder = [];
        if (normalizedUsage) {
            dataParts.push({
                type: "data",
                mimeType: "application/vnd.litellm.usage+json",
                value: createUsagePayload(normalizedUsage),
            });
        }
    }
    if (data.type === "response.output_item.done") {
        // If the done event itself carries a complete function_call item (some LiteLLM versions
        // deliver the full item on done rather than streaming deltas), merge it into the buffer
        // so the flush below picks it up regardless of whether deltas arrived first.
        const doneItem = data.item as Record<string, unknown> | undefined;
        if (doneItem?.type === "function_call") {
            const callId =
                typeof doneItem.call_id === "string"
                    ? doneItem.call_id
                    : typeof doneItem.id === "string"
                      ? doneItem.id
                      : undefined;
            if (callId) {
                const existing = state.responseToolCallBuffers.get(callId) ?? {
                    id: callId,
                    name: undefined,
                    args: "",
                };
                if (typeof doneItem.name === "string" && !existing.name) {
                    existing.name = doneItem.name;
                }
                if (typeof doneItem.arguments === "string" && !existing.args) {
                    existing.args = doneItem.arguments;
                }
                state.responseToolCallBuffers.set(callId, existing);
                if (!state.responseToolCallOrder.includes(callId)) {
                    state.responseToolCallOrder.push(callId);
                }
            }
        }

        // Flush buffered /responses tool calls accumulated via delta + done events
        for (const id of state.responseToolCallOrder) {
            const buffer = state.responseToolCallBuffers.get(id);
            if (!buffer) {
                continue;
            }
            if (buffer.name && buffer.args) {
                try {
                    JSON.parse(buffer.args);
                    toolCallParts.push({
                        type: "tool_call",
                        index: toolCallParts.length,
                        id: buffer.id,
                        name: buffer.name,
                        args: buffer.args,
                    });
                } catch {
                    // drop malformed tool call
                }
            }
        }
        state.responseToolCallBuffers.clear();
        state.responseToolCallOrder = [];
        finishParts.push({ type: "finish" });
    }

    // 3. Handle Gemini-style native format (sometimes passed through by LiteLLM)
    if (data.candidates && Array.isArray(data.candidates) && data.candidates[0]) {
        const candidate = data.candidates[0] as Record<string, unknown>;
        const content = candidate.content as Record<string, unknown> | undefined;
        if (content && Array.isArray(content.parts) && content.parts[0]) {
            const part = content.parts[0] as Record<string, unknown>;
            if (typeof part.text === "string" && part.text) {
                textParts.push({ type: "text", value: part.text });
            }
            const functionCall = part.functionCall as { name?: string; args?: unknown; id?: string } | undefined;
            if (functionCall?.name) {
                const argsJson = JSON.stringify(functionCall.args ?? {});
                toolCallParts.push({
                    type: "tool_call",
                    index: 0,
                    id: functionCall.id,
                    name: functionCall.name,
                    args: argsJson,
                });
            }
        }
    }

    // Emit in deterministic order to match VS Code expectations
    return [...thinkingParts, ...textParts, ...toolCallParts, ...responseParts, ...dataParts, ...finishParts];
}
