import * as vscode from "vscode";
import { StructuredLogger } from "../observability/structuredLogger";
import type { V2ChatMessage, V2MessagePart } from "../providers/v2Types";
import type { OpenAIChatMessage, OpenAIChatMessageContentItem, OpenAIChatRole, OpenAIToolCall } from "../types";

interface V2OpenAIConversionOptions {
    normalizeToolCallId: (id: string) => string;
    isCacheControlMimeType: (mimeType: string) => boolean;
}

interface TextLikeContent {
    type: "text";
    text: string;
}
interface JsonLikeContent {
    type: "json";
    value: unknown;
}
interface DataLikeContent {
    type: "data";
    mimeType: string;
    data: string;
}
type SerializedToolResultContent = TextLikeContent | JsonLikeContent | DataLikeContent;

/**
 * Converts V2 messages directly into the LiteLLM/OpenAI-compatible chat shape.
 *
 * The legacy V1 converter first downgraded V2 parts back into VS Code transport
 * objects and then grouped text/tool data by type. V2 keeps the discriminated
 * part stream intact so tool results, adjacent text, and structured payloads are
 * shaped once at the LiteLLM boundary without losing ordering intent.
 */
export function convertV2MessagesToOpenAI(
    messages: readonly V2ChatMessage[],
    options: V2OpenAIConversionOptions
): OpenAIChatMessage[] {
    const out: OpenAIChatMessage[] = [];

    messages.forEach((message, messageIndex) => {
        const role = toOpenAIRole(message.role);
        const textParts: string[] = [];
        const contentItems: OpenAIChatMessageContentItem[] = [];
        const toolCalls: OpenAIToolCall[] = [];

        const flushTextMessage = (): void => {
            const content = buildMessageContent(textParts, contentItems);
            if (!content) {
                return;
            }

            const emittedIndex = out.length;
            out.push({ role, content, name: message.name });
            StructuredLogger.trace("v2.convert.message_emitted", {
                messageIndex,
                emittedIndex,
                role,
                kind: "content",
                preview: previewContent(content),
            });
            textParts.length = 0;
            contentItems.length = 0;
        };

        const flushAssistantToolCalls = (): void => {
            if (toolCalls.length === 0) {
                return;
            }

            const content = buildMessageContent(textParts, contentItems);
            const emittedIndex = out.length;
            out.push({ role: "assistant", content, name: message.name, tool_calls: [...toolCalls] });
            StructuredLogger.trace("v2.convert.message_emitted", {
                messageIndex,
                emittedIndex,
                role: "assistant",
                kind: "tool_calls",
                toolCallCount: toolCalls.length,
                toolCallIds: toolCalls.map((toolCall) => toolCall.id),
                preview: content ? previewContent(content) : undefined,
            });
            textParts.length = 0;
            contentItems.length = 0;
            toolCalls.length = 0;
        };

        message.content.forEach((part, partIndex) => {
            StructuredLogger.trace("v2.convert.part", {
                messageIndex,
                partIndex,
                role,
                partType: part.type,
            });

            switch (part.type) {
                case "text":
                    textParts.push(part.text);
                    break;
                case "data":
                    appendDataPart(part, textParts, contentItems, options);
                    break;
                case "thinking":
                    textParts.push(Array.isArray(part.value) ? part.value.join("") : part.value);
                    break;
                case "tool_call":
                    toolCalls.push(toOpenAIToolCall(part, options));
                    break;
                case "tool_result": {
                    // A tool result is its own OpenAI/LiteLLM message. Flush any
                    // preceding content first so V2 part order is represented in
                    // the emitted message stream instead of being grouped by type.
                    flushAssistantToolCalls();
                    flushTextMessage();

                    const emittedIndex = out.length;
                    const normalizedCallId = options.normalizeToolCallId(part.callId);
                    const content = serializeToolResultContent(part.content);
                    out.push({ role: "tool", tool_call_id: normalizedCallId, content });
                    StructuredLogger.trace("v2.convert.message_emitted", {
                        messageIndex,
                        partIndex,
                        emittedIndex,
                        role: "tool",
                        kind: "tool_result",
                        rawCallId: part.callId,
                        normalizedCallId,
                        itemCount: part.content.length,
                        preview: previewText(content),
                    });
                    break;
                }
            }
        });

        flushAssistantToolCalls();
        flushTextMessage();
    });

    StructuredLogger.debug("v2.convert.completed", {
        inputMessageCount: messages.length,
        outputMessageCount: out.length,
    });

    return out;
}

function toOpenAIRole(role: V2ChatMessage["role"]): Exclude<OpenAIChatRole, "tool"> {
    if (role === "user" || role === vscode.LanguageModelChatMessageRole.User || (role as number) === 1) {
        return "user";
    }
    if (role === "assistant" || role === vscode.LanguageModelChatMessageRole.Assistant || (role as number) === 2) {
        return "assistant";
    }
    return "system";
}

function toOpenAIToolCall(
    part: Extract<V2MessagePart, { type: "tool_call" }>,
    options: V2OpenAIConversionOptions
): OpenAIToolCall {
    const id = options.normalizeToolCallId(part.callId);
    let args = "{}";
    try {
        args = JSON.stringify(part.input ?? {});
    } catch {
        StructuredLogger.warn("v2.convert.tool_call_args_unserializable", {
            rawCallId: part.callId,
            normalizedCallId: id,
            toolName: part.name,
        });
    }

    return { id, type: "function", function: { name: part.name, arguments: args } };
}

function appendDataPart(
    part: Extract<V2MessagePart, { type: "data" }>,
    textParts: string[],
    contentItems: OpenAIChatMessageContentItem[],
    options: V2OpenAIConversionOptions
): void {
    if (options.isCacheControlMimeType(part.mimeType)) {
        StructuredLogger.trace("v2.convert.cache_control_dropped", { mimeType: part.mimeType });
        return;
    }

    if (part.mimeType.startsWith("image/")) {
        contentItems.push({
            type: "image_url",
            image_url: {
                url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}`,
            },
        });
        return;
    }

    if (part.mimeType.startsWith("text/") || part.mimeType.includes("json")) {
        textParts.push(Buffer.from(part.data).toString("utf-8"));
    }
}

function buildMessageContent(
    textParts: readonly string[],
    contentItems: readonly OpenAIChatMessageContentItem[]
): string | OpenAIChatMessageContentItem[] | undefined {
    const text = textParts.join("");
    if (contentItems.length === 0) {
        return text || undefined;
    }

    const items: OpenAIChatMessageContentItem[] = [];
    if (text) {
        items.push({ type: "text", text });
    }
    items.push(...contentItems);
    return items;
}

function serializeToolResultContent(content: ReadonlyArray<unknown>): string {
    const serialized = content
        .map(serializeToolResultItem)
        .filter((item): item is SerializedToolResultContent => !!item);

    if (serialized.length === 0) {
        return "Success";
    }

    if (serialized.length === 1 && serialized[0].type === "text") {
        return serialized[0].text;
    }

    return JSON.stringify({ type: "tool_result", content: serialized });
}

function serializeToolResultItem(item: unknown): SerializedToolResultContent | undefined {
    if (item instanceof vscode.LanguageModelTextPart) {
        return { type: "text", text: item.value };
    }

    if (typeof item === "string") {
        return { type: "text", text: item };
    }

    if (item instanceof vscode.LanguageModelDataPart) {
        return {
            type: "data",
            mimeType: item.mimeType,
            data: Buffer.from(item.data).toString("base64"),
        };
    }

    if (item === undefined) {
        return undefined;
    }

    return { type: "json", value: item };
}

function previewContent(content: string | OpenAIChatMessageContentItem[]): string {
    if (typeof content === "string") {
        return previewText(content);
    }
    return previewText(JSON.stringify(content));
}

function previewText(text: string): string {
    return text.length <= 160 ? text : `${text.slice(0, 157)}...`;
}
