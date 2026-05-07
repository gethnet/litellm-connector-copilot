import * as vscode from "vscode";
import type { LiteLLMModelInfo } from "../types";
import { isAnthropicModel } from "../utils/modelUtils";
import { selectTokenizer } from "./tokenizers/selectTokenizer";
import type { V2ChatMessage } from "../providers/v2Types";
import type { TelemetryService } from "../telemetry/telemetryService";
import { isCacheControlMimeType } from "../utils";

export const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
export const DEFAULT_CONTEXT_LENGTH = 128000;

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
    const messageArray = Array.isArray(messages) ? messages : Array.from(messages);
    const userRole = vscode.LanguageModelChatMessageRole.User as unknown as number;
    const assistantRole = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;

    const splitCacheStablePrefix = <T extends { role: unknown }>(input: readonly T[]) => {
        let systemMessage: T | undefined;
        const remaining: T[] = [];

        for (const msg of input) {
            const roleNum = msg.role as unknown as number;
            const isSystem = roleNum !== userRole && roleNum !== assistantRole;
            if (!systemMessage && isSystem) {
                systemMessage = msg;
            } else {
                remaining.push(msg);
            }
        }

        return { systemMessage, remaining };
    };

    const pickLastConversationTurns = <T>(input: readonly T[]) =>
        input.length <= 2 ? [...input] : [...input.slice(-2)];

    const { systemMessage, remaining } = splitCacheStablePrefix(messageArray);
    const anchorTail = pickLastConversationTurns(remaining);
    const anchorSet = new Set(anchorTail);

    /**
     * Build a reverse-lookup map: toolCallId -> index in `remaining` for the assistant message
     * that owns that tool_call. This enables O(1) lookup when a tool result message is
     * selected so we can force-include its paired assistant message.
     *
     * Tool call IDs are stored on the converted OpenAI message as `msg.tool_calls[*].id`.
     * We access them via an indexed property lookup to avoid importing extra types and to
     * remain compatible with both raw vscode messages and partially-converted messages.
     */
    const toolCallIdToAssistantIndex = new Map<string, number>();
    for (let idx = 0; idx < remaining.length; idx++) {
        const msg = remaining[idx];
        const rawMsg = msg as unknown as Record<string, unknown>;
        const toolCalls = rawMsg["tool_calls"];
        const role = msg.role as unknown as number;
        if (
            (role === assistantRole || role === (vscode.LanguageModelChatMessageRole.Assistant as unknown as number)) &&
            Array.isArray(toolCalls)
        ) {
            for (const tc of toolCalls) {
                const call = tc as Record<string, unknown>;
                if (typeof call["id"] === "string") {
                    toolCallIdToAssistantIndex.set(call["id"], idx);
                }
            }
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

        // Tool-pair integrity: when a tool result message is selected (either because it is
        // in the anchor tail or fits within budget), its paired assistant message MUST also
        // be included. We add the paired assistant to the anchorSet here so the later
        // iteration over lower indices will force-include it regardless of token budget.
        //
        // We check for the tool_call_id property on the raw message object because VS Code
        // messages that have been through convertMessages() carry it as a plain property.
        const rawMsg = msg as unknown as Record<string, unknown>;
        const toolCallId = rawMsg["tool_call_id"];
        if (
            (anchorSet.has(msg) || used + msgTokens <= budget) &&
            typeof toolCallId === "string" &&
            toolCallIdToAssistantIndex.has(toolCallId)
        ) {
            // Force the paired assistant message into the anchor set before it is visited.
            const pairedIndex = toolCallIdToAssistantIndex.get(toolCallId)!;
            const pairedMsg = remaining[pairedIndex];
            anchorSet.add(pairedMsg);

            // To be absolutely sure, we ALSO force any tool calls in the anchored assistant
            // into the index if they weren't there already (though they should be).
        }

        if (
            anchorSet.has(msg) ||
            used + msgTokens <= budget ||
            selected.length === (systemMessage ? 1 : 0) ||
            isProtectedAssistantMessage
        ) {
            selected.splice(systemMessage ? 1 : 0, 0, msg);
            used += msgTokens;
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

    const originalTokens = countTokensForV2Messages(messages, model.id, modelInfo);
    const messageArray = Array.isArray(messages) ? messages : Array.from(messages);
    const userRole = vscode.LanguageModelChatMessageRole.User as unknown as number;
    const assistantRole = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;

    const splitCacheStablePrefix = <T extends { role: unknown }>(input: readonly T[]) => {
        let systemMessage: T | undefined;
        const remaining: T[] = [];

        for (const msg of input) {
            const roleNum = msg.role as unknown as number;
            const isSystem = roleNum !== userRole && roleNum !== assistantRole;
            if (!systemMessage && isSystem) {
                systemMessage = msg;
            } else {
                remaining.push(msg);
            }
        }

        return { systemMessage, remaining };
    };

    const pickLastConversationTurns = <T>(input: readonly T[]) =>
        input.length <= 2 ? [...input] : [...input.slice(-2)];

    const { systemMessage, remaining } = splitCacheStablePrefix(messageArray);
    const anchorTail = pickLastConversationTurns(remaining);
    const anchorSet = new Set(anchorTail);

    /**
     * Build a reverse-lookup map: callId -> index in `remaining` for the assistant message
     * (or any message) that contains a tool_call part with that callId. This lets us
     * force-include the paired message when a tool_result part referencing the same callId
     * is selected during trimming.
     *
     * V2 tool_call parts live on assistant messages (or any message with role assistant).
     * V2 tool_result parts live on user messages (or any role) and reference the callId.
     */
    const v2ToolCallIdToMessageIndex = new Map<string, number>();
    for (let idx = 0; idx < remaining.length; idx++) {
        const msg = remaining[idx];
        for (const part of msg.content) {
            if (part.type === "tool_call") {
                v2ToolCallIdToMessageIndex.set(part.callId, idx);
            }
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
            (msg.role === (vscode.LanguageModelChatMessageRole.Assistant as unknown as number) ||
                msg.role === "assistant");
        const mustKeepTailBoundary = anchorSet.has(msg);

        // V2 tool-pair integrity: if the current message contains tool_result parts and is
        // being selected (via anchor or budget fit), force-include the message that owns the
        // matching tool_call part so the conversation remains structurally valid.
        //
        // We iterate ALL tool_result parts in the message because a single message can carry
        // results for multiple parallel tool calls (each with a distinct callId).
        if (mustKeepTailBoundary || used + msgTokens <= budget) {
            for (const part of msg.content) {
                if (part.type === "tool_result" && v2ToolCallIdToMessageIndex.has(part.callId)) {
                    const pairedIndex = v2ToolCallIdToMessageIndex.get(part.callId)!;
                    anchorSet.add(remaining[pairedIndex]);
                }
            }
        }

        if (
            anchorSet.has(msg) ||
            used + msgTokens <= budget ||
            selected.length === (systemMessage ? 1 : 0) ||
            isProtectedAssistantMessage
        ) {
            selected.splice(systemMessage ? 1 : 0, 0, msg);
            used += msgTokens;
        }
    }

    if (telemetryServiceInstance && selected.length < messageArray.length) {
        telemetryServiceInstance.captureTrimExecuted(model.id, "v2-chat", originalTokens, used, budget);
    }

    return selected;
}
