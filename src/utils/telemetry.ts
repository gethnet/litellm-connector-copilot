import { Logger } from "./logger";

export interface IMetrics {
	requestId: string;
	model: string;
	durationMs?: number;
	tokensIn?: number;
	tokensOut?: number;
	status: "success" | "failure" | "caching_bypassed";
	error?: string;
}

export class LiteLLMTelemetry {
	public static reportMetric(metric: IMetrics): void {
		// Initially log to debug level.
		// This is architected for future external telemetry integration.
		Logger.debug(`[Telemetry] ${JSON.stringify(metric)}`);
	}

	public static startTimer(): number {
		return Date.now();
	}

	public static endTimer(startTime: number): number {
		return Date.now() - startTime;
	}
}
