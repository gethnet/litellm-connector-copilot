import type { LiteLLMModelInfo } from "../types";
import { countTokens } from "../adapters/tokenUtils";
import { deriveCapabilitiesFromModelInfo } from "./modelCapabilities";

export interface DiffBreadth {
    files: number;
    hunks: number;
}
export interface DiffBudgetInput {
    maxInputTokens: number;
    outputReserve: number;
    staticPrompts: readonly string[];
    modelId: string;
    modelInfo?: LiteLLMModelInfo;
}

export const MIN_OUTPUT_RESERVE_TOKENS = 1000;
export const MAX_OUTPUT_RESERVE_TOKENS = 8000;
export const OUTPUT_RESERVE_BASE_TOKENS = 1000;
export const OUTPUT_RESERVE_PER_FILE_TOKENS = 400;
export const OUTPUT_RESERVE_PER_HUNK_TOKENS = 40;
export const DIFF_BUDGET_SAFETY_RATIO = 0.9;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function countDiffBreadth(diff: string): DiffBreadth {
    let gitHeaders = 0;
    let plusHeaders = 0;
    let hunks = 0;
    for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ")) {
            gitHeaders++;
        } else if (line.startsWith("+++ ")) {
            plusHeaders++;
        } else if (line.startsWith("@@ ")) {
            hunks++;
        }
    }
    return { files: gitHeaders > 0 ? gitHeaders : plusHeaders, hunks };
}

export function computeOutputReserve(breadth: DiffBreadth, override?: number): number {
    if (override !== undefined && Number.isFinite(override) && override > 0) {
        return clamp(Math.floor(override), MIN_OUTPUT_RESERVE_TOKENS, MAX_OUTPUT_RESERVE_TOKENS);
    }
    return clamp(
        OUTPUT_RESERVE_BASE_TOKENS +
            OUTPUT_RESERVE_PER_FILE_TOKENS * breadth.files +
            OUTPUT_RESERVE_PER_HUNK_TOKENS * breadth.hunks,
        MIN_OUTPUT_RESERVE_TOKENS,
        MAX_OUTPUT_RESERVE_TOKENS
    );
}

export function computeDiffBudget(input: DiffBudgetInput): number {
    const staticTokens = input.staticPrompts.reduce(
        (total, prompt) => total + countTokens(prompt, input.modelId, input.modelInfo),
        0
    );
    return Math.max(
        0,
        Math.floor((input.maxInputTokens - input.outputReserve - staticTokens) * DIFF_BUDGET_SAFETY_RATIO)
    );
}

export function resolveCommitContextWindow(
    reportedMaxInputTokens: number | undefined,
    modelId: string,
    modelInfo: LiteLLMModelInfo | undefined
): number {
    if (
        typeof reportedMaxInputTokens === "number" &&
        Number.isFinite(reportedMaxInputTokens) &&
        reportedMaxInputTokens > 0
    ) {
        return Math.floor(reportedMaxInputTokens);
    }
    return deriveCapabilitiesFromModelInfo(modelId, modelInfo).maxInputTokens;
}
