export type TelemetryPrimitive = string | number | boolean | null;

export type TelemetryEventProperties = Record<string, TelemetryPrimitive | TelemetryPrimitive[] | undefined>;

export type TelemetryPersonProperties = Record<string, TelemetryPrimitive | TelemetryPrimitive[] | undefined>;

export interface TelemetryEvent {
    event: string;
    properties: TelemetryEventProperties;
    timestamp?: Date;
}

export interface PostHogConfig {
    apiKey: string;
    host: string;
    enabled: boolean;
}

export interface TelemetryCaptureOptions {
    distinctId?: string;
    properties?: TelemetryEventProperties;
    groups?: Record<string, string>;
}

export interface TelemetryCaptureExceptionOptions extends TelemetryCaptureOptions {
    level?: "error" | "warning" | "info";
}

export interface IPostHogAdapter {
    initialize(config: PostHogConfig): void;
    capture(event: TelemetryEvent): void;
    captureException(error: Error, options?: TelemetryCaptureExceptionOptions): void;
    identify(distinctId: string, properties?: TelemetryPersonProperties): void;
    isFeatureEnabled(flagKey: string, distinctId?: string): Promise<boolean> | boolean;
    reloadFeatureFlags(): Promise<void> | void;
    flush(): Promise<void>;
    shutdown(): Promise<void>;
    setEnabled(enabled: boolean): void;
}
