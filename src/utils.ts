import * as vscode from "vscode";
import type { V2ChatMessage, V2MessagePart } from "./providers/v2Types";
import type {
    OpenAIChatMessage,
    OpenAIChatRole,
    OpenAIFunctionToolDef,
    OpenAIToolCall,
    OpenAIChatMessageContentItem,
} from "./types";

/**
 * OpenAI-compatible tool_call ids are commonly limited to <= 40 chars.
 * VS Code tool call ids can be longer; LiteLLM/OpenAI will reject them.
 *
 * Strategy:
 * - Always ensure IDs start with 'fc_' to satisfy strict models (e.g. gpt-5.3-codex).
 * - For longer ids, deterministically shrink to <= 40 using a stable hash.
 * - Preserve a readable prefix for debugging.
 */
export function normalizeToolCallId(id: string, maxLen = 40): string {
    const raw = (id || "").trim();
    const prefix = "fc_";

    if (!raw) {
        const generated = prefix + stableHash("empty").slice(0, maxLen - prefix.length);
        Logger.trace(`[normalizeToolCallId] Empty ID provided, generated: ${generated}`);
        return generated;
    }

    // If it already starts with fc_ and is short enough, keep it
    if (raw.startsWith(prefix) && raw.length <= maxLen) {
        Logger.trace(`[normalizeToolCallId] Valid ID kept as-is: ${raw}`);
        return raw;
    }

    // Otherwise, normalize it to ensure it starts with fc_
    // Strip common prefixes we want to replace to keep the middle part readable
    const cleanRaw = raw.replace(/^call_|^tc_/, "");
    const safeMiddle = cleanRaw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 10);
    const hash = stableHash(raw); // Hash the FULL original ID for stability
    const out = `${prefix}${safeMiddle}_${hash}`;
    const final = out.length <= maxLen ? out : out.slice(0, maxLen);

    Logger.trace(`[normalizeToolCallId] ID normalized to satisfy prefix/length: ${raw} -> ${final}`);
    return final;
}

function stableHash(input: string): string {
    // Must work in BOTH extension host (node) and web bundle.
    // Use a small, deterministic, non-crypto hash (FNV-1a 64-bit) and encode as hex.
    // Collision risk is low for our use (shrinking IDs) and avoids bundling Node builtins.
    let hash = 0xcbf29ce484222325n; // offset basis
    const prime = 0x100000001b3n;
    for (const ch of input) {
        hash ^= BigInt(ch.codePointAt(0) ?? 0);
        hash = (hash * prime) & 0xffffffffffffffffn;
    }
    return hash.toString(16).padStart(16, "0");
}
import { Logger } from "./utils/logger";

// Tool calling sanitization helpers

function isIntegerLikePropertyName(propertyName: string | undefined): boolean {
    if (!propertyName) {
        return false;
    }
    const lowered = propertyName.toLowerCase();
    const integerMarkers = [
        "id",
        "limit",
        "count",
        "index",
        "size",
        "offset",
        "length",
        "results_limit",
        "maxresults",
        "debugsessionid",
        "cellid",
    ];
    return integerMarkers.some((m) => lowered.includes(m)) || lowered.endsWith("_id");
}

function sanitizeFunctionName(name: unknown): string {
    if (typeof name !== "string" || !name) {
        return "tool";
    }
    let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!/^[a-zA-Z]/.test(sanitized)) {
        sanitized = `tool_${sanitized}`;
    }
    sanitized = sanitized.replace(/_+/g, "_");
    return sanitized.slice(0, 64);
}

function pruneUnknownSchemaKeywords(schema: unknown): Record<string, unknown> {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        return {};
    }
    const allow = new Set([
        "type",
        "properties",
        "required",
        "additionalProperties",
        "description",
        "enum",
        "default",
        "items",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "pattern",
        "format",
    ]);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
        if (allow.has(k)) {
            out[k] = v as unknown;
        }
    }
    return out;
}

/**
 * Strips Markdown code blocks from a string.
 * If the string contains triple backticks, it extracts the content inside them.
 * If multiple code blocks exist, it joins them.
 * If no code blocks exist, it returns the original string trimmed.
 */
export function stripMarkdownCodeBlocks(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.includes("```")) {
        return trimmed;
    }

    // Regex to match code blocks: ```[lang]\n(content)\n```
    // Supports optional language tag and handles non-greedy matching for content.
    const codeBlockRegex = /```(?:\w+)?\s*([\s\S]*?)\s*```/g;
    const matches = [...trimmed.matchAll(codeBlockRegex)];

    if (matches.length > 0) {
        return matches
            .map((m) => m[1].trim())
            .filter((content) => content.length > 0)
            .join("\n\n");
    }

    // Fallback: if there are backticks but no complete block match,
    // just strip the backticks themselves as a safety measure.
    return trimmed.replace(/```/g, "").trim();
}

function sanitizeSchema(input: unknown, propName?: string): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return { type: "object", properties: {} } as Record<string, unknown>;
    }

    let schema = input as Record<string, unknown>;

    for (const composite of ["anyOf", "oneOf", "allOf"]) {
        const branch = (schema as Record<string, unknown>)[composite] as unknown;
        if (Array.isArray(branch) && branch.length > 0) {
            let preferred: Record<string, unknown> | undefined;
            for (const b of branch) {
                if (b && typeof b === "object" && (b as Record<string, unknown>).type === "string") {
                    preferred = b as Record<string, unknown>;
                    break;
                }
            }
            schema = { ...(preferred ?? (branch[0] as Record<string, unknown>)) };
            break;
        }
    }

    schema = pruneUnknownSchemaKeywords(schema);

    let t = schema.type as string | undefined;
    if (t === null) {
        t = "object";
        schema.type = t;
    }

    if (t === "number" && propName && isIntegerLikePropertyName(propName)) {
        schema.type = "integer";
        t = "integer";
    }

    if (t === "object") {
        const props = (schema.properties as Record<string, unknown> | undefined) ?? {};
        const newProps: Record<string, unknown> = {};
        if (props && typeof props === "object") {
            for (const [k, v] of Object.entries(props)) {
                newProps[k] = sanitizeSchema(v, k);
            }
        }
        schema.properties = newProps;

        const req = schema.required as unknown;
        if (Array.isArray(req)) {
            schema.required = req.filter((r) => typeof r === "string");
        } else if (req !== undefined) {
            schema.required = [];
        }

        const ap = schema.additionalProperties as unknown;
        if (ap !== undefined && typeof ap !== "boolean") {
            delete schema.additionalProperties;
        }
    } else if (t === "array") {
        const items = schema.items as unknown;
        if (Array.isArray(items) && items.length > 0) {
            schema.items = sanitizeSchema(items[0]);
        } else if (items && typeof items === "object") {
            schema.items = sanitizeSchema(items);
        } else {
            schema.items = { type: "string" } as Record<string, unknown>;
        }
    }

    return schema;
}

/**
 * Convert VS Code chat request messages into OpenAI-compatible message objects.
 * @param messages The VS Code chat messages to convert.
 * @returns OpenAI-compatible messages array.
 */
export function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIChatMessage[] {
    const out: OpenAIChatMessage[] = [];
    for (const m of messages) {
        const role = mapRole(m);
        const textParts: string[] = [];
        const contentItems: OpenAIChatMessageContentItem[] = [];
        const toolCalls: OpenAIToolCall[] = [];
        const toolResults: { callId: string; content: string }[] = [];

        for (const part of m.content ?? []) {
            if (part instanceof vscode.LanguageModelTextPart) {
                textParts.push(part.value);
            } else if (part instanceof vscode.LanguageModelDataPart) {
                // Handle image and other data parts
                if (part.mimeType.startsWith("image/")) {
                    // Convert image data to base64 for OpenAI vision API
                    let base64Data: string;
                    if (part.data instanceof Uint8Array) {
                        base64Data = Buffer.from(part.data).toString("base64");
                    } else if (typeof part.data === "string") {
                        base64Data = Buffer.from(part.data, "utf-8").toString("base64");
                    } else {
                        base64Data = Buffer.from(part.data as unknown as ArrayBuffer).toString("base64");
                    }
                    contentItems.push({
                        type: "image_url",
                        image_url: {
                            url: `data:${part.mimeType};base64,${base64Data}`,
                        },
                    });
                } else if (part.mimeType.startsWith("application/json")) {
                    // Handle JSON data parts by decoding and appending as text
                    const jsonStr = Buffer.from(part.data).toString("utf-8");
                    textParts.push(jsonStr);
                } else if (part.mimeType.startsWith("text/")) {
                    // Handle explicit text data parts
                    const textStr = Buffer.from(part.data).toString("utf-8");
                    textParts.push(textStr);
                } else if (part.mimeType === "cache_control") {
                    // Handle cache_control data parts (e.g. for prompt caching)
                    // We log this for now to verify it's being received;
                    // actual implementation depends on the specific provider support in LiteLLM.
                    Logger.trace(
                        `[convertMessages] Received cache_control part: ${Buffer.from(part.data).toString("utf-8")}`
                    );
                }
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                const id = normalizeToolCallId(
                    part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                );
                Logger.trace(`[convertMessages] Tool call: ${part.name} (orig: ${part.callId}, norm: ${id})`);
                let args = "{}";
                try {
                    args = JSON.stringify(part.input ?? {});
                } catch {
                    // Fallback to empty JSON if stringify fails
                }
                toolCalls.push({ id, type: "function", function: { name: part.name, arguments: args } });
            } else if (isToolResultPart(part)) {
                const callId = normalizeToolCallId((part as { callId?: string }).callId ?? "");
                Logger.trace(
                    `[convertMessages] Tool result: (orig: ${(part as { callId?: string }).callId}, norm: ${callId})`
                );
                const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
                toolResults.push({ callId, content });
            }
        }

        let emittedAssistantToolCall = false;
        if (toolCalls.length > 0) {
            const messageContent = buildMessageContent(textParts, contentItems);
            out.push({ role: "assistant", content: messageContent || undefined, tool_calls: toolCalls });
            emittedAssistantToolCall = true;
        }

        for (const tr of toolResults) {
            out.push({ role: "tool", tool_call_id: tr.callId, content: tr.content || "Success" });
        }

        const text = textParts.join("");
        if (text || contentItems.length > 0) {
            if (role === "system" || role === "user" || (role === "assistant" && !emittedAssistantToolCall)) {
                const messageContent = buildMessageContent(textParts, contentItems);
                if (messageContent) {
                    out.push({ role: role || "user", content: messageContent });
                }
            }
        }
    }
    return out;
}

function toUint8Array(data: unknown): Uint8Array {
    if (data instanceof Uint8Array) {
        return data;
    }
    if (typeof data === "string") {
        return Buffer.from(data, "utf-8");
    }
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    return Buffer.from(JSON.stringify(data ?? null), "utf-8");
}

function decodeV2DataPart(part: Extract<V2MessagePart, { type: "data" }>): string | undefined {
    if (part.mimeType.startsWith("text/") || part.mimeType.includes("json") || part.mimeType === "cache_control") {
        return Buffer.from(part.data).toString("utf-8");
    }
    return undefined;
}

export function normalizeMessagesForV2Pipeline(
    messages: readonly (
        | vscode.LanguageModelChatRequestMessage
        | vscode.LanguageModelChatMessage2
        | vscode.LanguageModelChatMessage
    )[]
): V2ChatMessage[] {
    return messages.map((message) => {
        const content: V2MessagePart[] = [];
        for (const part of message.content ?? []) {
            if (part instanceof vscode.LanguageModelTextPart) {
                content.push({ type: "text", text: part.value });
                continue;
            }
            if (part instanceof vscode.LanguageModelDataPart) {
                content.push({
                    type: "data",
                    mimeType: part.mimeType,
                    data: toUint8Array(part.data),
                });
                continue;
            }
            if (part instanceof vscode.LanguageModelToolCallPart) {
                content.push({
                    type: "tool_call",
                    callId: part.callId,
                    name: part.name,
                    input: part.input,
                });
                continue;
            }
            if (isToolResultPart(part)) {
                content.push({
                    type: "tool_result",
                    callId: (part as { callId: string }).callId,
                    content: (part as { content: ReadonlyArray<unknown> }).content ?? [],
                });
                continue;
            }

            const maybeThinking = part as {
                value?: string | string[];
                id?: string;
                metadata?: Record<string, unknown>;
            };
            if (typeof maybeThinking?.value === "string" || Array.isArray(maybeThinking?.value)) {
                content.push({
                    type: "thinking",
                    value: maybeThinking.value,
                    id: maybeThinking.id,
                    metadata: maybeThinking.metadata,
                });
            }
        }

        return {
            role: message.role,
            name: message.name,
            content,
        };
    });
}

export function convertV2MessagesToProviderMessages(
    messages: readonly V2ChatMessage[]
): vscode.LanguageModelChatRequestMessage[] {
    const downgraded: vscode.LanguageModelChatRequestMessage[] = messages.map((message) => {
        const content: Array<vscode.LanguageModelInputPart | unknown> = [];

        for (const part of message.content) {
            switch (part.type) {
                case "text":
                    content.push(new vscode.LanguageModelTextPart(part.text));
                    break;
                case "data":
                    if (part.mimeType.startsWith("image/")) {
                        content.push(new vscode.LanguageModelDataPart(part.data, part.mimeType));
                    } else if (part.mimeType.startsWith("text/")) {
                        content.push(new vscode.LanguageModelDataPart(part.data, part.mimeType));
                    }
                    break;
                case "thinking":
                    break;
                case "tool_call":
                    content.push(
                        new vscode.LanguageModelToolCallPart(
                            part.callId,
                            part.name,
                            (part.input ?? {}) as Record<string, unknown>
                        )
                    );
                    break;
                case "tool_result":
                    content.push(new vscode.LanguageModelToolResultPart(part.callId, [...part.content]));
                    break;
            }
        }

        return {
            role: message.role,
            name: message.name,
            content,
        } as vscode.LanguageModelChatRequestMessage;
    });

    return downgraded;
}

export function convertV2MessagesToOpenAI(messages: readonly V2ChatMessage[]): OpenAIChatMessage[] {
    return convertMessages(convertV2MessagesToTransportMessages(messages));
}

export function convertV2MessagesToTransportMessages(
    messages: readonly V2ChatMessage[]
): vscode.LanguageModelChatRequestMessage[] {
    return messages.map((message) => {
        const content: Array<vscode.LanguageModelInputPart | unknown> = [];

        for (const part of message.content) {
            switch (part.type) {
                case "text":
                    content.push(new vscode.LanguageModelTextPart(part.text));
                    break;
                case "data":
                    if (part.mimeType.startsWith("image/")) {
                        content.push(new vscode.LanguageModelDataPart(part.data, part.mimeType));
                    } else {
                        const decoded = decodeV2DataPart(part);
                        if (decoded) {
                            content.push(new vscode.LanguageModelTextPart(decoded));
                        }
                    }
                    break;
                case "thinking":
                    content.push(
                        new vscode.LanguageModelTextPart(Array.isArray(part.value) ? part.value.join("") : part.value)
                    );
                    break;
                case "tool_call":
                    content.push(
                        new vscode.LanguageModelToolCallPart(
                            part.callId,
                            part.name,
                            (part.input ?? {}) as Record<string, unknown>
                        )
                    );
                    break;
                case "tool_result":
                    content.push(new vscode.LanguageModelToolResultPart(part.callId, [...part.content]));
                    break;
            }
        }

        return {
            role: message.role,
            name: message.name,
            content,
        } as vscode.LanguageModelChatRequestMessage;
    });
}

export function validateV2Messages(messages: readonly V2ChatMessage[]): void {
    const downgraded = messages.map((message) => ({
        role: message.role,
        name: message.name,
        content: message.content
            .filter((part) => part.type !== "thinking")
            .map((part) => {
                switch (part.type) {
                    case "text":
                        return new vscode.LanguageModelTextPart(part.text);
                    case "data":
                        return new vscode.LanguageModelDataPart(part.data, part.mimeType);
                    case "tool_call":
                        return new vscode.LanguageModelToolCallPart(
                            part.callId,
                            part.name,
                            (part.input ?? {}) as Record<string, unknown>
                        );
                    case "tool_result":
                        return new vscode.LanguageModelToolResultPart(part.callId, [...part.content]);
                    default:
                        return undefined;
                }
            })
            .filter((part): part is vscode.LanguageModelInputPart => part !== undefined),
    })) as vscode.LanguageModelChatRequestMessage[];

    validateRequest(downgraded);
}

/**
 * Build message content from text and content items.
 * If there are content items (images), return an array format.
 * Otherwise, return a simple string.
 */
function buildMessageContent(
    textParts: string[],
    contentItems: OpenAIChatMessageContentItem[]
): string | OpenAIChatMessageContentItem[] | undefined {
    const text = textParts.join("");

    if (contentItems.length === 0) {
        return text || undefined;
    }

    // If we have content items (images), create an array with both text and images
    const items: OpenAIChatMessageContentItem[] = [];
    if (text) {
        items.push({ type: "text", text });
    }
    items.push(...contentItems);

    return items.length > 0 ? items : undefined;
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 * @param options Request options containing tools and toolMode.
 */
export function convertTools(options: vscode.ProvideLanguageModelChatResponseOptions): {
    tools?: OpenAIFunctionToolDef[];
    tool_choice?: "auto" | { type: "function"; function: { name: string } };
} {
    const tools = options.tools ?? [];
    if (!tools || tools.length === 0) {
        return {};
    }

    const toolDefs: OpenAIFunctionToolDef[] = tools
        .filter((t): t is vscode.LanguageModelChatTool => t && typeof t === "object")
        .map((t: vscode.LanguageModelChatTool) => {
            const name = sanitizeFunctionName(t.name);
            const description = typeof t.description === "string" ? t.description : "";
            const params = sanitizeSchema(t.inputSchema ?? { type: "object", properties: {} });
            return {
                type: "function" as const,
                function: {
                    name,
                    description,
                    parameters: params,
                },
            } satisfies OpenAIFunctionToolDef;
        });

    let tool_choice: "auto" | { type: "function"; function: { name: string } } = "auto";
    if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
        if (tools.length !== 1) {
            Logger.error("ToolMode.Required but multiple tools:", tools.length);
            throw new Error("LanguageModelChatToolMode.Required is not supported with more than one tool");
        }
        tool_choice = { type: "function", function: { name: sanitizeFunctionName(tools[0].name) } };
    }

    return { tools: toolDefs, tool_choice };
}

/**
 * Validate tool names to ensure they contain only word chars, hyphens, or underscores.
 * @param tools Tools to validate.
 */
export function validateTools(tools: readonly vscode.LanguageModelChatTool[]): void {
    for (const tool of tools) {
        if (!tool.name.match(/^[\w-]+$/)) {
            Logger.error("Invalid tool name detected:", tool.name);
            throw new Error(
                `Invalid tool name "${tool.name}": only alphanumeric characters, hyphens, and underscores are allowed.`
            );
        }
    }
}

/**
 * Validate the request message sequence for correct tool call/result pairing.
 * @param messages The full request message list.
 */
export function validateRequest(messages: readonly vscode.LanguageModelChatRequestMessage[]): void {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) {
        Logger.error("No messages in request");
        throw new Error("Invalid request: no messages.");
    }

    messages.forEach((message, i) => {
        if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
            const toolCallIds = new Set(
                message.content
                    .filter((part) => part instanceof vscode.LanguageModelToolCallPart)
                    .map((part) => (part as unknown as vscode.LanguageModelToolCallPart).callId)
            );
            if (toolCallIds.size === 0) {
                return;
            }

            let nextMessageIdx = i + 1;
            const errMsg =
                "Invalid request: Tool call part must be followed by a User message with a LanguageModelToolResultPart with a matching callId.";
            while (toolCallIds.size > 0) {
                const nextMessage = messages[nextMessageIdx++];
                if (!nextMessage || nextMessage.role !== vscode.LanguageModelChatMessageRole.User) {
                    Logger.error("Validation failed: missing tool result for call IDs:", Array.from(toolCallIds));
                    throw new Error(errMsg);
                }

                nextMessage.content.forEach((part) => {
                    if (!isToolResultPart(part)) {
                        const ctorName =
                            (Object.getPrototypeOf(part as object) as { constructor?: { name?: string } } | undefined)
                                ?.constructor?.name ?? typeof part;
                        Logger.error("Validation failed: expected tool result part, got:", ctorName);
                        throw new Error(errMsg);
                    }
                    const callId = (part as { callId: string }).callId;
                    toolCallIds.delete(callId);
                });
            }
        }
    });
}

/**
 * Type guard for LanguageModelToolResultPart-like values.
 * @param value Unknown value to test.
 */
export function isToolResultPart(value: unknown): value is { callId: string; content?: ReadonlyArray<unknown> } {
    if (!value || typeof value !== "object") {
        return false;
    }
    const obj = value as Record<string, unknown>;
    const hasCallId = typeof obj.callId === "string";
    const hasContent = "content" in obj;
    return hasCallId && hasContent;
}

/**
 * Map VS Code message role to OpenAI message role string.
 * @param message The message whose role is mapped.
 */
function mapRole(message: vscode.LanguageModelChatRequestMessage): Exclude<OpenAIChatRole, "tool"> {
    const role = message.role;

    // Use string comparison if possible, or fall back to numeric comparison
    if (role === vscode.LanguageModelChatMessageRole.User) {
        return "user";
    }
    if (role === vscode.LanguageModelChatMessageRole.Assistant) {
        return "assistant";
    }

    // Default to system for everything else (including System role)
    return "system";
}

/**
 * Concatenate tool result content into a single text string.
 * @param pr Tool result-like object with content array.
 */
function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
    let text = "";
    for (const c of pr.content ?? []) {
        if (c instanceof vscode.LanguageModelTextPart) {
            text += c.value;
        } else if (typeof c === "string") {
            text += c;
        } else {
            try {
                text += JSON.stringify(c);
            } catch {
                /* ignore */
            }
        }
    }
    return text;
}

/**
 * Try to parse a JSON object from a string.
 * @param text The input string.
 * @returns Parsed object or ok:false.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
    try {
        if (!text || !/[{]/.test(text)) {
            return { ok: false };
        }
        const value = JSON.parse(text);
        if (value && typeof value === "object" && !Array.isArray(value)) {
            return { ok: true, value };
        }
        return { ok: false };
    } catch {
        return { ok: false };
    }
}
