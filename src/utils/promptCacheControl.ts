import type { LiteLLMModelInfo, OpenAICacheControl, OpenAIChatMessage, OpenAIChatMessageContentItem } from "../types";
import { isAnthropicModel } from "./modelUtils";

const EPHEMERAL_CACHE_CONTROL: OpenAICacheControl = { type: "ephemeral" };
const MAX_EXPLICIT_CACHE_BREAKPOINTS = 4;

/** Sanitized request-shape data suitable for the transport start event. */
export interface PromptCachePolicySummary {
    supported: boolean;
    path1: boolean;
    explicitCount: number;
}

/**
 * Returns whether this request may carry Anthropic Path 1 `cache_control`.
 *
 * Both checks are required:
 * - the card must list `cache_control` in `supported_openai_params`
 * - the model must be Anthropic/Claude (`isAnthropicModel`)
 *
 * `supports_prompt_caching` and OpenAI's `prompt_cache_key` are intentionally
 * ignored: they describe incompatible contracts. A GPT card that falsely
 * advertises `cache_control` must stay unstamped.
 */
export function modelSupportsPromptCacheControl(modelId: string, modelInfo?: LiteLLMModelInfo): boolean {
    return (
        modelInfo?.supported_openai_params?.includes("cache_control") === true && isAnthropicModel(modelId, modelInfo)
    );
}

/**
 * Adds a host-requested explicit breakpoint to the final eligible content
 * block. The converter calls this only after it sees a cache-marker DataPart;
 * no automatic content breakpoints are ever invented here.
 */
export function applyEphemeralCacheControl(content: OpenAIChatMessageContentItem[]): boolean {
    for (let index = content.length - 1; index >= 0; index--) {
        const item = content[index];
        if (item.type === "text" || item.type === "image_url") {
            item.cache_control = { ...EPHEMERAL_CACHE_CONTROL };
            return true;
        }
    }
    return false;
}

/** Counts explicit message-content cache breakpoints in message order. */
export function countCacheBreakpoints(messages: readonly OpenAIChatMessage[]): number {
    return messages.reduce(
        (count, message) =>
            count +
            (Array.isArray(message.content)
                ? message.content.filter((content) => content.cache_control !== undefined).length
                : 0),
        0
    );
}

/** Removes all explicit content breakpoints without modifying prompt text. */
export function stripCacheBreakpoints(messages: readonly OpenAIChatMessage[]): void {
    for (const message of messages) {
        if (!Array.isArray(message.content)) {
            continue;
        }
        for (const content of message.content) {
            delete content.cache_control;
        }
    }
}

/**
 * Applies the cache-control contract after message conversion. Eligible cards
 * receive Path 1 unless all four explicit host breakpoints are occupied. An
 * ineligible card is completely unstamped to avoid cross-provider leakage.
 */
export function applyPromptCachePolicy(
    messages: OpenAIChatMessage[],
    modelId: string,
    modelInfo?: LiteLLMModelInfo
): PromptCachePolicySummary {
    const supported = modelSupportsPromptCacheControl(modelId, modelInfo);
    if (!supported) {
        stripCacheBreakpoints(messages);
        return { supported: false, path1: false, explicitCount: 0 };
    }

    let retained = 0;
    for (const message of messages) {
        if (!Array.isArray(message.content)) {
            continue;
        }
        for (const content of message.content) {
            if (!content.cache_control) {
                continue;
            }
            if (retained >= MAX_EXPLICIT_CACHE_BREAKPOINTS) {
                delete content.cache_control;
                continue;
            }
            retained++;
        }
    }

    return {
        supported: true,
        path1: retained < MAX_EXPLICIT_CACHE_BREAKPOINTS,
        explicitCount: retained,
    };
}
