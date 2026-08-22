import type { LiteLLMModelInfo, OpenAICacheControl, OpenAIChatMessage, OpenAIChatMessageContentItem } from "../types";

const EPHEMERAL_CACHE_CONTROL: OpenAICacheControl = { type: "ephemeral" };
const MAX_EXPLICIT_CACHE_BREAKPOINTS = 4;

/** Sanitized request-shape data suitable for the transport start event. */
export interface PromptCachePolicySummary {
    supported: boolean;
    path1: boolean;
    explicitCount: number;
}

/**
 * Returns whether a model card accepts Anthropic's OpenAI-compatible
 * `cache_control` parameter. `supports_prompt_caching` is intentionally not
 * considered because it also describes incompatible provider contracts.
 */
export function modelSupportsPromptCacheControl(modelInfo?: LiteLLMModelInfo): boolean {
    return modelInfo?.supported_openai_params?.includes("cache_control") === true;
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
    modelInfo?: LiteLLMModelInfo
): PromptCachePolicySummary {
    const supported = modelSupportsPromptCacheControl(modelInfo);
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
