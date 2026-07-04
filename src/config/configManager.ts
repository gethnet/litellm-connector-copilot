import * as vscode from "vscode";
import type { LiteLLMConfig } from "../types";
import type { TelemetryService } from "../telemetry/telemetryService";
import { LiteLLMClient } from "../adapters/litellmClient";
import type { BackendSession } from "../providers/backendSession";
import { Logger } from "../utils/logger";
import { deriveGroupNameFromUrl } from "../utils";

export class ConfigManager {
    private static readonly INACTIVITY_TIMEOUT_KEY = "litellm-connector.inactivityTimeout";
    private static readonly DISABLE_CACHING_KEY = "litellm-connector.disableCaching";
    private static readonly DISABLE_QUOTA_TOOL_REDACTION_KEY = "litellm-connector.disableQuotaToolRedaction";
    private static readonly KEY_MODEL_OVERRIDES_ENABLE = "litellm-connector.enableModelOverrides";
    private static readonly MODEL_CAPABILITIES_OVERRIDES_KEY = "litellm-connector.modelCapabilitiesOverrides";
    private static readonly MODEL_ID_OVERRIDE_KEY = "litellm-connector.modelIdOverride";
    private static readonly SCM_COMMIT_MSG_MODEL_ID_KEY = "litellm-connector.commitModelIdOverride";
    private static readonly FORCE_RESPONSES_ENDPOINT_KEY = "litellm-connector.forceResponsesEndpoint";
    private static readonly ALLOW_CHAT_COMPLETIONS_FALLBACK_KEY = "litellm-connector.allowChatCompletionsFallback";
    private static readonly DISPLAY_PRICING_IN_PICKER_KEY = "litellm-connector.displayPricingInPicker";
    private static readonly DISCOVERY_TIMEOUT_MS_KEY = "litellm-connector.discoveryTimeoutMs";
    private static readonly DISCOVERY_CACHE_TTL_MS_KEY = "litellm-connector.discoveryCacheTtlMs";
    private static readonly DISCOVERY_FIRE_DEBOUNCE_MS_KEY = "litellm-connector.discoveryFireDebounceMs";
    private static readonly DISCOVERY_FIRE_MIN_INTERVAL_MS_KEY = "litellm-connector.discoveryFireMinIntervalMs";

    // Discovery config defaults and bounds
    private static readonly DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
    private static readonly MIN_DISCOVERY_TIMEOUT_MS = 500;
    private static readonly MAX_DISCOVERY_TIMEOUT_MS = 60_000;
    private static readonly DEFAULT_DISCOVERY_CACHE_TTL_MS = 60_000;
    private static readonly MIN_DISCOVERY_CACHE_TTL_MS = 0;
    private static readonly MAX_DISCOVERY_CACHE_TTL_MS = 300_000;
    private static readonly DEFAULT_DISCOVERY_FIRE_DEBOUNCE_MS = 250;
    private static readonly MAX_DISCOVERY_FIRE_DEBOUNCE_MS = 5_000;
    private static readonly DEFAULT_DISCOVERY_FIRE_MIN_INTERVAL_MS = 2_000;
    private static readonly MAX_DISCOVERY_FIRE_MIN_INTERVAL_MS = 30_000;

    private _telemetryService?: TelemetryService;

    private readonly secrets: vscode.SecretStorage;

    constructor(secrets: vscode.SecretStorage) {
        this.secrets = ConfigManager.ensureSecretStorage(secrets);
    }

    /**
     * Ensures a usable SecretStorage implementation even in tests that provide partial stubs.
     */
    private static ensureSecretStorage(secrets: vscode.SecretStorage | undefined): vscode.SecretStorage {
        if (secrets && typeof secrets.get === "function" && typeof secrets.store === "function") {
            return secrets;
        }

        // Provide a minimal stub for testing to avoid empty method warnings
        const stubStorage: vscode.SecretStorage = {
            get: async () => undefined,
            store: async (_key: string): Promise<void> => {
                /* no-op: stub for testing */
            },
            delete: async (_key: string): Promise<void> => {
                /* no-op: stub for testing */
            },
            keys: async () => [],
            onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
        };
        return stubStorage;
    }

    /**
     * Store a secret in the extension's secret storage.
     */
    public async store(key: string, value: string): Promise<void> {
        await this.secrets.store(key, value);
    }

    /**
     * Delete a secret from the extension's secret storage.
     */
    public async delete(key: string): Promise<void> {
        await this.secrets.delete(key);
    }

    public async getSecret(key: string): Promise<string | undefined> {
        return this.secrets.get(key);
    }

    /**
     * Clamps a discovery timeout value to valid bounds.
     */
    private clampDiscoveryTimeoutMs(value: number | undefined): number {
        if (typeof value !== "number" || Number.isNaN(value)) {
            return ConfigManager.DEFAULT_DISCOVERY_TIMEOUT_MS;
        }
        return Math.min(
            ConfigManager.MAX_DISCOVERY_TIMEOUT_MS,
            Math.max(ConfigManager.MIN_DISCOVERY_TIMEOUT_MS, value)
        );
    }

    /**
     * Clamps a discovery cache TTL value to valid bounds.
     */
    private clampDiscoveryCacheTtlMs(value: number | undefined): number {
        if (typeof value !== "number" || Number.isNaN(value)) {
            return ConfigManager.DEFAULT_DISCOVERY_CACHE_TTL_MS;
        }
        return Math.min(
            ConfigManager.MAX_DISCOVERY_CACHE_TTL_MS,
            Math.max(ConfigManager.MIN_DISCOVERY_CACHE_TTL_MS, value)
        );
    }

    /**
     * Generic range clamp for discovery settings.
     */
    private clampRange(value: number | undefined, min: number, max: number, defaultValue: number): number {
        if (typeof value !== "number" || Number.isNaN(value)) {
            return defaultValue;
        }
        return Math.min(max, Math.max(min, value));
    }

    public setTelemetryService(service: TelemetryService): void {
        this._telemetryService = service;
    }

    /**
     * Retrieves the current LiteLLM workspace-level configuration.
     *
     * Backend connection details (baseUrl, apiKey) are NOT read here — they are
     * delivered by VS Code 1.120 per-group `options.configuration` payloads on
     * every provider call. This method now only returns workspace-scoped
     * ergonomic toggles and overrides.
     */
    async getConfig(): Promise<LiteLLMConfig> {
        const workspaceConfig = vscode.workspace.getConfiguration();

        const inactivityTimeout = workspaceConfig.get<number>(ConfigManager.INACTIVITY_TIMEOUT_KEY, 60);
        const disableCaching = workspaceConfig.get<boolean>(ConfigManager.DISABLE_CACHING_KEY, true);
        const disableQuotaToolRedaction = workspaceConfig.get<boolean>(
            ConfigManager.DISABLE_QUOTA_TOOL_REDACTION_KEY,
            false
        );
        const enableModelOverrides = workspaceConfig.get<boolean>(ConfigManager.KEY_MODEL_OVERRIDES_ENABLE, true);
        // modelOverrides are loaded but the LiteLLMConfig.modelOverrides field was
        // removed in v2.2.0 (dead plumbing — the override system reads the workspace
        // setting directly via modelOverrides.ts findOverride).

        const modelCapabilitiesOverridesRaw = workspaceConfig.get<Record<string, string | string[]>>(
            ConfigManager.MODEL_CAPABILITIES_OVERRIDES_KEY,
            {}
        );

        const modelCapabilitiesOverrides: Record<string, { toolCalling?: boolean; imageInput?: boolean }> = {};
        if (
            modelCapabilitiesOverridesRaw &&
            typeof modelCapabilitiesOverridesRaw === "object" &&
            !Array.isArray(modelCapabilitiesOverridesRaw)
        ) {
            for (const [modelId, value] of Object.entries(modelCapabilitiesOverridesRaw)) {
                let caps: string[] = [];
                if (Array.isArray(value)) {
                    caps = value.map(String);
                } else if (typeof value === "string") {
                    caps = value
                        .split(",")
                        .map((c) => c.trim())
                        .filter((c) => c.length > 0);
                }

                if (caps.length > 0) {
                    const entry: { toolCalling?: boolean; imageInput?: boolean } = {};
                    if (caps.some((c) => c.toLowerCase() === "toolcalling" || c.toLowerCase() === "tools")) {
                        entry.toolCalling = true;
                    }
                    if (caps.some((c) => c.toLowerCase() === "imageinput" || c.toLowerCase() === "vision")) {
                        entry.imageInput = true;
                    }
                    if (Object.keys(entry).length > 0) {
                        modelCapabilitiesOverrides[modelId] = entry;
                    }
                }
            }
        }

        const modelIdOverride = workspaceConfig.get<string>(ConfigManager.MODEL_ID_OVERRIDE_KEY, "").trim();
        const scmGitCompletionsModelId = workspaceConfig
            .get<string>(ConfigManager.SCM_COMMIT_MSG_MODEL_ID_KEY, "")
            .trim();
        const forceResponsesEndpoint = workspaceConfig.get<boolean>(ConfigManager.FORCE_RESPONSES_ENDPOINT_KEY, false);
        const allowChatCompletionsFallback = workspaceConfig.get<boolean>(
            ConfigManager.ALLOW_CHAT_COMPLETIONS_FALLBACK_KEY,
            false
        );
        const displayPricingInPicker = workspaceConfig.get<boolean>(ConfigManager.DISPLAY_PRICING_IN_PICKER_KEY, true); // Ensure config precedence for displayPricingInPicker

        const discoveryTimeoutMs = this.clampDiscoveryTimeoutMs(
            workspaceConfig.get<number>(ConfigManager.DISCOVERY_TIMEOUT_MS_KEY)
        );
        const discoveryCacheTtlMs = this.clampDiscoveryCacheTtlMs(
            workspaceConfig.get<number>(ConfigManager.DISCOVERY_CACHE_TTL_MS_KEY)
        );
        const discoveryFireDebounceMs = this.clampRange(
            workspaceConfig.get<number>(ConfigManager.DISCOVERY_FIRE_DEBOUNCE_MS_KEY),
            0,
            ConfigManager.MAX_DISCOVERY_FIRE_DEBOUNCE_MS,
            ConfigManager.DEFAULT_DISCOVERY_FIRE_DEBOUNCE_MS
        );
        const discoveryFireMinIntervalMs = this.clampRange(
            workspaceConfig.get<number>(ConfigManager.DISCOVERY_FIRE_MIN_INTERVAL_MS_KEY),
            0,
            ConfigManager.MAX_DISCOVERY_FIRE_MIN_INTERVAL_MS,
            ConfigManager.DEFAULT_DISCOVERY_FIRE_MIN_INTERVAL_MS
        );

        return {
            inactivityTimeout,
            disableCaching,
            disableQuotaToolRedaction,
            enableModelOverrides,
            modelCapabilitiesOverrides,
            modelIdOverride: modelIdOverride.length > 0 ? modelIdOverride : undefined,
            commitModelIdOverride: `${scmGitCompletionsModelId}`,
            forceResponsesEndpoint,
            allowChatCompletionsFallback,
            displayPricingInPicker,
            discoveryTimeoutMs,
            discoveryCacheTtlMs,
            discoveryFireDebounceMs,
            discoveryFireMinIntervalMs,
        };
    }

    /**
     * Reports current feature toggle states to telemetry.
     * Call after config changes that may affect feature toggles.
     */
    async reportFeatureToggles(source: string): Promise<void> {
        if (!this._telemetryService) {
            return;
        }
        const config = await this.getConfig();
        const toggles: [string, boolean][] = [
            ["commit-message", !!(config.commitModelIdOverride && config.commitModelIdOverride.length > 0)],
            ["caching", !config.disableCaching],
            ["quota-tool-redaction", !config.disableQuotaToolRedaction],
        ];
        for (const [name, enabled] of toggles) {
            this._telemetryService.captureFeatureToggled(name, enabled, source);
        }
    }

    /**
     * Converts VS Code per-group provider configuration into a BackendSession.
     *
     * Required fields (per `package.json` `languageModelChatProviders.configuration`):
     *   - `baseUrl`  — must start with http:// or https://
     *   - `apiKey`   — non-empty string (encrypted by VS Code)
     *
     * `groupName` is the user-entered group label from VS Code 1.120's group
     * picker. It is NOT required: when absent, `BackendSession.backendName`
     * falls back to a hostname derived from `baseUrl`. The discovery layer
     * uses `baseUrl` as the cache key regardless of the group name, so a
     * missing or stale groupName has no effect on routing.
     *
     * `providerName` (if present in the payload) is ignored. It is a legacy
     * field from the multi-backend era and is no longer part of the schema.
     */
    convertProviderConfiguration(
        groupName: string,
        configuration: Record<string, unknown>
    ): BackendSession | undefined {
        const baseUrl = typeof configuration.baseUrl === "string" ? configuration.baseUrl.trim() : "";
        const apiKey = typeof configuration.apiKey === "string" ? configuration.apiKey.trim() : "";

        if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
            Logger.warn(
                "convertProviderConfiguration: rejected — baseUrl must start with http:// or https:// (got a non-http value)"
            );
            return undefined;
        }

        if (!apiKey) {
            Logger.warn("convertProviderConfiguration: rejected — apiKey is empty in per-group configuration");
            return undefined;
        }

        // Derive a stable backendName from the canonical group name; fall back to a
        // hostname+port derived from baseUrl when the user has not entered a group
        // name. Reuse the same helper the discovery layer uses to compute the
        // picker's category label, so the two stay in sync.
        const trimmedGroupName = groupName.trim();
        const backendName = trimmedGroupName || deriveGroupNameFromUrl(baseUrl) || baseUrl;

        const userAgent = "litellm-vscode-chat/vscode-1.120+";
        return {
            backendName,
            baseUrl,
            apiKey,
            client: new LiteLLMClient({ url: baseUrl, key: apiKey }, userAgent),
        };
    }

    /**
     * Dispose hook to align with ExtensionContext subscription lifecycle.
     * Currently a no-op because ConfigManager does not hold disposable resources.
     */
    async dispose(): Promise<void> {
        this._telemetryService = undefined;
    }
}
