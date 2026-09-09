/**
 * Live stream-emission contract shared by the stream interpreter and its
 * consumers. The former V2 message-pipeline types (`V2ChatMessage`,
 * `V2MessagePart`) were dead code and have been removed.
 */
export type V2EmittedPart =
    | { type: "text"; value: string }
    | { type: "data"; mimeType: string; value: unknown }
    | { type: "thinking"; value: string | string[]; id?: string; metadata?: Record<string, unknown> }
    | { type: "tool_call"; index: number; id?: string; name?: string; args: string }
    | { type: "finish"; reason?: string }
    | { type: "response"; usage?: { inputTokens?: number; outputTokens?: number } };
