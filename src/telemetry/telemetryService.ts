import * as vscode from "vscode";
import { PostHogAdapter } from "./posthogAdapter";
import type {
    LegacyConfigMigrationEvent,
    CostSummary,
    TelemetryEvent,
    TelemetryCaptureExceptionOptions,
    TelemetryEventProperties,
    TelemetryPersonProperties,
} from "./types";

export class TelemetryService implements vscode.Disposable {
    private adapter: PostHogAdapter;
    private distinctId = "";
    private extensionVersion = "";
    private disposables: vscode.Disposable[] = [];

    private _featureUsageCounter = new Map<string, number>();
    private _lastFeatureUsageFlush: number = Date.now();

    private static readonly EXTENSION_VERSION_PROPERTY = "extension_version";

    static readonly POSTHOG_API_KEY = "phc_OJr5j3sxq9AX6YglCd9NMP4HlwchYwBa53n8Jz44jkp";
    static readonly POSTHOG_HOST = "https://us.i.posthog.com";

    constructor() {
        this.adapter = new PostHogAdapter();
    }

    initialize(context: vscode.ExtensionContext): void {
        this.distinctId = vscode.env.machineId || vscode.env.sessionId;
        // Safely extract version with proper type guards
        const getVersion = (ext: vscode.Extension<unknown> | undefined): string => {
            const pkg: unknown = ext?.packageJSON;
            if (typeof pkg === "object" && pkg !== null && "version" in pkg) {
                const versionValue = (pkg as Record<string, unknown>).version;
                if (typeof versionValue === "string") {
                    return versionValue;
                }
            }
            return "unknown";
        };
        const v1 = getVersion(context.extension);
        const v2 = getVersion(vscode.extensions.getExtension("litellm-connector"));
        const v3 = getVersion(vscode.extensions.getExtension("GethNet.litellm-connector-copilot"));
        this.extensionVersion = v1 !== "unknown" ? v1 : v2 !== "unknown" ? v2 : v3;

        this.adapter.initialize({
            apiKey: TelemetryService.POSTHOG_API_KEY,
            host: TelemetryService.POSTHOG_HOST,
            enabled: vscode.env.isTelemetryEnabled,
        });

        this.disposables.push(
            vscode.env.onDidChangeTelemetryEnabled((enabled) => {
                this.adapter.setEnabled(enabled);
            })
        );
    }

    private capture(event: string, properties: TelemetryEventProperties = {}): void {
        const fullProperties: TelemetryEventProperties = {
            ...properties,
            distinctId: this.distinctId,
            [TelemetryService.EXTENSION_VERSION_PROPERTY]: this.extensionVersion,
            vscode_version: vscode.version,
            ui_kind: vscode.UIKind[vscode.env.uiKind],
            os: process.platform || "web",
        };

        const telemetryEvent: TelemetryEvent = {
            event,
            properties: fullProperties,
            timestamp: new Date(),
        };

        this.adapter.capture(telemetryEvent);
    }

    /**
     * Normalizes request lifecycle telemetry to snake_case properties while preserving
     * ergonomic camelCase inputs at call sites.
     */
    private captureRequestLifecycleEvent(
        eventName: "chat_request" | "request_completed" | "request_failed" | "request_caching_bypassed",
        props: {
            request_id: string;
            caller: string;
            model: string;
            endpoint?: string;
            durationMs?: number;
            tokensIn?: number;
            tokensOut?: number;
            cacheReadRatio?: number;
            errorType?: string;
            error?: string;
            stack?: string;
            status?: string;
            reason?: string;
            cost?: CostSummary;
        }
    ): void {
        const properties: TelemetryEventProperties = {
            request_id: props.request_id,
            caller: props.caller,
            model: props.model,
            endpoint: props.endpoint ?? "unknown",
            duration_ms: props.durationMs ?? 0,
            status: props.status,
            tokens_in: props.tokensIn,
            tokens_out: props.tokensOut,
            cache_read_ratio: props.cacheReadRatio,
            error_type: props.errorType,
            error: props.error,
            stack: props.stack,
            reason: props.reason,
            estimated_input_cost: props.cost?.estimated_input_cost,
            estimated_output_cost: props.cost?.estimated_output_cost,
            estimated_total_cost: props.cost?.estimated_total_cost,
        };

        this.capture(eventName, properties);
    }

    public captureException(error: Error, options?: TelemetryCaptureExceptionOptions): void {
        const fullProperties: TelemetryEventProperties = {
            ...options?.properties,
            distinctId: options?.distinctId ?? this.distinctId,
            [TelemetryService.EXTENSION_VERSION_PROPERTY]: this.extensionVersion,
            vscode_version: vscode.version,
            ui_kind: vscode.UIKind[vscode.env.uiKind],
            os: process.platform || "web",
        };

        this.adapter.captureException(error, {
            ...options,
            caller: options?.caller,
            distinctId: options?.distinctId ?? this.distinctId,
            properties: fullProperties,
        });
    }

    public identify(distinctId: string, properties?: TelemetryPersonProperties): void {
        this.adapter.identify(distinctId || this.distinctId, {
            ...properties,
            [TelemetryService.EXTENSION_VERSION_PROPERTY]: this.extensionVersion,
        });
    }

    public isFeatureEnabled(flagKey: string, distinctId?: string): Promise<boolean> | boolean {
        return this.adapter.isFeatureEnabled(flagKey, distinctId ?? this.distinctId);
    }

    public reloadFeatureFlags(): Promise<void> | void {
        return this.adapter.reloadFeatureFlags();
    }

    // Lifecycle
    captureExtensionActivated(version: string, vscodeVersion: string): void {
        this.capture("extension_activated", { version, vscode_version: vscodeVersion });
    }

    captureExtensionDeactivated(uptimeSeconds: number): void {
        this.capture("extension_deactivated", { uptime_seconds: uptimeSeconds });
    }

    // Configuration
    captureConfigChanged(settingKey: string, source: string): void {
        this.capture("config_changed", { setting_key: settingKey, source });
    }

    captureBackendAdded(backendCount: number): void {
        this.capture("backend_added", { backend_count: backendCount });
    }

    captureBackendRemoved(backendCount: number): void {
        this.capture("backend_removed", { backend_count: backendCount });
    }

    // `request_id` is emitted as a flat top-level property so PostHog can index and filter
    // request lifecycle events without requiring nested JSON parsing.
    captureChatRequest(props: {
        request_id: string;
        caller: string;
        model: string;
        endpoint: string;
        durationMs: number;
        tokensIn: number;
        tokensOut: number;
        status: string;
        error?: string;
        stack?: string;
    }): void {
        this.captureRequestLifecycleEvent("chat_request", props);
    }

    captureInlineCompletionRequest(props: { status: string; durationMs: number; model: string }): void {
        this.capture("inline_completion_request", {
            status: props.status,
            duration_ms: props.durationMs,
            model: props.model,
        });
    }

    captureCommitMessageGenerated(props: { model: string; durationMs: number; status: string }): void {
        this.capture("commit_message_generated", {
            model: props.model,
            duration_ms: props.durationMs,
            status: props.status,
        });
    }

    captureModelPickerOpened(caller: string): void {
        this.capture("model_picker_opened", { caller });
    }

    captureCommandExecuted(commandId: string): void {
        this.capture("command_executed", { command_id: commandId });
    }

    // Performance & pain points
    captureRequestCompleted(props: {
        request_id: string;
        caller: string;
        model: string;
        endpoint: string;
        durationMs: number;
        tokensIn: number;
        tokensOut: number;
        cost?: CostSummary;
    }): void {
        this.captureRequestLifecycleEvent("request_completed", props);
    }

    captureRequestCompletedWithCache(props: {
        request_id: string;
        caller: string;
        model: string;
        endpoint: string;
        durationMs: number;
        tokensIn: number;
        tokensOut: number;
        cacheReadRatio?: number;
        cost?: CostSummary;
    }): void {
        this.captureRequestLifecycleEvent("request_completed", props);
    }

    captureRequestFailed(props: {
        request_id: string;
        caller: string;
        model: string;
        endpoint: string;
        durationMs: number;
        errorType: string;
        cost?: CostSummary;
    }): void {
        this.captureRequestLifecycleEvent("request_failed", props);
    }

    captureRequestCachingBypassed(props: {
        request_id: string;
        caller: string;
        model: string;
        endpoint?: string;
        reason?: string;
        cost?: CostSummary;
    }): void {
        this.captureRequestLifecycleEvent("request_caching_bypassed", props);
    }

    captureQuotaError(model: string, caller: string): void {
        this.capture("quota_error", { model, caller });
    }

    captureModelNotFound(model: string, caller: string): void {
        this.capture("model_not_found", { model, caller });
    }

    captureTimeout(caller: string, model: string, durationMs: number): void {
        this.capture("timeout", { caller, model, duration_ms: durationMs });
    }

    captureConnectionError(caller: string, errorType: string): void {
        this.capture("connection_error", { caller, error_type: errorType });
    }

    captureTrimExecuted(
        model: string,
        caller: string,
        originalTokens: number,
        trimmedTokens: number,
        budget: number
    ): void {
        this.capture("trim_executed", {
            model,
            caller,
            original_tokens: originalTokens,
            trimmed_tokens: trimmedTokens,
            budget,
        });
    }

    // Model discovery
    captureModelsDiscovered(modelCount: number, backendCount: number): void {
        this.capture("models_discovered", { model_count: modelCount, backend_count: backendCount });
    }

    captureModelsCacheHit(modelCount: number): void {
        this.capture("models_cache_hit", { model_count: modelCount });
    }

    // Feature usage reporting
    captureFeatureUsageSnapshot(features: Record<string, boolean>): void {
        this.capture("feature_usage_snapshot", features);
    }

    captureFeatureToggled(featureName: string, enabled: boolean, source: string): void {
        this.capture("feature_toggled", {
            feature_name: featureName,
            enabled,
            source,
        });
    }

    captureModernConfigStatus(props: { is_on_modern_config: boolean; source: string }): void {
        this.capture("modern_config_status", props);
    }

    public captureLegacyConfigMigration(data: LegacyConfigMigrationEvent): void {
        this.capture("legacy_config_migrated", {
            backend_count: data.backend_count,
            group_name: data.group_name,
            source: data.source,
        });
    }

    captureFeatureUsed(featureName: string, _caller: string): void {
        this._captureAggregatedFeatureUsage(featureName);
    }

    private _captureAggregatedFeatureUsage(featureName: string): void {
        const now = Date.now();
        const flushIntervalMs = 15 * 60 * 1000; // 15 minutes

        if (now - this._lastFeatureUsageFlush >= flushIntervalMs) {
            this._flushAggregatedFeatureUsage();
            this._lastFeatureUsageFlush = now;
        }

        const count = this._featureUsageCounter.get(featureName) || 0;
        this._featureUsageCounter.set(featureName, count + 1);
    }

    private _flushAggregatedFeatureUsage(): void {
        if (this._featureUsageCounter.size === 0) {
            return;
        }

        const features: Record<string, number> = {};
        for (const [feature, count] of this._featureUsageCounter) {
            features[feature] = count;
        }

        this.capture("feature_used_aggregated", {
            features: JSON.stringify(features),
            period_minutes: 15,
        });

        this._featureUsageCounter.clear();
    }

    public captureModelUsed(modelId: string, caller: string): void {
        this.capture("model_used", { model_id: modelId, caller });

        // Also track provider
        const provider = modelId.includes("/") ? modelId.split("/")[0] : modelId;
        this.capture("provider_used", { provider, caller });
    }

    public captureFeatureAdoption(feature: string): void {
        this.capture("feature_adoption", { feature });
    }

    async shutdown(): Promise<void> {
        this._flushAggregatedFeatureUsage();
        await this.adapter.flush();
        await this.adapter.shutdown();
    }

    dispose(): void {
        this.disposables.forEach((d: vscode.Disposable) => {
            d.dispose();
        });
        // Note: We intentionally do NOT await shutdown here because:
        // 1. VS Code's Disposable.dispose() is synchronous by contract
        // 2. During test teardown, awaiting async operations can cause hangs
        // 3. The PostHog client shutdown is best-effort cleanup
        // Use shutdown() directly if you need to await completion.
        try {
            // Synchronous flush attempt for graceful shutdown
            this._flushAggregatedFeatureUsage();
        } catch {
            // Ignore errors during dispose
        }
        // Fire-and-forget the async shutdown - it will complete in background
        this.adapter.shutdown().catch(() => {
            // Silently ignore shutdown errors
        });
    }
}
