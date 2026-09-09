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

/**
 * Matches the Claude Fable 5.1 / Mythos 5.1 generation exactly, across every
 * LiteLLM id shape: bare (`claude-fable-5-1`), provider-prefixed
 * (`anthropic/claude-fable-5-1`), date-suffixed or @-versioned snapshots
 * (`claude-fable-5-1-20260801`, `claude-fable-5-1@20260801`), and Bedrock
 * dot-namespaced / regional forms (`anthropic.claude-fable-5-1-v1:0`,
 * `us.anthropic.claude-fable-5-1-v1:0`).
 *
 * Boundaries accept `/` and `.` before the family name and `-`, `_`, `.`, or
 * `@` after the version, so snapshot/alias suffixes stay attached while
 * adjacent families stay excluded: base `claude-fable-5` keeps forced
 * tool_choice, and a hypothetical `claude-fable-5-10` is NOT the 5.1
 * generation. The separator between 5 and 1 is deliberately optional, so
 * stripped-separator lookalikes (`claude-fable-51`) match conservatively —
 * the cost of a false positive is only the soft downgrade, while a missed
 * real alias would hard-fail with a 400.
 *
 * Single source of truth for every Fable 5.1 guard (forced-tool_choice
 * downgrade in requestBuilder, sampling-param denylist in
 * parameterFiltering, mock-backend rejection emulation) so the guards can
 * never drift apart — see the parity test in parameterValidation.test.ts.
 */
const FABLE_51_FAMILY_PATTERN = /(?:^|[/.])claude[-_.]?(?:fable|mythos)[-_.]?5[-_.]?1(?=[-_.@]|$)/i;

/** True when `modelId` belongs to the Claude Fable 5.1 / Mythos 5.1 family. */
export function isFable51Family(modelId: string): boolean {
    return FABLE_51_FAMILY_PATTERN.test(modelId);
}
