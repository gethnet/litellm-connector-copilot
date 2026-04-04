import * as vscode from "vscode";
import { PostHogAdapter } from "./posthogAdapter";
import type {
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

    static readonly POSTHOG_API_KEY = "phc_OJr5j3sxq9AX6YglCd9NMP4HlwchYwBa53n8Jz44jkp";
    static readonly POSTHOG_HOST = "https://us.i.posthog.com";

    constructor() {
        this.adapter = new PostHogAdapter();
    }

    initialize(context: vscode.ExtensionContext): void {
        this.distinctId = vscode.env.machineId;
        const extensionVersion =
            context.extension?.packageJSON?.version ??
            vscode.extensions.getExtension("GethNet.litellm-connector-copilot")?.packageJSON?.version ??
            "unknown";
        this.extensionVersion = extensionVersion;

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
            extension_version: this.extensionVersion,
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

    public captureException(error: Error, options?: TelemetryCaptureExceptionOptions): void {
        const fullProperties: TelemetryEventProperties = {
            ...options?.properties,
            distinctId: options?.distinctId ?? this.distinctId,
            extension_version: this.extensionVersion,
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
        this.adapter.identify(distinctId, properties);
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

    // Feature usage
    captureChatRequest(props: {
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
        this.capture("chat_request", props);
    }

    captureInlineCompletionRequest(props: { status: string; durationMs: number; model: string }): void {
        this.capture("inline_completion_request", props);
    }

    captureCommitMessageGenerated(props: { model: string; durationMs: number; status: string }): void {
        this.capture("commit_message_generated", props);
    }

    captureModelPickerOpened(caller: string): void {
        this.capture("model_picker_opened", { caller });
    }

    captureCommandExecuted(commandId: string): void {
        this.capture("command_executed", { command_id: commandId });
    }

    // Performance & pain points
    captureRequestCompleted(props: {
        caller: string;
        model: string;
        endpoint: string;
        durationMs: number;
        tokensIn: number;
        tokensOut: number;
    }): void {
        this.capture("request_completed", props);
    }

    captureRequestFailed(props: {
        caller: string;
        model: string;
        endpoint: string;
        durationMs: number;
        errorType: string;
    }): void {
        this.capture("request_failed", props);
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

    captureFeatureUsed(featureName: string, caller: string): void {
        this.capture("feature_used", {
            feature_name: featureName,
            caller,
        });
    }

    async shutdown(): Promise<void> {
        await this.adapter.flush();
        await this.adapter.shutdown();
    }

    dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        void this.shutdown();
    }
}
