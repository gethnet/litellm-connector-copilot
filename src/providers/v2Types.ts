import type * as vscode from "vscode";

export type V2MessagePart =
    | { type: "text"; text: string }
    | { type: "data"; mimeType: string; data: Uint8Array }
    | { type: "thinking"; value: string | string[]; id?: string; metadata?: Record<string, unknown> }
    | { type: "tool_call"; callId: string; name: string; input: unknown }
    | { type: "tool_result"; callId: string; content: ReadonlyArray<unknown> };

export interface V2ChatMessage {
    role: vscode.LanguageModelChatMessageRole;
    name: string | undefined;
    content: V2MessagePart[];
}

export type V2EmittedPart =
    | { type: "text"; value: string }
    | { type: "data"; mimeType: string; value: unknown }
    | { type: "thinking"; value: string | string[]; id?: string; metadata?: Record<string, unknown> }
    | { type: "tool_call"; index: number; id?: string; name?: string; args: string }
    | { type: "finish"; reason?: string }
    | { type: "response"; usage?: { inputTokens?: number; outputTokens?: number } };
