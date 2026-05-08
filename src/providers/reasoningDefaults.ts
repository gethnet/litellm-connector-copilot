/**
 * Hardcoded reasoning-effort defaults for reasoning-capable models.
 *
 * PHASE 1 (current): single hardcoded constant. This is a deliberate test-fix
 * to validate that injecting `reasoning_effort` resolves empty-response and
 * no-work failures observed on gpt-5.1-codex-max and gpt-5.3-codex.
 *
 * PHASE 3 (planned): replace REASONING_EFFORT_DEFAULT with a lookup against
 * `LiteLLMConfig.reasoningEffortDefaults` (per-model map + global fallback).
 * All call sites in providers should use `resolveReasoningEffort()` so the
 * Phase 3 swap is contained to this file.
 *
 * Invariants:
 * - Returns undefined for non-reasoning models (do NOT send the field).
 * - Caller override (modelOptions.reasoning_effort) takes precedence.
 * - Result is always clamped to the model's reported supportedEfforts (if known).
 */

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/** Single source of truth for the hardcoded default. Phase 3 replaces this. */
export const REASONING_EFFORT_DEFAULT: ReasoningEffort = "medium";

const EFFORT_RANK: Record<ReasoningEffort, number> = {
    minimal: 0,
    low: 1,
    medium: 2,
    high: 3,
};

const VALID_EFFORTS: ReadonlySet<string> = new Set(["minimal", "low", "medium", "high"]);

function isReasoningEffort(value: unknown): value is ReasoningEffort {
    return typeof value === "string" && VALID_EFFORTS.has(value);
}

export interface ResolveReasoningEffortInput {
    /** Model id (used for diagnostics; behavior keys off the other fields). */
    modelId: string;
    /** Whether the model supports reasoning at all. From ModelFeatureCapabilities. */
    supportsReasoning: boolean;
    /**
     * Subset of efforts the model accepts. When undefined we assume the full set is supported.
     * From ModelFeatureCapabilities.supportedReasoningEfforts.
     */
    supportedEfforts: readonly ReasoningEffort[] | undefined;
    /** Caller-supplied override from request modelOptions. Untyped intentionally. */
    callerOverride: unknown;
}

/**
 * Resolves the effective reasoning_effort to send for a request.
 * Returns undefined if the field should be omitted.
 */
export function resolveReasoningEffort(input: ResolveReasoningEffortInput): ReasoningEffort | undefined {
    if (!input.supportsReasoning) {
        return undefined;
    }

    const requested: ReasoningEffort = isReasoningEffort(input.callerOverride)
        ? input.callerOverride
        : REASONING_EFFORT_DEFAULT;

    return clampToSupported(requested, input.supportedEfforts);
}

/**
 * Returns the closest allowed effort. Prefers the higher tier on ties so the
 * model has at least the budget the caller (or default) asked for.
 */
function clampToSupported(
    requested: ReasoningEffort,
    supported: readonly ReasoningEffort[] | undefined
): ReasoningEffort {
    if (!supported || supported.length === 0) {
        return requested;
    }
    if (supported.includes(requested)) {
        return requested;
    }

    const targetRank = EFFORT_RANK[requested];
    let best: ReasoningEffort = supported[0];
    let bestDistance = Math.abs(EFFORT_RANK[best] - targetRank);

    for (const candidate of supported) {
        const distance = Math.abs(EFFORT_RANK[candidate] - targetRank);
        if (distance < bestDistance || (distance === bestDistance && EFFORT_RANK[candidate] > EFFORT_RANK[best])) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
}
