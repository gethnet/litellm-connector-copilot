import * as vscode from "vscode";
import { PostHogAdapter } from "./posthogAdapter";
import { BoundedTelemetryAggregate, type AggregateSample } from "./telemetryAggregate";
import type {
    LegacyConfigMigrationEvent,
    CostSummary,
    TelemetryEvent,
    TelemetryCaptureExceptionOptions,
    TelemetryEventProperties,
    TelemetryPersonProperties,
} from "./types";

/**
 * Aggregation window length and the per-instance cardinality cap.
 *
 * Both values are deliberately explicit rather than inferred from config so
 * that PostHog dashboards and the bounded-key overflow math see a stable,
 * documented shape.
 */
const AGGREGATE_INTERVAL_MS = 15 * 60 * 1000;
const MAX_AGGREGATE_KEYS = 128;

export class TelemetryService implements vscode.Disposable {
    private adapter: PostHogAdapter;
    private distinctId = "";
    private extensionVersion = "";
    private disposables: vscode.Disposable[] = [];

    /**
     * Service-owned aggregation lifecycle. The previous opportunistic flush
     * (timestamp-based, per call) leaked pending state across consent
     * transitions and produced inconsistent per-window totals. The timer,
     * aggregate maps, and consent transitions are now co-located in one place
     * so dispose/shutdown, consent revocation, and re-enable can drain and
     * restart deterministically.
     */
    private initialized = false;
    private disposed = false;
    private shutdownPromise: Promise<void> | undefined;
    private telemetryEnabled = false;
    private aggregateTimer: ReturnType<typeof setInterval> | undefined;
    private aggregateWindowStartedAt = 0;
    private readonly modelAttempts = new BoundedTelemetryAggregate(MAX_AGGREGATE_KEYS);
    private readonly inlineCompletionSuccesses = new BoundedTelemetryAggregate(MAX_AGGREGATE_KEYS);
    private readonly featureUsage = new Map<string, number>();

    private static readonly EXTENSION_VERSION_PROPERTY = "extension_version";
    private static readonly INLINE_COMPLETIONS_CALLER = "inline-completions";

    static readonly POSTHOG_API_KEY = "phc_OJr5j3sxq9AX6YglCd9NMP4HlwchYwBa53n8Jz44jkp";
    static readonly POSTHOG_HOST = "https://us.i.posthog.com";

    constructor() {
        this.adapter = new PostHogAdapter();
    }

    initialize(context: vscode.ExtensionContext): void {
        // `initialize` is idempotent so re-entry from hot-swap or test seams
        // cannot double-start the timer or layer duplicate listeners.
        if (this.initialized || this.disposed) {
            return;
        }
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

        this.initialized = true;
        this.telemetryEnabled = vscode.env.isTelemetryEnabled;
        this.aggregateWindowStartedAt = Date.now();

        this.disposables.push(
            vscode.env.onDidChangeTelemetryEnabled((enabled) => {
                if (this.disposed || enabled === this.telemetryEnabled) {
                    return;
                }
                this.telemetryEnabled = enabled;
                this.adapter.setEnabled(enabled);
                this.stopAggregateTimer();
                // Consent off must drop pending aggregates without transmitting
                // them. Consent re-enable starts a fresh window so a denial
                // followed by re-approval cannot bleed old totals into a new
                // window.
                this.clearAggregateState();
                if (!enabled) {
                    return;
                }
                this.aggregateWindowStartedAt = Date.now();
                this.startAggregateTimer();
            })
        );
        this.startAggregateTimer();
    }

    /**
     * `canCapture` is the only predicate that gates capture paths; adapter-level
     * `enabled` guards are defense-in-depth that protect against reentry from a
     * queued listener fired after `disposed`.
     */
    private canCapture(): boolean {
        return this.initialized && !this.disposed && this.telemetryEnabled;
    }

    private capture(event: string, properties: TelemetryEventProperties = {}): void {
        if (!this.canCapture()) {
            return;
        }
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
        // Inline completions are aggregated instead of emitted immediately to
        // cut per-row PostHog event volume. Chat callers and failures retain
        // their request-level immediacy so dashboards stay accurate.
        if (eventName === "request_completed" && props.caller === TelemetryService.INLINE_COMPLETIONS_CALLER) {
            this.captureInlineCompletionSucceeded({
                model: props.model,
                caller: props.caller,
                durationMs: props.durationMs,
                tokensIn: props.tokensIn,
                tokensOut: props.tokensOut,
                cacheReadRatio: props.cacheReadRatio,
                cost: props.cost,
            });
            return;
        }

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
        // `Logger.error("message", err)` does not invoke `captureException` —
        // callers must pass an `Error` as the first argument. We keep the same
        // contract for `captureException` (and the global exception listener
        // bridges) so the global exception listener does not silently inject
        // an extra failure event per successful chat call.
        if (!(error instanceof Error)) {
            return;
        }
        if (!this.canCapture()) {
            return;
        }
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
        if (!this.canCapture()) {
            return;
        }
        this.adapter.identify(distinctId || this.distinctId, {
            ...properties,
            [TelemetryService.EXTENSION_VERSION_PROPERTY]: this.extensionVersion,
        });
    }

    public isFeatureEnabled(flagKey: string, distinctId?: string): Promise<boolean> | boolean {
        if (!this.canCapture()) {
            return false;
        }
        return this.adapter.isFeatureEnabled(flagKey, distinctId ?? this.distinctId);
    }

    public reloadFeatureFlags(): Promise<void> | void {
        if (!this.canCapture()) {
            return;
        }
        return this.adapter.reloadFeatureFlags();
    }

    // Lifecycle
    captureExtensionActivated(version: string, vscodeVersion: string, features: string[] = []): void {
        // Fold the legacy startup `feature_adoption` triplet into the
        // activation event so dashboards see one row per install instead of
        // four. `features` is the static set the extension advertises —
        // actual adoption is inferred from other lifecycle events.
        this.capture("extension_activated", {
            version,
            vscode_version: vscodeVersion,
            feature_adoption: features,
        });
    }

    captureExtensionDeactivated(uptimeSeconds: number): void {
        this.capture("extension_deactivated", { uptime_seconds: uptimeSeconds });
    }

    captureReviewPromptEligible(props: { installDate: number; successfulTurnCount: number }): void {
        this.capture("review_prompt_eligible", {
            install_date: props.installDate,
            successful_turn_count: props.successfulTurnCount,
        });
    }

    captureReviewPromptChoice(props: {
        choice: "review_or_rated" | "never_again" | "later";
        installDate: number;
        successfulTurnCount: number;
    }): void {
        this.capture("review_prompt_choice", {
            choice: props.choice,
            install_date: props.installDate,
            successful_turn_count: props.successfulTurnCount,
        });
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
        // `chat_request` is preserved as a dormant compatibility API for
        // dashboards that were wired before the per-call failure was removed.
        // The provider-level duplicate failure capture no longer exists; new
        // code should emit `request_failed` through the lifecycle helper.
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

    /**
     * Aggregate feature usage into a single per-window summary. The timer
     * flushes even when idle (no callers between ticks) so a stale window
     * still emits a structured `feature_used_aggregated` row with the JSON
     * counter payload — same shape as before the volume-reduction work.
     */
    captureFeatureUsed(featureName: string, _caller: string): void {
        if (!this.canCapture()) {
            return;
        }
        this.featureUsage.set(featureName, (this.featureUsage.get(featureName) ?? 0) + 1);
        this.startAggregateTimer();
    }

    public captureModelUsed(modelId: string, caller: string): void {
        // The aggregate helper preserves the complete model id and caller on
        // the resulting row so naming, routing, and capability dashboards
        // remain accurate. The first slash segment of a namespaced id is a
        // routing identity (not necessarily a provider vendor), so the
        // previous `provider_used` path has been removed to avoid inventing a
        // vendor property from routing structure.
        this.addAggregate({ modelId, caller }, "model");
    }

    /**
     * Kept as a dormant method so dashboards that probe `feature_adoption`
     * in tests/CLI tooling do not lose data, but no production startup path
     * invokes it. The folded `feature_adoption` array lives on the
     * `extension_activated` event.
     */
    public captureFeatureAdoption(feature: string): void {
        this.capture("feature_adoption", { feature });
    }

    /**
     * Aggregate a single inline completion success into the bounded window.
     * Public-style visibility keeps it reachable from tests and the
     * lifecycle interposer; production callers go through the lifecycle
     * router so callers other than `inline-completions` stay immediate.
     */
    captureInlineCompletionSucceeded(props: {
        model: string;
        caller: string;
        durationMs?: number;
        tokensIn?: number;
        tokensOut?: number;
        cacheReadRatio?: number;
        cost?: CostSummary;
    }): void {
        this.addAggregate(
            {
                modelId: props.model,
                caller: props.caller,
                durationMs: props.durationMs,
                tokensIn: props.tokensIn,
                tokensOut: props.tokensOut,
                cacheReadRatio: props.cacheReadRatio,
                estimatedInputCost: props.cost?.estimated_input_cost,
                estimatedOutputCost: props.cost?.estimated_output_cost,
                estimatedTotalCost: props.cost?.estimated_total_cost,
            },
            "inline"
        );
    }

    private startAggregateTimer(): void {
        if (!this.canCapture() || this.aggregateTimer !== undefined) {
            return;
        }
        this.aggregateTimer = setInterval(() => {
            this.flushAggregates();
        }, AGGREGATE_INTERVAL_MS);
    }

    private stopAggregateTimer(): void {
        if (this.aggregateTimer !== undefined) {
            clearInterval(this.aggregateTimer);
        }
        this.aggregateTimer = undefined;
    }

    private clearAggregateState(): void {
        this.modelAttempts.drain();
        this.inlineCompletionSuccesses.drain();
        this.featureUsage.clear();
        this.aggregateWindowStartedAt = 0;
    }

    private flushAggregates(): void {
        if (!this.canCapture()) {
            return;
        }
        const endedAt = Date.now();
        const elapsed = Math.max(0, endedAt - this.aggregateWindowStartedAt);
        const window: TelemetryEventProperties = {
            window_started_at_ms: this.aggregateWindowStartedAt,
            window_ended_at_ms: endedAt,
            window_duration_ms: elapsed,
            period_minutes: elapsed / 60_000,
            aggregation_version: 1,
        };
        const modelSummaries = this.modelAttempts.drain();
        const inlineSummaries = this.inlineCompletionSuccesses.drain();
        const featureSummary = this.drainFeatureUsage();
        this.aggregateWindowStartedAt = endedAt;
        for (const summary of modelSummaries) {
            this.capture("model_used_aggregated", {
                ...window,
                model_id: summary.model_id,
                caller: summary.caller,
                attempt_count: summary.request_count,
                overflow: summary.overflow,
            });
        }
        for (const summary of inlineSummaries) {
            this.capture("inline_completion_aggregated", { ...summary, ...window });
        }
        if (featureSummary) {
            this.capture("feature_used_aggregated", { ...featureSummary, ...window });
        }
    }

    private drainFeatureUsage(): TelemetryEventProperties | undefined {
        if (this.featureUsage.size === 0) {
            return undefined;
        }
        const features: Record<string, number> = {};
        for (const [feature, count] of this.featureUsage) {
            features[feature] = count;
        }
        this.featureUsage.clear();
        return { features: JSON.stringify(features) };
    }

    private addAggregate(sample: AggregateSample, target: "model" | "inline"): void {
        if (!this.canCapture()) {
            return;
        }
        const aggregate = target === "model" ? this.modelAttempts : this.inlineCompletionSuccesses;
        aggregate.add(sample);
        this.startAggregateTimer();
    }

    async shutdown(): Promise<void> {
        if (!this.shutdownPromise) {
            this.shutdownPromise = this.completeShutdown();
        }
        await this.shutdownPromise;
    }

    private async completeShutdown(): Promise<void> {
        // Run the synchronous lifecycle work before the first await so
        // `dispose()` halts capture paths immediately even when the async
        // adapter shutdown is still pending.
        this.stopAggregateTimer();
        try {
            this.flushAggregates();
        } catch {
            // Telemetry is best effort; failed capture must not prevent cleanup.
            this.clearAggregateState();
        } finally {
            this.disposed = true;
            this.clearAggregateState();
            this.disposables.forEach((disposable) => {
                disposable.dispose();
            });
            this.disposables = [];
        }
        try {
            await this.adapter.flush();
        } finally {
            await this.adapter.shutdown();
        }
    }

    dispose(): void {
        // `dispose()` matches the VS Code synchronous contract. The async
        // shutdown runs in the background; capture paths are blocked the
        // moment `disposed` is set in `completeShutdown`.
        void this.shutdown().catch(() => undefined);
    }
}
