export type EmittedPart =
    | { type: "text"; value: string }
    | { type: "tool_call"; index: number; id?: string; name?: string; args: string }
    | { type: "finish"; reason?: string };

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
                if (!buffer) {
                    const fn = tc.function as Record<string, string> | undefined;
                    buffer = { id: tc.id as string, name: fn?.name, args: "" };
                    state.toolCallBuffers.set(index, buffer);
                }
                if (tc.id) {
                    buffer.id = tc.id as string;
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

        if (choice.finish_reason && typeof choice.finish_reason === "string") {
            // Flush tool calls
            for (const [index, buffer] of state.toolCallBuffers) {
                if (!state.completedToolCallIndices.has(index) && buffer.id && buffer.name) {
                    parts.push({ type: "tool_call", index, id: buffer.id, name: buffer.name, args: buffer.args });
                    state.completedToolCallIndices.add(index);
                }
            }
            parts.push({ type: "finish", reason: choice.finish_reason });
        }
    }

    // 2. Handle LiteLLM /responses format
    if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
        parts.push({ type: "text", value: data.delta });
    }
    if (data.type === "response.output_item.done") {
        parts.push({ type: "finish" });
    }

    return parts;
}
