import { PostHog } from "posthog-node";
import type {
    IPostHogAdapter,
    PostHogConfig,
    TelemetryEvent,
    TelemetryCaptureExceptionOptions,
    TelemetryPersonProperties,
} from "./types";

export class PostHogAdapter implements IPostHogAdapter {
    private client: PostHog | undefined;
    private enabled = false;

    initialize(config: PostHogConfig): void {
        this.client = new PostHog(config.apiKey, {
            host: config.host,
            enableExceptionAutocapture: true,
            flushAt: 20,
            flushInterval: 10000,
        });
        this.enabled = config.enabled;
    }

    capture(event: TelemetryEvent): void {
        if (!this.enabled || !this.client) {
            return;
        }
        this.client.capture({
            distinctId: event.properties.distinctId as string,
            event: event.event,
            properties: event.properties,
            timestamp: event.timestamp,
        });
    }

    captureException(error: Error, options?: TelemetryCaptureExceptionOptions): void {
        if (!this.enabled || !this.client) {
            return;
        }
        this.client.captureException(error, options?.distinctId, {
            ...options?.properties,
            level: options?.level,
            groups: options?.groups,
        });
    }

    identify(distinctId: string, properties?: TelemetryPersonProperties): void {
        if (!this.enabled || !this.client) {
            return;
        }
        this.client.identify({
            distinctId,
            properties,
        });
    }

    async isFeatureEnabled(flagKey: string, distinctId?: string): Promise<boolean> {
        if (!this.enabled || !this.client) {
            return false;
        }
        return (await this.client.isFeatureEnabled(flagKey, distinctId ?? "anonymous")) ?? false;
    }

    async reloadFeatureFlags(): Promise<void> {
        if (!this.enabled || !this.client) {
            return;
        }
        await this.client.reloadFeatureFlags();
    }

    async flush(): Promise<void> {
        await this.client?.flush();
    }

    async shutdown(): Promise<void> {
        await this.client?.shutdown();
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }
}
