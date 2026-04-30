import type { LiteLLMResponseUsage, LiteLLMUsagePayload } from "../types";

export interface RawLiteLLMUsage {
    input_tokens?: number;
    input_tokens_details?: {
        cached_tokens?: number;
    };
    output_tokens?: number;
    output_tokens_details?: {
        accepted_prediction_tokens?: number;
        rejected_prediction_tokens?: number;
        reasoning_tokens?: number;
    };
    total_tokens?: number;
}

function clonePromptTokenDetails(
    details: LiteLLMResponseUsage["promptTokensDetails"] | undefined
): LiteLLMUsagePayload["promptTokensDetails"] {
    if (!details || typeof details.cachedTokens !== "number") {
        return {};
    }

    return {
        cachedTokens: details.cachedTokens,
    };
}

function cloneCompletionTokenDetails(
    details: LiteLLMResponseUsage["completionTokensDetails"] | undefined
): LiteLLMUsagePayload["completionTokensDetails"] {
    if (!details) {
        return {};
    }

    const payload: NonNullable<LiteLLMUsagePayload["completionTokensDetails"]> = {};
    if (typeof details.acceptedPredictionTokens === "number") {
        payload.acceptedPredictionTokens = details.acceptedPredictionTokens;
    }
    if (typeof details.rejectedPredictionTokens === "number") {
        payload.rejectedPredictionTokens = details.rejectedPredictionTokens;
    }
    return payload;
}

export function normalizeUsageFromRaw(raw: RawLiteLLMUsage | undefined): LiteLLMResponseUsage | undefined {
    if (!raw) {
        return undefined;
    }

    const completionTokensDetails = {
        acceptedPredictionTokens: raw.output_tokens_details?.accepted_prediction_tokens,
        rejectedPredictionTokens: raw.output_tokens_details?.rejected_prediction_tokens,
    };

    return {
        inputTokens: raw.input_tokens,
        outputTokens: raw.output_tokens,
        totalTokens: raw.total_tokens,
        reasoningTokens: raw.output_tokens_details?.reasoning_tokens,
        promptTokensDetails: raw.input_tokens_details
            ? { cachedTokens: raw.input_tokens_details.cached_tokens }
            : undefined,
        completionTokensDetails,
    };
}

export function createUsagePayload(usage: LiteLLMResponseUsage): LiteLLMUsagePayload {
    const promptTokens = usage.inputTokens;
    const completionTokens = usage.outputTokens;
    const totalTokens =
        usage.totalTokens ??
        (typeof promptTokens === "number" && typeof completionTokens === "number"
            ? promptTokens + completionTokens
            : undefined);
    const reasoningTokens = usage.reasoningTokens ?? 0;

    return {
        kind: "usage",
        promptTokens,
        completionTokens,
        totalTokens,
        reasoningTokens,
        promptTokensDetails: clonePromptTokenDetails(usage.promptTokensDetails),
        completionTokensDetails: cloneCompletionTokenDetails(usage.completionTokensDetails),
    };
}

export function createEstimatedUsagePayload(promptTokens: number, completionTokens: number): LiteLLMUsagePayload {
    return {
        kind: "usage",
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        reasoningTokens: 0,
        promptTokensDetails: {},
        completionTokensDetails: {},
    };
}
