import * as vscode from "vscode";
import type { LiteLLMBackend, LiteLLMConfig, ResolvedBackend } from "../types";
import type { TelemetryService } from "../telemetry/telemetryService";

export class ConfigManager {
    private static readonly BASE_URL_KEY = "litellm-connector.baseUrl";
    private static readonly API_KEY_KEY = "litellm-connector.apiKey";
    private static readonly API_KEY_SECRET_REF_KEY = "litellm-connector.apiKeySecretRef";
    private static readonly DEFAULT_API_KEY_SECRET_REF = "default";
    private static readonly BACKENDS_KEY = "litellm-connector.backends";
    private static readonly INACTIVITY_TIMEOUT_KEY = "litellm-connector.inactivityTimeout";
    private static readonly DISABLE_CACHING_KEY = "litellm-connector.disableCaching";
    private static readonly EXPERIMENTAL_EMIT_USAGE_DATA_KEY = "litellm-connector.emitUsageData";
    private static readonly DISABLE_QUOTA_TOOL_REDACTION_KEY = "litellm-connector.disableQuotaToolRedaction";
    private static readonly MODEL_OVERRIDES_KEY = "litellm-connector.modelOverrides";
    private static readonly MODEL_CAPABILITIES_OVERRIDES_KEY = "litellm-connector.modelCapabilitiesOverrides";
    private static readonly MODEL_ID_OVERRIDE_KEY = "litellm-connector.modelIdOverride";
    private static readonly INLINE_COMPLETIONS_ENABLED_KEY = "litellm-connector.inlineCompletions.enabled";
    private static readonly INLINE_COMPLETIONS_MODEL_ID_KEY = "litellm-connector.inlineCompletions.modelId";
    private static readonly SCM_COMMIT_MSG_MODEL_ID_KEY = "litellm-connector.commitModelIdOverride";
    private static readonly ENABLE_RESPONSES_API = "litellm-connector.enableResponsesApi";

    private _telemetryService?: TelemetryService;

    constructor(private readonly secrets: vscode.SecretStorage) {}

    public setTelemetryService(service: TelemetryService): void {
        this._telemetryService = service;
    }

    private getApiKeySecretStorageKey(ref: string): string {
        // Namespace secret storage keys so we can support multiple keys in the future.
        return `${ConfigManager.API_KEY_KEY}.${ref}`;
    }

    /**
     * Retrieves the current LiteLLM configuration from secret storage.
     */
    async getConfig(): Promise<LiteLLMConfig> {
        // Base URL is stored in plain-text settings (global user settings).
        const url = vscode.workspace.getConfiguration().get<string>(ConfigManager.BASE_URL_KEY, "").trim();

        // API key is stored in SecretStorage. Settings only store a reference to which secret entry to use.
        const apiKeySecretRef = vscode.workspace
            .getConfiguration()
            .get<string>(ConfigManager.API_KEY_SECRET_REF_KEY, ConfigManager.DEFAULT_API_KEY_SECRET_REF)
            .trim();
        const key = await this.secrets.get(this.getApiKeySecretStorageKey(apiKeySecretRef));

        // Read multi-backend array from settings
        const backendsRaw = vscode.workspace
            .getConfiguration()
            .get<
                Array<{ name: string; url: string; apiKeySecretRef?: string; enabled?: boolean }>
            >(ConfigManager.BACKENDS_KEY, []);

        let backends: LiteLLMBackend[] | undefined;

        if (backendsRaw.length > 0) {
            // Multi-backend config takes precedence
            backends = backendsRaw.map((b) => ({
                name: b.name,
                url: b.url,
                apiKeySecretRef: b.apiKeySecretRef ?? b.name,
                enabled: b.enabled !== false,
            }));
        } else if (url) {
            // Legacy single-backend migration: treat as backends[0]
            backends = [
                {
                    name: "default",
                    url,
                    apiKeySecretRef: ConfigManager.DEFAULT_API_KEY_SECRET_REF,
                    enabled: true,
                },
            ];
        }

        const inactivityTimeout = vscode.workspace
            .getConfiguration()
            .get<number>(ConfigManager.INACTIVITY_TIMEOUT_KEY, 60);
        const disableCaching = vscode.workspace
            .getConfiguration()
            .get<boolean>(ConfigManager.DISABLE_CACHING_KEY, true);
        const experimentalEmitUsageData = vscode.workspace
            .getConfiguration()
            .get<boolean>(ConfigManager.EXPERIMENTAL_EMIT_USAGE_DATA_KEY, false);
        const disableQuotaToolRedaction = vscode.workspace
            .getConfiguration()
            .get<boolean>(ConfigManager.DISABLE_QUOTA_TOOL_REDACTION_KEY, false);
        const modelOverridesRaw = vscode.workspace
            .getConfiguration()
            .get<Record<string, string | string[]>>(ConfigManager.MODEL_OVERRIDES_KEY, {});

        const modelOverrides: Record<string, string[]> = {};
        if (modelOverridesRaw && typeof modelOverridesRaw === "object" && !Array.isArray(modelOverridesRaw)) {
            for (const [modelId, tagsValue] of Object.entries(modelOverridesRaw)) {
                if (Array.isArray(tagsValue)) {
                    // Legacy format: Array of tags
                    modelOverrides[modelId] = tagsValue.map(String);
                } else if (typeof tagsValue === "string") {
                    // New format: Comma-separated string (for table UI support)
                    modelOverrides[modelId] = tagsValue
                        .split(",")
                        .map((tag) => tag.trim())
                        .filter((tag) => tag.length > 0);
                }
            }
        }

        const modelCapabilitiesOverridesRaw = vscode.workspace
            .getConfiguration()
            .get<Record<string, string | string[]>>(ConfigManager.MODEL_CAPABILITIES_OVERRIDES_KEY, {});

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

        const modelIdOverride = vscode.workspace
            .getConfiguration()
            .get<string>(ConfigManager.MODEL_ID_OVERRIDE_KEY, "")
            .trim();
        const inlineCompletionsEnabled = vscode.workspace
            .getConfiguration()
            .get<boolean>(ConfigManager.INLINE_COMPLETIONS_ENABLED_KEY, false);
        const inlineCompletionsModelId = vscode.workspace
            .getConfiguration()
            .get<string>(ConfigManager.INLINE_COMPLETIONS_MODEL_ID_KEY, "")
            .trim();
        const scmGitCompletionsModelId = vscode.workspace
            .getConfiguration()
            .get<string>(ConfigManager.SCM_COMMIT_MSG_MODEL_ID_KEY, "")
            .trim();
        const v2ApiEnabled = vscode.workspace
            .getConfiguration()
            .get<boolean>(ConfigManager.ENABLE_RESPONSES_API, false);

        return {
            url,
            key: key || undefined,
            backends,
            inactivityTimeout,
            disableCaching,
            experimentalEmitUsageData,
            disableQuotaToolRedaction,
            modelOverrides,
            modelCapabilitiesOverrides,
            modelIdOverride: modelIdOverride.length > 0 ? modelIdOverride : undefined,
            inlineCompletionsEnabled,
            inlineCompletionsModelId:
                inlineCompletionsModelId.length > 0
                    ? inlineCompletionsModelId
                    : modelIdOverride.length > 0
                      ? modelIdOverride
                      : undefined,
            commitModelIdOverride: `${scmGitCompletionsModelId}`,
            v2ApiEnabled,
        };
    }

    /**
     * Stores the LiteLLM configuration in secret storage.
     */
    async setConfig(config: LiteLLMConfig): Promise<void> {
        // Base URL is stored in global user settings (plain text).
        const settings = vscode.workspace.getConfiguration();
        await settings.update(
            ConfigManager.BASE_URL_KEY,
            config.url ? config.url.trim() : "",
            vscode.ConfigurationTarget.Global
        );

        // API key is stored in SecretStorage, referenced by a stable setting.
        const apiKeySecretRef = settings
            .get<string>(ConfigManager.API_KEY_SECRET_REF_KEY, ConfigManager.DEFAULT_API_KEY_SECRET_REF)
            .trim();
        const secretKey = this.getApiKeySecretStorageKey(apiKeySecretRef);
        if (config.key) {
            await this.secrets.store(secretKey, config.key);
        } else {
            await this.secrets.delete(secretKey);
        }

        // If backends are provided, write them
        if (config.backends && config.backends.length > 0) {
            await vscode.workspace
                .getConfiguration()
                .update(ConfigManager.BACKENDS_KEY, config.backends, vscode.ConfigurationTarget.Global);
        }
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
        const toggles: Array<[string, boolean]> = [
            ["inline-completions", config.inlineCompletionsEnabled ?? false],
            ["responses-api", config.v2ApiEnabled ?? false],
            ["commit-message", !!(config.commitModelIdOverride && config.commitModelIdOverride.length > 0)],
            ["usage-data", config.experimentalEmitUsageData ?? false],
            ["caching", !config.disableCaching],
            ["quota-tool-redaction", !config.disableQuotaToolRedaction],
        ];
        for (const [name, enabled] of toggles) {
            this._telemetryService.captureFeatureToggled(name, enabled, source);
        }
    }

    /**
     * Returns all enabled backends with their API keys resolved from SecretStorage.
     * Falls back to legacy single-backend config if backends array is empty.
     */
    async resolveBackends(): Promise<ResolvedBackend[]> {
        const config = await this.getConfig();

        if (config.backends && config.backends.length > 0) {
            const resolved: ResolvedBackend[] = [];
            for (const backend of config.backends) {
                if (backend.enabled === false) {
                    continue;
                }
                const secretKey = this.getApiKeySecretStorageKey(backend.apiKeySecretRef ?? backend.name);
                const apiKey = await this.secrets.get(secretKey);
                resolved.push({
                    name: backend.name,
                    url: backend.url,
                    apiKey: apiKey ?? undefined,
                    enabled: true,
                });
            }
            return resolved;
        }

        // Legacy fallback
        if (config.url) {
            return [
                {
                    name: "default",
                    url: config.url,
                    apiKey: config.key,
                    enabled: true,
                },
            ];
        }

        return [];
    }

    /**
     * Adds a new backend to the configuration.
     */
    async addBackend(backend: LiteLLMBackend, apiKey?: string): Promise<void> {
        const existing = vscode.workspace.getConfiguration().get<Array<LiteLLMBackend>>(ConfigManager.BACKENDS_KEY, []);
        if (existing.some((b) => b.name === backend.name)) {
            throw new Error(`Backend "${backend.name}" already exists. Use updateBackend() to modify.`);
        }
        existing.push(backend);
        await vscode.workspace
            .getConfiguration()
            .update(ConfigManager.BACKENDS_KEY, existing, vscode.ConfigurationTarget.Global);

        if (apiKey) {
            const secretKey = this.getApiKeySecretStorageKey(backend.apiKeySecretRef ?? backend.name);
            await this.secrets.store(secretKey, apiKey);
        }
    }

    /**
     * Removes a backend by name.
     */
    async removeBackend(name: string): Promise<void> {
        const existing = vscode.workspace.getConfiguration().get<Array<LiteLLMBackend>>(ConfigManager.BACKENDS_KEY, []);
        const backend = existing.find((b) => b.name === name);
        if (!backend) {
            throw new Error(`Backend "${name}" not found.`);
        }
        const filtered = existing.filter((b) => b.name !== name);
        await vscode.workspace
            .getConfiguration()
            .update(ConfigManager.BACKENDS_KEY, filtered, vscode.ConfigurationTarget.Global);

        const secretKey = this.getApiKeySecretStorageKey(backend.apiKeySecretRef ?? name);
        await this.secrets.delete(secretKey);
    }

    /**
     * Updates an existing backend.
     */
    async updateBackend(name: string, updates: Partial<LiteLLMBackend>, apiKey?: string): Promise<void> {
        const existing = vscode.workspace.getConfiguration().get<Array<LiteLLMBackend>>(ConfigManager.BACKENDS_KEY, []);
        const index = existing.findIndex((b) => b.name === name);
        if (index === -1) {
            throw new Error(`Backend "${name}" not found.`);
        }
        existing[index] = { ...existing[index], ...updates };
        await vscode.workspace
            .getConfiguration()
            .update(ConfigManager.BACKENDS_KEY, existing, vscode.ConfigurationTarget.Global);

        if (apiKey !== undefined) {
            const secretKey = this.getApiKeySecretStorageKey(existing[index].apiKeySecretRef ?? name);
            if (apiKey) {
                await this.secrets.store(secretKey, apiKey);
            } else {
                await this.secrets.delete(secretKey);
            }
        }
    }

    /**
     * Lists all configured backends.
     */
    async listBackends(): Promise<LiteLLMBackend[]> {
        return vscode.workspace.getConfiguration().get<Array<LiteLLMBackend>>(ConfigManager.BACKENDS_KEY, []);
    }

    /**
     * Checks if the configuration is complete.
     */
    async isConfigured(): Promise<boolean> {
        const config = await this.getConfig();
        return (config.backends && config.backends.length > 0) || !!config.url;
    }

    /**
     * Cleans up all LiteLLM configuration data.
     * Called on uninstall/reset to remove customized settings.
     */
    async cleanupAllConfiguration(): Promise<void> {
        try {
            // Clear canonical API key secret entry
            const settings = vscode.workspace.getConfiguration();
            const apiKeySecretRef = settings
                .get<string>(ConfigManager.API_KEY_SECRET_REF_KEY, ConfigManager.DEFAULT_API_KEY_SECRET_REF)
                .trim();
            await this.secrets.delete(this.getApiKeySecretStorageKey(apiKeySecretRef));

            // Clear configuration settings
            try {
                await settings.update(ConfigManager.BASE_URL_KEY, "", vscode.ConfigurationTarget.Global);
                await settings.update(
                    ConfigManager.API_KEY_SECRET_REF_KEY,
                    undefined,
                    vscode.ConfigurationTarget.Global
                );
            } catch (err) {
                console.warn("[LiteLLM Connector] Error clearing configuration settings:", err);
            }
        } catch (err) {
            console.error("[LiteLLM Connector] Error during cleanup:", err);
        }
    }
}
