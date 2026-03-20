export type { V2EmittedPart as EmittedPart } from "../../providers/v2Types";
import type { V2EmittedPart as EmittedPart } from "../../providers/v2Types";
import { normalizeToolCallId } from "../../utils";
import { StructuredLogger } from "../../observability/structuredLogger";

export interface StreamingState {
    toolCallBuffers: Map<number, { id?: string; name?: string; args: string }>;
    completedToolCallIndices: Set<number>;
    emittedTextToolCallIds: Set<string>;
    textToolParserBuffer: string;
}

export function createInitialStreamingState(): StreamingState {
    return {
        toolCallBuffers: new Map(),
        completedToolCallIndices: new Set(),
        emittedTextToolCallIds: new Set(),
        textToolParserBuffer: "",
    };
}

/**
 * Interprets a single JSON frame from LiteLLM (OpenAI or /responses format)
 * and returns a list of emitted parts.
 */
export function interpretStreamEvent(json: unknown, state: StreamingState): EmittedPart[] {
    const parts: EmittedPart[] = [];
    const data = json as Record<string, unknown>;

    // 0. Handle VS Code DataPart carrier objects (e.g. cache_control)
    if (typeof data.$mid === "number" && typeof data.mimeType === "string") {
        parts.push({
            type: "data",
            mimeType: data.mimeType,
            value: data,
        });
        return parts;
    }

    // 1. Handle OpenAI chat-completions format
    if (data.choices && Array.isArray(data.choices) && data.choices[0]) {
        const choice = data.choices[0] as Record<string, unknown>;
        const delta = choice.delta as Record<string, unknown> | undefined;

        if (delta && typeof delta.content === "string" && delta.content) {
            parts.push({ type: "text", value: delta.content });
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
            // Flush tool calls — only emit those with valid JSON args to avoid
            // sending partial/corrupted tool calls to VS Code.
            for (const [index, buffer] of state.toolCallBuffers) {
                if (buffer.id && buffer.name && buffer.args) {
                    try {
                        JSON.parse(buffer.args);
                        // Only emit if this tool call ID hasn't been emitted already
                        if (!state.emittedTextToolCallIds.has(buffer.id)) {
                            parts.push({
                                type: "tool_call",
                                index,
                                id: buffer.id,
                                name: buffer.name,
                                args: buffer.args,
                            });
                            state.emittedTextToolCallIds.add(buffer.id);
                            // Trace log to verify normalized ID
                            StructuredLogger.trace("stream.tool_call_emitted", {
                                toolName: buffer.name,
                                normalizedId: buffer.id,
                                index,
                            });
                        }
                        state.completedToolCallIndices.add(index);
                    } catch {
                        // Incomplete or malformed JSON — drop this tool call
                        // rather than emit a corrupted one.
                    }
                }
            }
            state.toolCallBuffers.clear();

            parts.push({ type: "finish", reason: choice.finish_reason });
        }
    }

    // 2. Handle LiteLLM /responses format
    if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
        parts.push({ type: "text", value: data.delta });
    }
    if (data.type === "response.output_reasoning.delta" && typeof data.delta === "string") {
        parts.push({ type: "thinking", value: data.delta });
    }
    if (data.type === "response.completed") {
        const response = data.response as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
        parts.push({
            type: "response",
            usage: {
                inputTokens: response?.usage?.input_tokens,
                outputTokens: response?.usage?.output_tokens,
            },
        });
        if (typeof response?.usage?.input_tokens === "number" || typeof response?.usage?.output_tokens === "number") {
            parts.push({
                type: "data",
                mimeType: "application/vnd.litellm.usage+json",
                value: {
                    kind: "usage",
                    promptTokens: response?.usage?.input_tokens,
                    completionTokens: response?.usage?.output_tokens,
                },
            });
        }
    }
    if (data.type === "response.output_item.done") {
        parts.push({ type: "finish" });
    }

    // 3. Handle Gemini-style native format (sometimes passed through by LiteLLM)
    if (data.candidates && Array.isArray(data.candidates) && data.candidates[0]) {
        const candidate = data.candidates[0] as Record<string, unknown>;
        const content = candidate.content as Record<string, unknown> | undefined;
        if (content && Array.isArray(content.parts) && content.parts[0]) {
            const part = content.parts[0] as Record<string, unknown>;
            if (typeof part.text === "string" && part.text) {
                parts.push({ type: "text", value: part.text });
            }
        }
    }

    return parts;
}
