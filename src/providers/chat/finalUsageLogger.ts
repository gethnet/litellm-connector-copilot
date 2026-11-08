import { Logger } from "../../utils/logger";

interface FinalUsage {
    tokensIn?: number;
    tokensOut?: number;
    cachedTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningTokens?: number;
    toolTokens?: number;
    acceptedPredictionTokens?: number;
    rejectedPredictionTokens?: number;
    systemPromptTokens?: number;
    reservedOutputTokens?: number;
    totalTokenMax?: number;
    sawUsageDataPart: boolean;
    estimatedInputCost?: number;
    estimatedOutputCost?: number;
    estimatedTotalCost?: number;
}

/** Keep the final usage diagnostic consistent across normal and retry paths. */
export function logFinalUsageEnvelope(requestId: string, modelId: string, caller: string, usage: FinalUsage): void {
    Logger.debug(
        `[TokenUsage][Final] request_id=${requestId} model=${modelId} caller=${caller} ` +
            `tokens_in=${usage.tokensIn ?? "n/a"} tokens_out=${usage.tokensOut ?? "n/a"} ` +
            `cached_tokens=${usage.cachedTokens ?? "n/a"} cache_creation_input_tokens=${
                usage.cacheCreationInputTokens ?? "n/a"
            } ` +
            `reasoning_tokens=${usage.reasoningTokens ?? "n/a"} tool_tokens=${usage.toolTokens ?? "n/a"} ` +
            `accepted_prediction_tokens=${usage.acceptedPredictionTokens ?? "n/a"} rejected_prediction_tokens=${
                usage.rejectedPredictionTokens ?? "n/a"
            } ` +
            `system_prompt_tokens=${usage.systemPromptTokens ?? "n/a"} reserved_output_tokens=${
                usage.reservedOutputTokens ?? "n/a"
            } ` +
            `total_token_max=${usage.totalTokenMax ?? "n/a"} streamed_usage=${usage.sawUsageDataPart} ` +
            `estimated_input_cost=${usage.estimatedInputCost ?? "n/a"} estimated_output_cost=${
                usage.estimatedOutputCost ?? "n/a"
            } estimated_total_cost=${usage.estimatedTotalCost ?? "n/a"}`
    );
}
