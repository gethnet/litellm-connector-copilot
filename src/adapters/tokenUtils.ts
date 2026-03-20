import * as vscode from "vscode";
import type { LiteLLMModelInfo } from "../types";
import { isAnthropicModel } from "../utils/modelUtils";
import { selectTokenizer } from "./tokenizers/selectTokenizer";
import type { V2ChatMessage } from "../providers/v2Types";

export const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
export const DEFAULT_CONTEXT_LENGTH = 128000;

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

export function countTokensForV2Messages(
    input: string | V2ChatMessage | readonly V2ChatMessage[],
    modelId?: string,
    modelInfo?: LiteLLMModelInfo
): number {
    if (typeof input === "string") {
        return countTokens(input, modelId, modelInfo);
    }

    const messages = Array.isArray(input) ? input : [input];
    let total = 0;
    for (const message of messages) {
        for (const part of message.content) {
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
                    if (
                        part.mimeType.startsWith("text/") ||
                        part.mimeType.includes("json") ||
                        part.mimeType === "cache_control"
                    ) {
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
    modelInfo?: LiteLLMModelInfo
): readonly vscode.LanguageModelChatRequestMessage[] {
    const toolTokenCount = estimateToolTokens(tools);
    const tokenLimit = Math.max(1, model.maxInputTokens);
    // Apply a flat safety buffer to avoid context overflow due to tokenizer variance,
    // provider-side framing, and other hidden tokens.
    //
    // This is intentionally applied to *all* models (not just Anthropic) because
    // overflow failures are catastrophic and the 5% reduction is a small tradeoff.
    const bufferedLimit = Math.max(1, Math.floor(tokenLimit * 0.95));

    // Keep an additional small margin for Anthropic-style models which tend to be
    // stricter about context limits.
    const safetyLimit = isAnthropicModel(model.id, modelInfo)
        ? Math.max(1, Math.floor(bufferedLimit * 0.98))
        : bufferedLimit;
    const budget = safetyLimit - toolTokenCount;
    if (budget <= 0) {
        throw new Error("Message exceeds token limit.");
    }

    let systemMessage: vscode.LanguageModelChatRequestMessage | undefined;
    const remaining: vscode.LanguageModelChatRequestMessage[] = [];
    const userRole = vscode.LanguageModelChatMessageRole.User as unknown as number;
    const assistantRole = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
    const messageArray = Array.isArray(messages) ? messages : Array.from(messages);
    for (const msg of messageArray) {
        const roleNum = msg.role as unknown as number;
        const isSystem = roleNum !== userRole && roleNum !== assistantRole;
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

    return selected;
}

export function trimV2MessagesForBudget(
    messages: readonly V2ChatMessage[],
    tools: { type: string; function: { name: string; description?: string; parameters?: object } }[] | undefined,
    model: vscode.LanguageModelChatInformation,
    modelInfo?: LiteLLMModelInfo
): readonly V2ChatMessage[] {
    const toolTokenCount = estimateToolTokens(tools);
    const tokenLimit = Math.max(1, model.maxInputTokens);
    const bufferedLimit = Math.max(1, Math.floor(tokenLimit * 0.95));
    const safetyLimit = isAnthropicModel(model.id, modelInfo)
        ? Math.max(1, Math.floor(bufferedLimit * 0.98))
        : bufferedLimit;
    const budget = safetyLimit - toolTokenCount;
    if (budget <= 0) {
        throw new Error("Message exceeds token limit.");
    }

    let systemMessage: V2ChatMessage | undefined;
    const remaining: V2ChatMessage[] = [];
    const userRole = vscode.LanguageModelChatMessageRole.User as unknown as number;
    const assistantRole = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
    const messageArray = Array.isArray(messages) ? messages : Array.from(messages);
    for (const msg of messageArray) {
        const roleNum = msg.role as unknown as number;
        const isSystem = roleNum !== userRole && roleNum !== assistantRole;
        if (!systemMessage && isSystem) {
            systemMessage = msg;
        } else {
            remaining.push(msg);
        }
    }

    const selected: V2ChatMessage[] = [];
    let used = 0;

    const lastMessage = remaining.length > 0 ? remaining[remaining.length - 1] : undefined;
    const isContinuation =
        lastMessage?.role === (vscode.LanguageModelChatMessageRole.User as unknown as number) &&
        lastMessage.content.length === 1 &&
        lastMessage.content[0]?.type === "text" &&
        lastMessage.content[0].text.trim().toLowerCase() === "continue";

    if (systemMessage) {
        const sysTokens = countTokensForV2Messages(systemMessage, model.id, modelInfo);
        if (sysTokens > budget) {
            throw new Error("Message exceeds token limit.");
        }
        selected.push(systemMessage);
        used += sysTokens;
    }

    for (let i = remaining.length - 1; i >= 0; i--) {
        const msg = remaining[i];
        const msgTokens = countTokensForV2Messages(msg, model.id, modelInfo);
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

    return selected;
}
