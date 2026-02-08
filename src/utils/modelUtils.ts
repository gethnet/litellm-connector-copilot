import type { LiteLLMModelInfo } from "../types";

/**
 * Determine whether a model is an Anthropic/Claude model (provider or ID match).
 * These models often have specific constraints (e.g., no 'no-cache' support).
 */
export function isAnthropicModel(modelId: string, modelInfo?: LiteLLMModelInfo): boolean {
    if (modelInfo?.litellm_provider && /anthropic/i.test(modelInfo.litellm_provider)) {
        return true;
    }
    return /claude/i.test(modelId) || /anthropic/i.test(modelId);
}
