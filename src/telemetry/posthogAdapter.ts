import { PostHog } from "posthog-node";
import type { IPostHogAdapter, PostHogConfig, TelemetryEvent } from "./types";

export class PostHogAdapter implements IPostHogAdapter {
    private client: PostHog | undefined;
    private enabled = false;

    initialize(config: PostHogConfig): void {
        this.client = new PostHog(config.apiKey, {
            host: config.host,
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
