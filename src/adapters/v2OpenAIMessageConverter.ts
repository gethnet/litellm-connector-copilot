import * as vscode from "vscode";
import { StructuredLogger } from "../observability/structuredLogger";
import { sanitizeToolName } from "../utils/toolNameUtils";
import type { V2ChatMessage, V2MessagePart } from "../providers/v2Types";
import type { OpenAIChatMessage, OpenAIChatMessageContentItem, OpenAIChatRole, OpenAIToolCall } from "../types";
import { applyEphemeralCacheControl } from "../utils/promptCacheControl";

interface V2OpenAIConversionOptions {
    normalizeToolCallId: (id: string) => string;
    isCacheControlMimeType: (mimeType: string) => boolean;
    attachPromptCacheControl?: boolean;
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
        let hasCacheControlMarker = false;

        const flushTextMessage = (): void => {
            const content = buildMessageContent(textParts, contentItems, hasCacheControlMarker);
            if (!content) {
                return;
            }

            if (hasCacheControlMarker && Array.isArray(content)) {
                applyEphemeralCacheControl(content);
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
            hasCacheControlMarker = false;
        };

        const flushAssistantToolCalls = (): void => {
            if (toolCalls.length === 0) {
                return;
            }

            const content = buildMessageContent(textParts, contentItems, hasCacheControlMarker);
            if (hasCacheControlMarker && Array.isArray(content)) {
                applyEphemeralCacheControl(content);
            }
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
            hasCacheControlMarker = false;
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
                    hasCacheControlMarker = appendDataPart(part, textParts, contentItems, options) || hasCacheControlMarker;
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
                    const serialized = serializeToolResultContent(part.content, options);
                    const toolContent: string | OpenAIChatMessageContentItem[] =
                        options.attachPromptCacheControl === true && serialized.hasCacheControlMarker
                            ? [{ type: "text", text: serialized.content }]
                            : serialized.content;
                    if (Array.isArray(toolContent)) {
                        applyEphemeralCacheControl(toolContent);
                    }
                    out.push({ role: "tool", tool_call_id: normalizedCallId, content: toolContent });
                    StructuredLogger.trace("v2.convert.message_emitted", {
                        messageIndex,
                        partIndex,
                        emittedIndex,
                        role: "tool",
                        kind: "tool_result",
                        rawCallId: part.callId,
                        normalizedCallId,
                        itemCount: part.content.length,
                        preview: previewText(serialized.content),
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

    // Apply tool name sanitization for AWS Bedrock Converse API compliance (64-char limit)
    const { name } = sanitizeToolName(part.name);
    return { id, type: "function", function: { name, arguments: args } };
}

function appendDataPart(
    part: Extract<V2MessagePart, { type: "data" }>,
    textParts: string[],
    contentItems: OpenAIChatMessageContentItem[],
    options: V2OpenAIConversionOptions
): boolean {
    if (options.isCacheControlMimeType(part.mimeType)) {
        StructuredLogger.trace("v2.convert.cache_control_dropped", { mimeType: part.mimeType });
        return options.attachPromptCacheControl === true;
    }

    if (part.mimeType.startsWith("image/")) {
        contentItems.push({
            type: "image_url",
            image_url: {
                url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}`,
            },
        });
        return false;
    }

    if (part.mimeType.startsWith("text/") || part.mimeType.includes("json")) {
        textParts.push(Buffer.from(part.data).toString("utf-8"));
    }
    return false;
}

function buildMessageContent(
    textParts: readonly string[],
    contentItems: readonly OpenAIChatMessageContentItem[],
    forceContentItems = false
): string | OpenAIChatMessageContentItem[] | undefined {
    const text = textParts.join("");
    if (contentItems.length === 0 && !forceContentItems) {
        return text || undefined;
    }

    const items: OpenAIChatMessageContentItem[] = [];
    if (text) {
        items.push({ type: "text", text });
    }
    items.push(...contentItems);
    return items;
}

function serializeToolResultContent(
    content: readonly unknown[],
    options: V2OpenAIConversionOptions
): { content: string; hasCacheControlMarker: boolean } {
    const hasCacheControlMarker = content.some(
        (item) => item instanceof vscode.LanguageModelDataPart && options.isCacheControlMimeType(item.mimeType)
    );
    const serialized = content
        .map((item) => serializeToolResultItem(item, options))
        .filter((item): item is SerializedToolResultContent => !!item);

    if (serialized.length === 0) {
        return { content: "Success", hasCacheControlMarker };
    }

    if (serialized.length === 1 && serialized[0].type === "text") {
        return { content: serialized[0].text, hasCacheControlMarker };
    }

    return { content: JSON.stringify({ type: "tool_result", content: serialized }), hasCacheControlMarker };
}

function serializeToolResultItem(
    item: unknown,
    options: V2OpenAIConversionOptions
): SerializedToolResultContent | undefined {
    if (item instanceof vscode.LanguageModelTextPart) {
        return { type: "text", text: item.value };
    }

    if (typeof item === "string") {
        return { type: "text", text: item };
    }

    if (item instanceof vscode.LanguageModelDataPart) {
        if (options.isCacheControlMimeType(item.mimeType)) {
            StructuredLogger.trace("v2.convert.tool_result_cache_control_dropped", { mimeType: item.mimeType });
            return undefined;
        }
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
