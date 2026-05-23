import * as vscode from "vscode";
import type { LiteLLMModelInfo, OpenAIChatMessage } from "../types";
import { isAnthropicModel } from "../utils/modelUtils";
import { selectTokenizer } from "./tokenizers/selectTokenizer";
import type { V2ChatMessage } from "../providers/v2Types";
import type { TelemetryService } from "../telemetry/telemetryService";
import { isCacheControlMimeType } from "../utils";

export const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
export const DEFAULT_CONTEXT_LENGTH = 128000;
const SMART_OUTPUT_RESERVATION_MIN = 16000;
const SMART_OUTPUT_RESERVATION_MAX = 64000;

interface OutputReservationOptions {
    estimatedInputTokens?: number;
    modelInfo?: LiteLLMModelInfo;
}

let telemetryServiceInstance: TelemetryService | undefined;

export function setTelemetryService(service: TelemetryService): void {
    telemetryServiceInstance = service;
}

/**
 * Cache for static prompt token counts to avoid redundant calculations.
 */
const staticPromptTokenCache = new Map<string, number>();

/**
 * Calculates and caches the token count for static prompt strings.
 */
export function getStaticPromptTokenCount(prompt: string, modelId?: string, modelInfo?: LiteLLMModelInfo): number {
    const cacheKey = `${modelId || "default"}-${prompt.length}`;
    if (staticPromptTokenCache.has(cacheKey)) {
        return staticPromptTokenCache.get(cacheKey)!;
    }
    const count = countTokens(prompt, modelId, modelInfo);
    staticPromptTokenCache.set(cacheKey, count);
    return count;
}

/**
 * Calculates the available context window for a specific task.
 * Formula: Context Window = Max Input - Max Output - System Prompts - Safety Buffer
 */
export function calculateAvailableContext(
    maxInput: number,
    maxOutput: number,
    staticPrompts: string[],
    modelId?: string,
    modelInfo?: LiteLLMModelInfo,
    safetyBuffer = 0.05 // 5% default safety buffer
): number {
    let totalStaticTokens = 0;
    for (const prompt of staticPrompts) {
        totalStaticTokens += getStaticPromptTokenCount(prompt, modelId, modelInfo);
    }

    const available = maxInput - maxOutput - totalStaticTokens;
    return Math.max(0, Math.floor(available * (1 - safetyBuffer)));
}

/**
 * Centralized token counting utility.
 */
export function countTokens(
    input: string | vscode.LanguageModelChatRequestMessage | readonly vscode.LanguageModelChatRequestMessage[],
    modelId?: string,
    modelInfo?: LiteLLMModelInfo
): number {
    const tokenizer = selectTokenizer(modelId || "default", modelInfo);
    if (typeof input === "string") {
        return tokenizer.countTokens(input).tokens;
    }
    if (Array.isArray(input)) {
        let total = 0;
        for (const m of input) {
            total += tokenizer.countMessageTokens(m).tokens;
        }
        return total;
    }
    return tokenizer.countMessageTokens(input as vscode.LanguageModelChatRequestMessage).tokens;
}

/**
 * Counts tokens for the OpenAI-style transport messages that are actually sent
 * to LiteLLM after trimming and tool conversion.
 */
export function countOpenAIChatMessagesTokens(
    messages: readonly OpenAIChatMessage[],
    modelId?: string,
    modelInfo?: LiteLLMModelInfo
): number {
    const tokenizer = selectTokenizer(modelId || "default", modelInfo);
    let total = 0;

    for (const message of messages) {
        if (typeof message.content === "string") {
            total += tokenizer.countTokens(message.content).tokens;
        } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part.type === "text" && typeof part.text === "string") {
                    total += tokenizer.countTokens(part.text).tokens;
                }
            }
        }

        if (typeof message.name === "string" && message.name.length > 0) {
            total += tokenizer.countTokens(message.name).tokens;
        }

        if (typeof message.tool_call_id === "string" && message.tool_call_id.length > 0) {
            total += tokenizer.countTokens(message.tool_call_id).tokens;
        }

        if (Array.isArray(message.tool_calls)) {
            for (const toolCall of message.tool_calls) {
                total += tokenizer.countTokens(toolCall.function.name).tokens;
                total += tokenizer.countTokens(toolCall.function.arguments).tokens;
            }
        }
    }

    return total;
}

/**
 * Resolves the number of tokens reserved for model output in a request.
 */
export function getReservedOutputTokens(
    model: vscode.LanguageModelChatInformation,
    requestedMaxTokens?: number,
    options?: OutputReservationOptions
): number {
    if (typeof requestedMaxTokens === "number") {
        return Math.max(1, Math.min(requestedMaxTokens, model.maxOutputTokens));
    }

    const estimatedInputTokens =
        typeof options?.estimatedInputTokens === "number" && options.estimatedInputTokens > 0
            ? options.estimatedInputTokens
            : 0;
    const totalTokenLimit = getTotalTokenLimit(model, options?.modelInfo);

    // A "smart reservation" target in the requested 16k..64k range.
    // Larger requests reserve a larger output window, but we always clamp to model limits.
    const ratio = Math.min(1, estimatedInputTokens / 48000);
    const smartTarget = Math.round(
        SMART_OUTPUT_RESERVATION_MIN + (SMART_OUTPUT_RESERVATION_MAX - SMART_OUTPUT_RESERVATION_MIN) * ratio
    );

    // Keep a small structural headroom so output reservation does not completely consume the
    // context window when input is already large.
    const structuralHeadroom = 256;
    const remainingContextWindow = Math.max(1, totalTokenLimit - estimatedInputTokens - structuralHeadroom);

    return Math.max(1, Math.min(model.maxOutputTokens, smartTarget, remainingContextWindow));
}

/**
 * Resolves the total token window for the model.
 */
export function getTotalTokenLimit(model: vscode.LanguageModelChatInformation, modelInfo?: LiteLLMModelInfo): number {
    const rawLimit = modelInfo?.max_input_tokens ?? modelInfo?.context_window_tokens ?? modelInfo?.max_tokens;
    if (typeof rawLimit === "number" && rawLimit > 0) {
        return rawLimit;
    }
    return Math.max(1, model.maxInputTokens + model.maxOutputTokens);
}

export function countTokensForV2Messages(
    input: string | V2ChatMessage | readonly V2ChatMessage[],
    modelId?: string,
    modelInfo?: LiteLLMModelInfo
): number {
    if (typeof input === "string") {
        return countTokens(input, modelId, modelInfo);
    }

    // Properly type narrow to V2ChatMessage array for type safety
    const messages: readonly V2ChatMessage[] = Array.isArray(input)
        ? (input as readonly V2ChatMessage[])
        : [input as V2ChatMessage];
    let total = 0;
    for (const message of messages) {
        // Guard: ensure message has required V2ChatMessage properties
        if (!message || typeof message !== "object" || !("content" in message) || !("role" in message)) {
            continue;
        }
        const msgContent = (message as V2ChatMessage).content;
        if (!Array.isArray(msgContent)) {
            continue;
        }

        for (const part of msgContent) {
            switch (part.type) {
                case "text":
                    total += countTokens(part.text, modelId, modelInfo);
                    break;
                case "thinking":
                    total += countTokens(
                        Array.isArray(part.value) ? part.value.join("") : part.value,
                        modelId,
                        modelInfo
                    );
                    break;
                case "data":
                    // Skip cache_control parts — they are dropped at the
                    // transport layer (see decodeV2DataPart / convertMessages)
                    // and must not inflate the token budget. Checked BEFORE the
                    // JSON branch so that "application/vnd.cache-control+json"
                    // variants are also skipped.
                    if (isCacheControlMimeType(part.mimeType)) {
                        break;
                    }
                    if (part.mimeType.startsWith("text/") || part.mimeType.includes("json")) {
                        total += countTokens(Buffer.from(part.data).toString("utf-8"), modelId, modelInfo);
                    }
                    break;
                case "tool_call":
                    total += countTokens(`${part.name}${JSON.stringify(part.input ?? {})}`, modelId, modelInfo);
                    break;
                case "tool_result":
                    total += countTokens(JSON.stringify(part.content ?? []), modelId, modelInfo);
                    break;
            }
        }
    }
    return total;
}

/**
 * Roughly estimate tokens for VS Code chat messages (text only)
 */
export function estimateMessagesTokens(
    msgs: readonly vscode.LanguageModelChatRequestMessage[],
    modelId?: string,
    modelInfo?: LiteLLMModelInfo
): number {
    return countTokens(msgs, modelId, modelInfo);
}

/**
 * Roughly estimate tokens for a single VS Code chat message (text only)
 */
export function estimateSingleMessageTokens(
    msg: vscode.LanguageModelChatRequestMessage,
    modelId?: string,
    modelInfo?: LiteLLMModelInfo
): number {
    return countTokens(msg, modelId, modelInfo);
}

/**
 * Rough token estimate for tool definitions by JSON size
 */
export function estimateToolTokens(
    tools: { type: string; function: { name: string; description?: string; parameters?: object } }[] | undefined
): number {
    if (!tools || tools.length === 0) {
        return 0;
    }
    try {
        const json = JSON.stringify(tools);
        return Math.ceil(json.length / 4);
    } catch {
        return 0;
    }
}

/**
 * Determine whether a model should use stricter Anthropic-style budgeting.
 */
/**
 * Trim messages to fit within the model's input token budget, preserving the system prompt
 * and as much recent context as possible. Anthropic models get a safety margin to avoid
 * overfilling the context window.
 */
export function trimMessagesToFitBudget(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    tools: { type: string; function: { name: string; description?: string; parameters?: object } }[] | undefined,
    model: vscode.LanguageModelChatInformation,
    modelInfo?: LiteLLMModelInfo,
    hardBudgetOverride?: number
): readonly vscode.LanguageModelChatRequestMessage[] {
    const toolTokenCount = estimateToolTokens(tools);
    const tokenLimit = Math.max(1, model.maxInputTokens);

    const budgetLimit =
        hardBudgetOverride !== undefined
            ? Math.max(1, Math.floor(hardBudgetOverride))
            : (() => {
                  // Apply a flat safety buffer to avoid context overflow due to tokenizer variance,
                  // provider-side framing, and other hidden tokens.
                  //
                  // This is intentionally applied to *all* models (not just Anthropic) because
                  // overflow failures are catastrophic and the 5% reduction is a small tradeoff.
                  const bufferedLimit = Math.max(1, Math.floor(tokenLimit * 0.95));

                  // Keep an additional small margin for Anthropic-style models which tend to be
                  // stricter about context limits.
                  return isAnthropicModel(model.id, modelInfo)
                      ? Math.max(1, Math.floor(bufferedLimit * 0.98))
                      : bufferedLimit;
              })();

    const budget = budgetLimit - toolTokenCount;
    if (budget <= 0) {
        throw new Error("Message exceeds token limit.");
    }

    const originalTokens = countTokens(messages, model.id, modelInfo);

    let systemMessage: vscode.LanguageModelChatRequestMessage | undefined;
    const remaining: vscode.LanguageModelChatRequestMessage[] = [];
    const messageArray: readonly vscode.LanguageModelChatRequestMessage[] = Array.isArray(messages)
        ? messages
        : [messages];
    for (const msg of messageArray) {
        // Guard: ensure message has required properties before accessing role
        if (!msg || typeof msg !== "object" || !("role" in msg)) {
            continue;
        }
        const msgObj = msg as { role?: unknown };
        const roleValue =
            typeof msgObj.role === "number" ? msgObj.role : typeof msgObj.role === "string" ? msgObj.role : "";
        const isSystem =
            roleValue !== vscode.LanguageModelChatMessageRole.User &&
            roleValue !== vscode.LanguageModelChatMessageRole.Assistant;
        if (!systemMessage && isSystem) {
            systemMessage = msg;
        } else {
            remaining.push(msg);
        }
    }

    const selected: vscode.LanguageModelChatRequestMessage[] = [];
    let used = 0;

    // Detect continuation request
    const lastMessage = remaining.length > 0 ? remaining[remaining.length - 1] : undefined;
    const isContinuation =
        lastMessage?.role === (vscode.LanguageModelChatMessageRole.User as unknown as number) &&
        lastMessage.content.length === 1 &&
        lastMessage.content[0] instanceof vscode.LanguageModelTextPart &&
        lastMessage.content[0].value.trim().toLowerCase() === "continue";

    if (systemMessage) {
        const sysTokens = estimateSingleMessageTokens(systemMessage);
        if (sysTokens > budget) {
            throw new Error("Message exceeds token limit.");
        }
        selected.push(systemMessage);
        used += sysTokens;
    }

    for (let i = remaining.length - 1; i >= 0; i--) {
        const msg = remaining[i];
        const msgTokens = estimateSingleMessageTokens(msg);

        // If it's a continuation, we MUST include the immediately preceding assistant message
        // to provide context for where to resume.
        const isProtectedAssistantMessage =
            isContinuation &&
            i === remaining.length - 2 &&
            msg.role === (vscode.LanguageModelChatMessageRole.Assistant as unknown as number);

        if (used + msgTokens <= budget || selected.length === (systemMessage ? 1 : 0) || isProtectedAssistantMessage) {
            selected.splice(systemMessage ? 1 : 0, 0, msg);
            used += msgTokens;
        } else {
            break;
        }
    }

    if (telemetryServiceInstance && selected.length < messageArray.length) {
        telemetryServiceInstance.captureTrimExecuted(model.id, "chat", originalTokens, used, budget);
    }

    return selected;
}

/**
 * Detects whether an error represents a context overflow / max tokens condition.
 */
export function isContextOverflowError(err: unknown): boolean {
    if (!err || typeof err !== "object") {
        return false;
    }

    const errorObj = err as { code?: unknown; message?: unknown; type?: unknown };
    const code = typeof errorObj.code === "string" ? errorObj.code : undefined;
    const message = typeof errorObj.message === "string" ? errorObj.message : undefined;
    const type = typeof errorObj.type === "string" ? errorObj.type : undefined;

    if (code === "context_length_exceeded" || code === "tokens_exceeded") {
        return true;
    }

    if (type === "invalid_request_error" && message && message.toLowerCase().includes("maximum context length")) {
        return true;
    }

    if (message && /maximum context length|context length exceeded/i.test(message)) {
        return true;
    }

    return false;
}

export function trimV2MessagesForBudget(
    messages: readonly V2ChatMessage[],
    tools: { type: string; function: { name: string; description?: string; parameters?: object } }[] | undefined,
    model: vscode.LanguageModelChatInformation,
    modelInfo?: LiteLLMModelInfo,
    hardBudgetOverride?: number
): readonly V2ChatMessage[] {
    const toolTokenCount = estimateToolTokens(tools);
    const tokenLimit = Math.max(1, model.maxInputTokens);
    const budgetLimit =
        hardBudgetOverride !== undefined
            ? Math.max(1, Math.floor(hardBudgetOverride))
            : (() => {
                  const bufferedLimit = Math.max(1, Math.floor(tokenLimit * 0.95));
                  return isAnthropicModel(model.id, modelInfo)
                      ? Math.max(1, Math.floor(bufferedLimit * 0.98))
                      : bufferedLimit;
              })();

    const budget = budgetLimit - toolTokenCount;
    if (budget <= 0) {
        throw new Error("Message exceeds token limit.");
    }

    const messageArray: readonly V2ChatMessage[] = Array.isArray(messages) ? messages : [messages];
    const originalTokens = countTokensForV2Messages(messageArray, model.id, modelInfo);

    const messageHasCacheControl = (msg: V2ChatMessage): boolean =>
        Array.isArray(msg.content) &&
        msg.content.some(
            (part) =>
                part.type === "data" &&
                typeof (part as { mimeType?: string }).mimeType === "string" &&
                isCacheControlMimeType((part as { mimeType: string }).mimeType)
        );

    const cacheSplitIndex = messageArray.findIndex(messageHasCacheControl);
    const hasCacheControlInHistory = cacheSplitIndex !== -1;

    const lastMessage = messageArray.length > 0 ? messageArray[messageArray.length - 1] : undefined;
    const isContinuation =
        lastMessage &&
        (lastMessage.role === (vscode.LanguageModelChatMessageRole.User as unknown as number) ||
            lastMessage.role === "user") &&
        Array.isArray(lastMessage.content) &&
        lastMessage.content.length === 1 &&
        lastMessage.content[0]?.type === "text" &&
        typeof lastMessage.content[0].text === "string" &&
        lastMessage.content[0].text.trim().toLowerCase() === "continue";

    const selected: V2ChatMessage[] = [];
    let used = 0;

    if (hasCacheControlInHistory) {
        // Preserve all messages up to and including the cache boundary as cached (zero-cost)
        const cachedPrefix = messageArray.slice(0, cacheSplitIndex + 1);
        selected.push(...cachedPrefix);

        const tail = messageArray.slice(cacheSplitIndex + 1);
        const tailSelected: V2ChatMessage[] = [];

        for (let i = tail.length - 1; i >= 0; i--) {
            const msg = tail[i];
            const msgTokens = countTokensForV2Messages(msg, model.id, modelInfo);
            const isProtectedAssistantMessage =
                isContinuation &&
                i === tail.length - 2 &&
                (msg.role === (vscode.LanguageModelChatMessageRole.Assistant as unknown as number) ||
                    msg.role === "assistant");

            if (
                used + msgTokens <= budget ||
                (tailSelected.length === 0 && selected.length === cachedPrefix.length) ||
                isProtectedAssistantMessage
            ) {
                tailSelected.unshift(msg);
                used += msgTokens;
            } else if (!isContinuation) {
                break;
            }
        }

        selected.push(...tailSelected);
    } else {
        // No cache boundary: trim from the end, preserving the most recent messages
        for (let i = messageArray.length - 1; i >= 0; i--) {
            const msg = messageArray[i];
            const msgTokens = countTokensForV2Messages(msg, model.id, modelInfo);
            const isProtectedAssistantMessage =
                isContinuation &&
                i === messageArray.length - 2 &&
                (msg.role === (vscode.LanguageModelChatMessageRole.Assistant as unknown as number) ||
                    msg.role === "assistant");

            if (used + msgTokens <= budget || selected.length === 0 || isProtectedAssistantMessage) {
                selected.unshift(msg);
                used += msgTokens;
            } else if (!isContinuation) {
                break;
            }
        }
    }

    const budgetTokens = used;
    if (telemetryServiceInstance && selected.length < messageArray.length) {
        telemetryServiceInstance.captureTrimExecuted(model.id, "v2-chat", originalTokens, budgetTokens, budget);
    }

    if (budgetTokens > budget) {
        throw new Error("Message exceeds token limit.");
    }

    return selected;
}
