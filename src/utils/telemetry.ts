import { Logger } from "./logger";
import type { TelemetryService } from "../telemetry/telemetryService";

export interface IMetrics {
    requestId: string;
    model: string;
    durationMs?: number;
    tokensIn?: number;
    tokensOut?: number;
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
            /* if (metric.status === "success") {
                this._telemetryService.captureRequestCompleted({
                    caller: metric.caller ?? "unknown",
                    model: metric.model,
                    endpoint: "unknown", // endpoint not available in IMetrics
                    durationMs: metric.durationMs ?? 0,
                    tokensIn: metric.tokensIn ?? 0,
                    tokensOut: metric.tokensOut ?? 0,
                });
            } else */
            if (metric.status === "failure") {
                this._telemetryService.captureRequestFailed({
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
