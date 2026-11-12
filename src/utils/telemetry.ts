import { Logger } from "./logger";
import type { TelemetryService } from "../telemetry/telemetryService";
import type { CostSummary } from "../telemetry/types";
import { safeUsageNumber } from "./safeUsageNumber";

// Only connector-owned constants may cross the telemetry boundary. Never infer
// safety from a prefix: upstream messages can mimic category names.
const SAFE_FAILURE_CATEGORIES = new Set([
    "request_failed",
    "network_error",
    "timeout",
    "abnormal_termination:refusal",
    "abnormal_termination:truncated",
    "abnormal_termination:failed",
    "abnormal_termination:no_terminal_event",
    "abnormal_termination:empty_response",
    "abnormal_termination:ok",
    "quota_exceeded:insert_edit_into_file",
    "quota_exceeded:replace_string_in_file",
]);

export interface IMetrics {
    requestId: string;
    model: string;
    durationMs?: number;
    tokensIn?: number;
    tokensOut?: number;
    cacheReadRatio?: number;
    promptCacheTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningTokens?: number;
    toolTokens?: number;
    acceptedPredictionTokens?: number;
    rejectedPredictionTokens?: number;
    reservedOutputTokens?: number;
    totalTokenMax?: number;
    estimatedInputCost?: number;
    estimatedOutputCost?: number;
    estimatedTotalCost?: number;
    status: "success" | "failure" | "caching_bypassed";
    error?: string;
    caller?: string;
}

export class LiteLLMTelemetry {
    private static _telemetryService?: TelemetryService;

    public static setTelemetryService(service: TelemetryService): void {
        this._telemetryService = service;
    }

    public static reportMetric(metric: IMetrics): void {
        // Runtime values can originate in untrusted upstream usage despite static types.
        // Normalize a copy so neither legacy diagnostics nor telemetry sees them.
        metric = {
            ...metric,
            durationMs: safeUsageNumber(metric.durationMs),
            tokensIn: safeUsageNumber(metric.tokensIn),
            tokensOut: safeUsageNumber(metric.tokensOut),
            cacheReadRatio: safeUsageNumber(metric.cacheReadRatio),
            promptCacheTokens: safeUsageNumber(metric.promptCacheTokens),
            cacheCreationInputTokens: safeUsageNumber(metric.cacheCreationInputTokens),
            reasoningTokens: safeUsageNumber(metric.reasoningTokens),
            toolTokens: safeUsageNumber(metric.toolTokens),
            acceptedPredictionTokens: safeUsageNumber(metric.acceptedPredictionTokens),
            rejectedPredictionTokens: safeUsageNumber(metric.rejectedPredictionTokens),
            reservedOutputTokens: safeUsageNumber(metric.reservedOutputTokens),
            totalTokenMax: safeUsageNumber(metric.totalTokenMax),
            estimatedInputCost: safeUsageNumber(metric.estimatedInputCost),
            estimatedOutputCost: safeUsageNumber(metric.estimatedOutputCost),
            estimatedTotalCost: safeUsageNumber(metric.estimatedTotalCost),
        };
        if (metric.cacheReadRatio !== undefined && metric.cacheReadRatio > 1) {
            metric.cacheReadRatio = undefined;
        }
        // Keep structured debug logs for local diagnostics.
        // Error strings can contain arbitrary upstream echoes, including secrets.
        const { error: _error, ...safeMetric } = metric;
        Logger.debug(`[Telemetry] ${JSON.stringify(safeMetric)}`);

        // Mirror token usage into the regular output stream to make token accounting
        // visible without requiring debug log level.
        Logger.info(
            `[TokenUsage] request_id=${metric.requestId} caller=${metric.caller ?? "unknown"} model=${
                metric.model
            } status=${metric.status} duration_ms=${metric.durationMs ?? 0} tokens_in=${metric.tokensIn ?? 0} tokens_out=${
                metric.tokensOut ?? 0
            } cache_read_ratio=${metric.cacheReadRatio ?? "n/a"} prompt_cache_tokens=${
                metric.promptCacheTokens ?? "n/a"
            } cache_creation_input_tokens=${metric.cacheCreationInputTokens ?? "n/a"} reasoning_tokens=${
                metric.reasoningTokens ?? "n/a"
            } tool_tokens=${metric.toolTokens ?? "n/a"} accepted_prediction_tokens=${
                metric.acceptedPredictionTokens ?? "n/a"
            } rejected_prediction_tokens=${metric.rejectedPredictionTokens ?? "n/a"} token_count_max=${
                metric.reservedOutputTokens ?? "n/a"
            } total_token_max=${metric.totalTokenMax ?? "n/a"} estimated_input_cost=${
                metric.estimatedInputCost ?? "n/a"
            } estimated_output_cost=${metric.estimatedOutputCost ?? "n/a"} estimated_total_cost=${
                metric.estimatedTotalCost ?? "n/a"
            }`
        );

        if (this._telemetryService) {
            const caller = metric.caller ?? "unknown";
            const telemetryService = this._telemetryService as unknown as {
                captureRequestCompletedWithCache?: (props: {
                    request_id: string;
                    caller: string;
                    model: string;
                    endpoint: string;
                    durationMs: number;
                    tokensIn: number;
                    tokensOut: number;
                    cacheReadRatio?: number;
                    cost?: CostSummary;
                }) => void;
                captureRequestFailed?: (props: {
                    request_id: string;
                    caller: string;
                    model: string;
                    endpoint: string;
                    durationMs: number;
                    errorType: string;
                    cost?: CostSummary;
                }) => void;
                captureRequestCachingBypassed?: (props: {
                    request_id: string;
                    caller: string;
                    model: string;
                    endpoint: string;
                    reason?: string;
                }) => void;
            };

            if (metric.status === "success") {
                telemetryService.captureRequestCompletedWithCache?.({
                    request_id: metric.requestId,
                    caller,
                    model: metric.model,
                    endpoint: "unknown", // endpoint not available in IMetrics
                    durationMs: metric.durationMs ?? 0,
                    tokensIn: metric.tokensIn ?? 0,
                    tokensOut: metric.tokensOut ?? 0,
                    cacheReadRatio: metric.cacheReadRatio,
                    cost: {
                        estimated_input_cost: metric.estimatedInputCost,
                        estimated_output_cost: metric.estimatedOutputCost,
                        estimated_total_cost: metric.estimatedTotalCost,
                    },
                });
            } else if (metric.status === "failure") {
                telemetryService.captureRequestFailed?.({
                    request_id: metric.requestId,
                    caller,
                    model: metric.model,
                    endpoint: "unknown",
                    durationMs: metric.durationMs ?? 0,
                    errorType:
                        metric.error && SAFE_FAILURE_CATEGORIES.has(metric.error) ? metric.error : "request_failed",
                    cost: {
                        estimated_input_cost: metric.estimatedInputCost,
                        estimated_output_cost: metric.estimatedOutputCost,
                        estimated_total_cost: metric.estimatedTotalCost,
                    },
                });
            } else if (metric.status === "caching_bypassed") {
                telemetryService.captureRequestCachingBypassed?.({
                    request_id: metric.requestId,
                    caller,
                    model: metric.model,
                    endpoint: "unknown",
                    reason: "provider_caching_not_supported",
                });
            }
        }
    }

    public static startTimer(): number {
        return Date.now();
    }

    public static endTimer(startTime: number): number {
        return Date.now() - startTime;
    }
}
