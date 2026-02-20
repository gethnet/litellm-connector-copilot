import { Logger } from "./logger";
import { PostHog } from "posthog-node";
import * as crypto from "crypto";
import {
    EVENTS,
    FEATURE_FLAGS,
    TELEMETRY_WARN_SAMPLE_INTERVAL_MS,
    TELEMETRY_WARN_SAMPLE_THRESHOLD,
} from "./telemetry.constants";

export interface ITelemetryEvent {
    name: string;
    properties: Record<string, unknown>;
    timestamp?: Date;
}

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

export interface ITelemetryBackend {
    emit(event: ITelemetryEvent): Promise<void>;
    shutdown(): Promise<void>;
}

export class PostHogBackend implements ITelemetryBackend {
    private client: PostHog;
    private distinctId: string;

    constructor(apiKey: string, host: string, distinctId: string) {
        this.client = new PostHog(apiKey, { host });
        this.distinctId = distinctId;
    }

    public async emit(event: ITelemetryEvent): Promise<void> {
        // Redact workspace paths from all properties
        const sanitizedProperties = this.sanitize(event.properties);

        this.client.capture({
            distinctId: this.distinctId,
            event: event.name,
            properties: sanitizedProperties,
            timestamp: event.timestamp || new Date(),
        });
    }

    public async shutdown(): Promise<void> {
        await this.client.shutdown();
    }

    private sanitize(properties: Record<string, unknown>): Record<string, unknown> {
        const sanitized = { ...properties };
        for (const key in sanitized) {
            const value = sanitized[key];
            if (typeof value === "string") {
                // Basic path redaction - replace absolute paths with [REDACTED]
                // This is a simple heuristic, can be improved
                sanitized[key] = value.replace(/\/[a-zA-Z0-9._\-/]+/g, (match: string) => {
                    if (match.includes("/workspaces/") || match.includes("/Users/") || match.includes("/home/")) {
                        return "[REDACTED_PATH]";
                    }
                    return match;
                });
            }
        }
        return sanitized;
    }
}

export class BatchingBackend implements ITelemetryBackend {
    private events: ITelemetryEvent[] = [];
    private timer: NodeJS.Timeout | undefined;
    private readonly BATCH_THRESHOLD = 50;
    private readonly FLUSH_INTERVAL_MS = 2000;

    constructor(private readonly inner: ITelemetryBackend) {}

    public async emit(event: ITelemetryEvent): Promise<void> {
        this.events.push(event);
        if (this.events.length >= this.BATCH_THRESHOLD) {
            void this.flush();
        } else if (!this.timer) {
            this.timer = setTimeout(() => {
                void this.flush();
            }, this.FLUSH_INTERVAL_MS);
        }
    }

    public async shutdown(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        await this.flush();
        await this.inner.shutdown();
    }

    private async flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        if (this.events.length === 0) {
            return;
        }

        const batch = [...this.events];
        this.events = [];
        await Promise.all(batch.map((e) => this.inner.emit(e)));
    }
}

export class LiteLLMTelemetry {
    private static backend?: ITelemetryBackend;
    private static warnCounts = new Map<string, { count: number; lastSent: number }>();

    public static initialize(backend: ITelemetryBackend): void {
        this.backend = backend;
    }

    public static async shutdown(): Promise<void> {
        if (this.backend) {
            await this.backend.shutdown();
        }
    }

    public static reportEvent(name: string, properties: Record<string, unknown> = {}): void {
        if (name === "logger.warn") {
            const message = properties.message;
            if (typeof message === "string" && !this.shouldSampleWarn(message)) {
                return;
            }
        }

        if (!this.backend) {
            // Keep synchronous for tests
            Logger.debug(`[Telemetry-Mock] ${name}: ${JSON.stringify(properties)}`);
        } else {
            // If it's a BatchingBackend, it might be async, but we don't want to break the fire-and-forget nature
            void this.backend.emit({ name, properties });
        }
    }

    private static shouldSampleWarn(message: string): boolean {
        const now = Date.now();
        const state = this.warnCounts.get(message) || { count: 0, lastSent: 0 };

        state.count++;
        if (state.count === 1) {
            state.lastSent = now;
            this.warnCounts.set(message, state);
            return true;
        }

        if (
            state.count % TELEMETRY_WARN_SAMPLE_THRESHOLD === 0 ||
            now - state.lastSent > TELEMETRY_WARN_SAMPLE_INTERVAL_MS
        ) {
            state.lastSent = now;
            this.warnCounts.set(message, state);
            return true;
        }

        this.warnCounts.set(message, state);
        return false;
    }

    public static reportMetric(metric: IMetrics): void {
        // Maintain legacy logging for tests
        Logger.debug(`[Telemetry] ${JSON.stringify(metric)}`);

        // Map legacy reportMetric to request.completed event
        this.reportEvent(EVENTS.REQUEST_COMPLETED, {
            ...metric,
            [FEATURE_FLAGS.USED_CHAT_API]: metric.caller !== "inline-completions",
            [FEATURE_FLAGS.USED_INLINE_COMPLETIONS]: metric.caller === "inline-completions",
        });
    }

    public static reportError(error: unknown, context: Record<string, unknown> = {}): void {
        const err = error as Error | undefined;
        const errorType = err?.name || err?.constructor?.name || "UnknownError";

        // Emit sanitized error to telemetry
        this.reportEvent(EVENTS.ERROR_CAUGHT, {
            ...context,
            errorType,
            // We don't send errorMessage or stack to PostHog as per plan
        });
    }

    public static reportPerformance(): void {
        const memory = process.memoryUsage();
        this.reportEvent(EVENTS.PERFORMANCE_METRICS, {
            heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
            heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
            rssMb: Math.round(memory.rss / 1024 / 1024),
        });
    }

    public static startTimer(): number {
        return Date.now();
    }

    public static endTimer(startTime: number): number {
        return Date.now() - startTime;
    }

    public static generateRequestId(): string {
        return crypto.randomUUID();
    }
}
