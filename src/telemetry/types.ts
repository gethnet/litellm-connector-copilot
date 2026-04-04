export interface TelemetryEvent {
    event: string;
    properties: Record<string, string | number | boolean>;
    timestamp?: Date;
}

export interface PostHogConfig {
    apiKey: string;
    host: string;
    enabled: boolean;
}

export interface IPostHogAdapter {
    initialize(config: PostHogConfig): void;
    capture(event: TelemetryEvent): void;
    flush(): Promise<void>;
    shutdown(): Promise<void>;
    setEnabled(enabled: boolean): void;
}
