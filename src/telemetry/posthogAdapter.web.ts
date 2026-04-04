import posthog from "posthog-js";
import type {
    IPostHogAdapter,
    PostHogConfig,
    TelemetryEvent,
    TelemetryCaptureExceptionOptions,
    TelemetryPersonProperties,
} from "./types";

export class PostHogAdapter implements IPostHogAdapter {
    private initialized = false;
    private enabled = false;

    initialize(config: PostHogConfig): void {
        posthog.init(config.apiKey, {
            api_host: config.host,
            autocapture: false,
            capture_pageview: false,
            capture_pageleave: false,
            persistence: "memory", // No localStorage in web worker context
        });
        this.initialized = true;
        this.enabled = config.enabled;
    }

    capture(event: TelemetryEvent): void {
        if (!this.enabled || !this.initialized) {
            return;
        }
        posthog.capture(event.event, event.properties);
    }

    captureException(error: Error, options?: TelemetryCaptureExceptionOptions): void {
        if (!this.enabled || !this.initialized) {
            return;
        }
        posthog.captureException(error, {
            ...options?.properties,
            level: options?.level,
            groups: options?.groups,
        });
    }

    identify(distinctId: string, properties?: TelemetryPersonProperties): void {
        if (!this.enabled || !this.initialized) {
            return;
        }
        posthog.identify(distinctId, properties);
    }

    isFeatureEnabled(flagKey: string, distinctId?: string): boolean {
        if (!this.enabled || !this.initialized) {
            return false;
        }
        if (distinctId) {
            posthog.identify(distinctId);
        }
        return posthog.isFeatureEnabled(flagKey) ?? false;
    }

    reloadFeatureFlags(): void {
        if (!this.enabled || !this.initialized) {
            return;
        }
        posthog.reloadFeatureFlags();
    }

    async flush(): Promise<void> {
        // posthog-js flushes automatically via sendBeacon/fetch
    }

    async shutdown(): Promise<void> {
        posthog.reset();
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }
}
