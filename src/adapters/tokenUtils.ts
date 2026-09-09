import * as vscode from "vscode";
import type { LiteLLMModelInfo, OpenAIChatMessage } from "../types";
import { isAnthropicModel } from "../utils/modelUtils";
import { StructuredLogger } from "../observability/structuredLogger";
import { selectTokenizer } from "./tokenizers/selectTokenizer";
import type { TelemetryService } from "../telemetry/telemetryService";

// Token estimation constants for binary media types
// These are conservative estimates to avoid context window overflow

/** Base token cost for any image (OpenAI low-detail equivalent) */
const IMAGE_TOKEN_BASE = 85;

/** Approximate bytes per token for base64-encoded image data */
const IMAGE_BYTES_PER_TOKEN = 750;

/** Conservative bytes-per-token for PDF content (text-equivalent) */
const PDF_BYTES_PER_TOKEN = 4;

/** Minimum token cost for any non-empty PDF (processing overhead) */
const PDF_MINIMUM_TOKENS = 100;

/**
 * Estimates token cost for binary media data (images, PDFs).
 * Uses conservative heuristics to avoid underestimating context usage.
 *
 * @param mimeType - The MIME type of the data
 * @param dataLength - The length of the binary data in bytes
 * @returns Estimated token count for the media content
 */
export function estimateMediaTokenCost(mimeType: string, dataLength: number): number {
    if (dataLength <= 0) {
        return 0;
    }

    // Image types: base cost + scaling by data size
    if (mimeType.startsWith("image/")) {
        return IMAGE_TOKEN_BASE + Math.ceil(dataLength / IMAGE_BYTES_PER_TOKEN);
    }

    // PDF: treat as text-equivalent with minimum overhead
    if (mimeType === "application/pdf") {
        return Math.max(PDF_MINIMUM_TOKENS, Math.ceil(dataLength / PDF_BYTES_PER_TOKEN));
    }

    // Unsupported binary type: return 0 (caller may handle differently)
    return 0;
}

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

    // Fable 5.1 thinking blocks are conversation-prefix-bound: if we removed
    // any earlier messages, all retained thinking_blocks are invalidated and
    // would cause a 400 ("The block is bound to a different conversation") on
    // enforced accounts. Strip thinking_blocks from retained assistant messages
    // (preserve text, tool_calls, tool_results) when front trimming occurred.
    // This is the "keep-tail compaction" shape from the Fable 5.1 migration guide.
    if (selected.length < messageArray.length) {
        const stripped = stripThinkingBlocksFromRetainedMessages(selected);
        if (stripped.didStrip) {
            StructuredLogger.warn("trim.thinking_blocks_stripped", {
                model: model.id,
                originalCount: messageArray.length,
                retainedCount: selected.length,
                reason: "front-trim-invalidates-prefix-bound-thinking",
            });
        }
        return stripped.messages;
    }

    return selected;
}

/**
 * Strips `thinking_blocks` from retained assistant messages when front trimming
 * has removed earlier conversation content. Fable 5.1 thinking blocks are bound
 * to the exact conversation prefix that preceded them; removing any earlier
 * message invalidates every later thinking block and causes a 400 on enforced
 * accounts. Text, tool_calls, and tool_results are preserved.
 *
 * Returns the (possibly modified) message array and a flag indicating whether
 * any stripping occurred, so the caller can log the degradation.
 */
function stripThinkingBlocksFromRetainedMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): {
    messages: readonly vscode.LanguageModelChatRequestMessage[];
    didStrip: boolean;
} {
    let didStrip = false;
    const result = messages.map((message) => {
        const record = message as unknown as { thinking_blocks?: unknown };
        if (Array.isArray(record.thinking_blocks) && record.thinking_blocks.length > 0) {
            didStrip = true;
            // Shallow-copy and delete only the continuity field; all other
            // content (text, tool calls, tool results) stays intact.
            const copy = { ...message } as unknown as Record<string, unknown>;
            delete copy.thinking_blocks;
            return copy as unknown as vscode.LanguageModelChatRequestMessage;
        }
        return message;
    });
    return { messages: result, didStrip };
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
