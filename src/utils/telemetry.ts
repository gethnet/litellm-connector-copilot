import { Logger } from "./logger";
import type { TelemetryService } from "../telemetry/telemetryService";

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
        // Keep structured debug logs for local diagnostics.
        Logger.debug(`[Telemetry] ${JSON.stringify(metric)}`);

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
            } total_token_max=${metric.totalTokenMax ?? "n/a"}`
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
                }) => void;
                captureRequestFailed?: (props: {
                    request_id: string;
                    caller: string;
                    model: string;
                    endpoint: string;
                    durationMs: number;
                    errorType: string;
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
                });
            } else if (metric.status === "failure") {
                telemetryService.captureRequestFailed?.({
                    request_id: metric.requestId,
                    caller,
                    model: metric.model,
                    endpoint: "unknown",
                    durationMs: metric.durationMs ?? 0,
                    errorType: metric.error ?? "unknown",
                });
            } else if (metric.status === "caching_bypassed") {
                telemetryService.captureRequestCachingBypassed?.({
                    request_id: metric.requestId,
                    caller,
                    model: metric.model,
                    endpoint: "unknown",
                    reason: metric.error ?? "provider_caching_not_supported",
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
