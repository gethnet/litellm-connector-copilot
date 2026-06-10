import type { V2ChatMessage, V2MessagePart } from "../providers/v2Types";
import type { OpenAIChatMessage, OpenAIChatMessageContentItem, OpenAIToolCall, OpenAIChatRole } from "../types";
import { Logger } from "../utils/logger";
import { isCacheControlMimeType } from "../utils";
import { sanitizeToolName, logToolNameTruncationLegacy } from "../utils/toolNameUtils";

/**
 * Options for message conversion from V2 format to OpenAI format.
 */
export interface MessageConversionOptions {
    /**
     * Normalize tool call IDs to ensure they are valid for LiteLLM/OpenAI.
     * Required to prevent tool call rejection due to overly long IDs.
     */
    normalizeToolCallId: (id: string, maxLen?: number) => string;
}

/**
 * Converts V2 messages directly into the LiteLLM/OpenAI-compatible chat shape.
 *
 * This function merges the v1 convertMessages() logic from liteLLMProviderBase.ts
 * with the v2 converter's improved handling of structured content and tool calls.
 * It preserves the V2 part stream integrity so tool results, adjacent text, and
 * structured payloads are shaped once at the LiteLLM boundary without losing
 * ordering intent.
 *
 * Key behaviors:
 * - Supports V2ChatMessage part types: text, data, thinking, tool_call, tool_result
 * - Uses V2ChatMessage role for language model detection (preserves HCP role mapping)
 * - Normalizes tool calls via normalizeToolCallId before emitting
 * - Handles images via data MIME parts (base64 encoded for OpenAI image_url format)
 * - Drops cache-control MIME parts (they're opaque metadata, not content)
 * - Emits tool-result messages flush before regular messages (maintains ordering)
 *
 * The message flushing ordering ensures V2 part ordering is represented in
 * the emitted message stream instead of being grouped by type.
 *
 * @param messages - V2 chat messages from VS Code's language model API
 * @param options - Options for message conversion
 * @returns OpenAI-compatible chat messages suitable for LiteLLM
 */
export function convertMessagesToOpenAI(
    messages: readonly V2ChatMessage[],
    options: MessageConversionOptions
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
            Logger.trace("[convertMessagesToOpenAI] message_emitted", {
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
            Logger.trace("[convertMessagesToOpenAI] message_emitted", {
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
            Logger.trace("[convertMessagesToOpenAI] part", {
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
                    const content = serializeToolResultContent(part.content, options);
                    out.push({ role: "tool", tool_call_id: normalizedCallId, content });
                    Logger.trace("[convertMessagesToOpenAI] message_emitted", {
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

    Logger.debug("[convertMessagesToOpenAI] completed", {
        inputMessageCount: messages.length,
        outputMessageCount: out.length,
    });

    return out;
}

/**
 * Converts a V2ChatMessage role to an OpenAI role.
 *
 * Preserves language model detection logic from V1: maps VS Code HCP
 * enum values and numeric roles to OpenAI-compatible values.
 *
 * @param role - V2ChatMessage role (string, VS Code HCP enum, or numeric)
 * @returns OpenAI role (user, assistant, or system)
 */
type VSCodeConstructor = new (...args: unknown[]) => unknown;

interface VSCodeRoleEnum {
    User?: string | number;
    Assistant?: string | number;
}

interface VSCodeGlobal {
    LanguageModelChatMessageRole?: VSCodeRoleEnum;
    LanguageModelTextPart?: VSCodeConstructor;
    LanguageModelDataPart?: VSCodeConstructor;
}

function getVSCodeGlobal(): VSCodeGlobal | undefined {
    const candidate = (globalThis as { vscode?: unknown }).vscode;
    if (candidate && typeof candidate === "object") {
        return candidate as VSCodeGlobal;
    }
    return undefined;
}

function toOpenAIRole(role: V2ChatMessage["role"]): OpenAIChatRole {
    const vscodeGlobal = getVSCodeGlobal();
    const roles = vscodeGlobal?.LanguageModelChatMessageRole;
    const userRole = roles?.User;
    const assistantRole = roles?.Assistant;

    if (role === "user" || (userRole !== undefined && role === userRole) || (typeof role === "number" && role === 1)) {
        return "user";
    }
    if (
        role === "assistant" ||
        (assistantRole !== undefined && role === assistantRole) ||
        (typeof role === "number" && role === 2)
    ) {
        return "assistant";
    }
    return "system";
}

/**
 * Converts a V2 tool_call part to OpenAI's tool call format.
 *
 * @param part - V2 tool_call part
 * @param options - Conversion options with ID normalization function
 * @returns OpenAI-compatible tool call object
 */
function toOpenAIToolCall(
    part: Extract<V2MessagePart, { type: "tool_call" }>,
    options: MessageConversionOptions
): OpenAIToolCall {
    const id = options.normalizeToolCallId(part.callId);
    let args = "{}";
    try {
        args = JSON.stringify(part.input ?? {});
    } catch {
        Logger.warn("[convertMessagesToOpenAI] tool_call_args_unserializable", {
            rawCallId: part.callId,
            normalizedCallId: id,
            toolName: part.name,
        });
    }

    // Sanitize tool name for AWS Bedrock Converse API (64-char limit + naming rules).
    // The Bedrock toolUse.name field rejects names longer than 64 characters, names
    // starting with non-letter characters, and names with unsupported punctuation.
    const sanitized = sanitizeToolName(part.name);
    if (sanitized.wasTruncated) {
        logToolNameTruncationLegacy({
            originalName: part.name,
            source: "messageConverter.toOpenAIToolCall",
        });
    } else if (sanitized.name !== part.name) {
        Logger.trace("[convertMessagesToOpenAI] tool_name_normalized", {
            originalName: part.name,
            sanitizedName: sanitized.name,
        });
    }

    return {
        id,
        type: "function",
        function: { name: sanitized.name, arguments: args },
    };
}

/**
 * Appends a V2 data part to text or content items.
 *
 * Handles cache-control MIME parts (dropped), image MIME parts (converted
 * to image_url content items), and text/json MIME parts (appended to text parts).
 *
 * @param part - V2 data part
 * @param textParts - Buffer for text-only content
 * @param contentItems - Buffer for structured content items
 * @param options - Conversion options
 */
function appendDataPart(
    part: Extract<V2MessagePart, { type: "data" }>,
    textParts: string[],
    contentItems: OpenAIChatMessageContentItem[],
    _options: MessageConversionOptions
): void {
    if (isCacheControlMimeType(part.mimeType)) {
        Logger.trace("[convertMessagesToOpenAI] cache_control_dropped", { mimeType: part.mimeType });
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

/**
 * Builds a combined content string and/or content items array from text parts.
 *
 * @param textParts - Accumulated text parts (strings)
 * @param contentItems - Accumulated content items (image_url, etc.)
 * @returns Combined content as string or array, undefined if empty
 */
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

/**
 * Serializes a tool result array into a string.
 *
 * Renumbers serialized content items to preserve OpenAI tool result semantics
 * while accepting VS Code's more flexible input structure.
 *
 * @param content - Tool result content items
 * @param options - Conversion options
 * @returns Serialized tool result as string
 */
function serializeToolResultContent(content: readonly unknown[], options: MessageConversionOptions): string {
    const serialized = content
        .map((item) => serializeToolResultItem(item, options))
        .filter((item): item is SerializedToolResultContent => !!item);

    if (serialized.length === 0) {
        return "Success";
    }

    if (serialized.length === 1 && serialized[0].type === "text") {
        return serialized[0].text;
    }

    return JSON.stringify({ type: "tool_result", content: serialized });
}

/**
 * Helper types for serialized tool result content items.
 */
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
 * Serialize a single tool result item.
 *
 * Handles VS Code parts, strings, and JSON objects.
 *
 * @param item - Tool result content item
 * @param options - Conversion options
 * @returns Serialized content item or undefined if cache control should be dropped
 */
function serializeToolResultItem(
    item: unknown,
    _options: MessageConversionOptions
): SerializedToolResultContent | undefined {
    const vscodeGlobal = getVSCodeGlobal();
    const TextPartCtor = vscodeGlobal?.LanguageModelTextPart;
    const DataPartCtor = vscodeGlobal?.LanguageModelDataPart;

    // Handle VS Code native parts
    if (TextPartCtor && (item as unknown) instanceof TextPartCtor) {
        return { type: "text", text: (item as { value: string }).value };
    }

    if (typeof item === "string") {
        return { type: "text", text: item };
    }

    if (DataPartCtor && (item as unknown) instanceof DataPartCtor) {
        if (isCacheControlMimeType((item as { mimeType: string }).mimeType)) {
            Logger.trace("[convertMessagesToOpenAI] tool_result_cache_control_dropped", {
                mimeType: (item as { mimeType: string }).mimeType,
            });
            return undefined;
        }
        return {
            type: "data",
            mimeType: (item as { mimeType: string }).mimeType,
            data: Buffer.from((item as { data: Uint8Array }).data).toString("base64"),
        };
    }

    // Handle JSON objects or other structures
    if (item === undefined) {
        return undefined;
    }

    return { type: "json", value: item };
}

/**
 * Preview a content value for tracing/debugging.
 *
 * Truncates long content to a maximum length for readability in logs.
 *
 * @param content - Content to preview
 * @returns Truncated preview
 */
function previewContent(content: string | OpenAIChatMessageContentItem[]): string {
    if (typeof content === "string") {
        return previewText(content);
    }
    return previewText(JSON.stringify(content));
}

/**
 * Preview a text string for tracing/debugging.
 *
 * @param text - Text to preview
 * @returns Truncated preview
 */
function previewText(text: string): string {
    return text.length <= 160 ? text : `${text.slice(0, 157)}...`;
}
