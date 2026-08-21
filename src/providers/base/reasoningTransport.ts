import type { ChatReasoningTransportFields, LiteLLMModelInfo } from "../../types";

export type ParameterSupport = (
    parameter: string,
    modelInfo: LiteLLMModelInfo | undefined,
    modelId?: string
) => boolean;

const CONFIRMED_ADAPTIVE_CLAUDE_FAMILIES: readonly RegExp[] = [
    /(?:^|\/)claude[-_.]?opus[-_.]?(?:4[-_.]?8|[5-9]|[1-9]\d+)(?:[-_.]|$)/i,
    /(?:^|\/)claude[-_.]?sonnet[-_.]?(?:[5-9]|[1-9]\d+)(?:[-_.]|$)/i,
    /(?:^|\/)claude[-_.]?fable[-_.]?(?:[5-9]|[1-9]\d+)(?:[-_.]|$)/i,
];

function isConfirmedAdaptiveClaudeFamily(modelId: string): boolean {
    return CONFIRMED_ADAPTIVE_CLAUDE_FAMILIES.some((pattern) => pattern.test(modelId));
}

function shouldUseAdaptiveThinking(
    modelId: string,
    modelInfo: LiteLLMModelInfo | undefined,
    supportsParameter: ParameterSupport
): boolean {
    if (!supportsParameter("thinking", modelInfo, modelId)) {
        return false;
    }

    return modelInfo?.supports_adaptive_thinking === true || isConfirmedAdaptiveClaudeFamily(modelId);
}

/**
 * Resolves transport-only reasoning fields for a chat-shaped LiteLLM request.
 * Flat `reasoning_effort` remains the compatibility baseline for Grok/GPT and
 * for picker `none`. Native adaptive fields require advertised `thinking`
 * support and an explicit capability or a confirmed affected Claude family.
 *
 * When adaptive extras are emitted, omit `reasoning_effort`. LiteLLM's
 * Anthropic mapper overwrites `thinking` with `{ type: "adaptive" }` and
 * drops `display`. `display: "summarized"` is required so newer Claude
 * returns thinking text / `reasoning_tokens` instead of omitted blocks.
 */
export function resolveChatReasoningTransport(
    effort: string | undefined,
    modelId: string,
    modelInfo: LiteLLMModelInfo | undefined,
    supportsParameter: ParameterSupport
): ChatReasoningTransportFields {
    if (!effort) {
        return {};
    }

    if (effort !== "none" && shouldUseAdaptiveThinking(modelId, modelInfo, supportsParameter)) {
        return {
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort },
        };
    }

    return supportsParameter("reasoning_effort", modelInfo, modelId) ? { reasoning_effort: effort } : {};
}
