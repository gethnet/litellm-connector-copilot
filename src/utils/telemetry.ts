import { Logger } from "./logger";
import type { TelemetryService } from "../telemetry/telemetryService";
import type { TelemetryEvent } from "../telemetry/types";

export interface IMetrics {
    requestId: string;
    model: string;
    durationMs?: number;
    tokensIn?: number;
    tokensOut?: number;
    cacheReadRatio?: number;
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
        // Initially log to debug level.
        // This is architected for future external telemetry integration.
        Logger.debug(`[Telemetry] ${JSON.stringify(metric)}`);

        if (this._telemetryService) {
            const properties: TelemetryEvent["properties"] = {
                request_id: metric.requestId,
                caller: metric.caller ?? "unknown",
                model: metric.model,
                endpoint: "unknown",
                durationMs: metric.durationMs ?? 0,
                tokensIn: metric.tokensIn ?? 0,
                tokensOut: metric.tokensOut ?? 0,
                status: metric.status,
                error: metric.error,
            };
            if (metric.cacheReadRatio !== undefined) {
                properties.cache_read_ratio = metric.cacheReadRatio;
            }

            const event: TelemetryEvent = {
                event: "request_completed",
                properties,
                timestamp: new Date(),
            };

            // Emit the generic capture event for compatibility with existing listeners.
            (this._telemetryService as unknown as { capture?: (telemetryEvent: TelemetryEvent) => void }).capture?.(
                event
            );

            if (metric.status === "success") {
                this._telemetryService.captureRequestCompletedWithCache({
                    request_id: metric.requestId,
                    caller: metric.caller ?? "unknown",
                    model: metric.model,
                    endpoint: "unknown", // endpoint not available in IMetrics
                    durationMs: metric.durationMs ?? 0,
                    tokensIn: metric.tokensIn ?? 0,
                    tokensOut: metric.tokensOut ?? 0,
                    cacheReadRatio: metric.cacheReadRatio,
                });
            } else if (metric.status === "failure") {
                this._telemetryService.captureRequestFailed({
                    request_id: metric.requestId,
                    caller: metric.caller ?? "unknown",
                    model: metric.model,
                    endpoint: "unknown",
                    durationMs: metric.durationMs ?? 0,
                    errorType: metric.error ?? "unknown",
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
