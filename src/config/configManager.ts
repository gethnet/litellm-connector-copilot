import * as vscode from "vscode";
import type { LiteLLMBackend, LiteLLMConfig, ModelOverride, ResolvedBackend } from "../types";
import type { TelemetryService } from "../telemetry/telemetryService";
import { LiteLLMClient } from "../adapters/litellmClient";
import type { BackendSession } from "../providers/backendSession";
import { Logger } from "../utils/logger";
import { loadUserOverrides } from "./modelOverrides";

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
    private static readonly MODEL_CAPABILITIES_OVERRIDES_KEY = "litellm-connector.modelCapabilitiesOverrides";
    private static readonly MODEL_ID_OVERRIDE_KEY = "litellm-connector.modelIdOverride";
    private static readonly INLINE_COMPLETIONS_ENABLED_KEY = "litellm-connector.inlineCompletions.enabled";
    private static readonly INLINE_COMPLETIONS_MODEL_ID_KEY = "litellm-connector.inlineCompletions.modelId";
    private static readonly SCM_COMMIT_MSG_MODEL_ID_KEY = "litellm-connector.commitModelIdOverride";
    private static readonly ENABLE_RESPONSES_API = "litellm-connector.enableResponsesApi";

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
        const workspaceConfig = vscode.workspace.getConfiguration();

        // Base URL is stored in plain-text settings (global user settings).
        const url = workspaceConfig.get<string>(ConfigManager.BASE_URL_KEY, "").trim();

        // API key is stored in SecretStorage. Settings only store a reference to which secret entry to use.
        const apiKeySecretRef = workspaceConfig.get<string>(
            ConfigManager.API_KEY_SECRET_REF_KEY,
            ConfigManager.DEFAULT_API_KEY_SECRET_REF
        );
        const key = await this.secrets.get(this.getApiKeySecretStorageKey(apiKeySecretRef?.trim() ?? ""));

        // Read multi-backend array from settings
        const backendsRaw = workspaceConfig.get<
            { name: string; url: string; apiKeySecretRef?: string; enabled?: boolean }[]
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
            // OBSOLETE LEGACY PATH — remove in VS Code 1.125.
            // Legacy single-backend migration: pre-1.119 users stored a single backend as
            // top-level `litellm-connector.url` + `litellm-connector.key`. We promote that
            // shape to a single-element backends[] so the rest of the pipeline can treat
            // it uniformly. Once the minimum supported VS Code is >= 1.125, delete this
            // branch (and the BASE_URL_KEY / API_KEY_KEY handling it depends on).
            backends = [
                {
                    name: "default",
                    url,
                    apiKeySecretRef: ConfigManager.DEFAULT_API_KEY_SECRET_REF,
                    enabled: true,
                },
            ];
        }

        const inactivityTimeout = workspaceConfig.get<number>(ConfigManager.INACTIVITY_TIMEOUT_KEY, 60);
        const disableCaching = workspaceConfig.get<boolean>(ConfigManager.DISABLE_CACHING_KEY, true);
        const experimentalEmitUsageData = workspaceConfig.get<boolean>(
            ConfigManager.EXPERIMENTAL_EMIT_USAGE_DATA_KEY,
            false
        );
        const disableQuotaToolRedaction = workspaceConfig.get<boolean>(
            ConfigManager.DISABLE_QUOTA_TOOL_REDACTION_KEY,
            false
        );
        // Drop undefined/neutral fields so shape matches expectations
        const modelOverrides: ModelOverride[] = loadUserOverrides(workspaceConfig).map((o) => {
            const cleaned: ModelOverride = { match: o.match, notes: o.notes }; // preserve notes field even if undefined
            if (o.supportsReasoning !== undefined) cleaned.supportsReasoning = o.supportsReasoning;
            if (o.reasoningEfforts) cleaned.reasoningEfforts = o.reasoningEfforts;
            if (o.defaultEffort) cleaned.defaultEffort = o.defaultEffort;
            if (o.forceMandatory) cleaned.forceMandatory = o.forceMandatory;
            if (o.tags && o.tags.length > 0) cleaned.tags = o.tags;
            if (o.supportedOpenaiParams && o.supportedOpenaiParams.length > 0) {
                cleaned.supportedOpenaiParams = o.supportedOpenaiParams;
            }
            return cleaned;
        });

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
        const inlineCompletionsEnabled = workspaceConfig.get<boolean>(
            ConfigManager.INLINE_COMPLETIONS_ENABLED_KEY,
            false
        );
        const inlineCompletionsModelId = workspaceConfig.get<string>(ConfigManager.INLINE_COMPLETIONS_MODEL_ID_KEY, "");
        const scmGitCompletionsModelId = workspaceConfig
            .get<string>(ConfigManager.SCM_COMMIT_MSG_MODEL_ID_KEY, "")
            .trim();
        const v2ApiEnabled = workspaceConfig.get<boolean>(ConfigManager.ENABLE_RESPONSES_API, false);

        const trimmedInlineModelId = inlineCompletionsModelId?.trim() ?? "";

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
                trimmedInlineModelId.length > 0
                    ? trimmedInlineModelId
                    : modelIdOverride.length > 0
                      ? modelIdOverride
                      : undefined,
            commitModelIdOverride: `${scmGitCompletionsModelId}`,
            v2ApiEnabled,
            enableResponses: v2ApiEnabled,
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
        const toggles: [string, boolean][] = [
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
     *
     * @deprecated OBSOLETE — scheduled for removal in VS Code 1.125. The legacy
     * workspace-settings backends path (`litellm-connector.backends`,
     * `litellm-connector.url`/`litellm-connector.key`) is preserved only for users
     * upgrading from pre-1.119 VS Code. New code paths must use the per-group
     * configuration delivered via `options.configuration` in the VS Code 1.120
     * Language Model Chat Provider API. When the minimum supported VS Code is
     * raised to >= 1.125, delete this method and all of its call sites.
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
     * Converts VS Code per-group provider configuration into a BackendSession.
     * Required fields: baseUrl (http/https), apiKey.
     *
     * `providerName` is optional because VS Code group-based configuration already
     * carries the user-entered group name separately as `groupName`.
     */
    convertProviderConfiguration(
        groupName: string,
        configuration: Record<string, unknown>
    ): BackendSession | undefined {
        const providerNameFromConfig =
            typeof configuration.providerName === "string" ? configuration.providerName.trim() : "";
        const providerName = providerNameFromConfig || groupName.trim();
        const baseUrl = typeof configuration.baseUrl === "string" ? configuration.baseUrl.trim() : "";
        const apiKey = typeof configuration.apiKey === "string" ? configuration.apiKey.trim() : "";

        if (!providerName) {
            Logger.debug("convertProviderConfiguration: missing providerName and groupName");
            return undefined;
        }

        if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
            Logger.debug("convertProviderConfiguration: baseUrl must start with http:// or https://");
            return undefined;
        }

        if (!apiKey) {
            Logger.debug("convertProviderConfiguration: missing apiKey in configuration");
            return undefined;
        }

        const userAgent = "litellm-vscode-chat/vscode-1.120+";
        return {
            backendName: providerName,
            baseUrl,
            apiKey,
            client: new LiteLLMClient({ url: baseUrl, key: apiKey }, userAgent),
        };
    }

    /**
     * Adds a new backend to the configuration.
     */
    async addBackend(backend: LiteLLMBackend, apiKey?: string): Promise<void> {
        const existing = vscode.workspace.getConfiguration().get<LiteLLMBackend[]>(ConfigManager.BACKENDS_KEY, []);
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
        const existing = vscode.workspace.getConfiguration().get<LiteLLMBackend[]>(ConfigManager.BACKENDS_KEY, []);
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
        const existing = vscode.workspace.getConfiguration().get<LiteLLMBackend[]>(ConfigManager.BACKENDS_KEY, []);
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
        return vscode.workspace.getConfiguration().get<LiteLLMBackend[]>(ConfigManager.BACKENDS_KEY, []);
    }

    /**
     * Checks if the configuration is complete.
     */
    async isConfigured(): Promise<boolean> {
        const config = await this.getConfig();
        return (config.backends && config.backends.length > 0) || !!config.url;
    }

    /**
     * Dispose hook to align with ExtensionContext subscription lifecycle.
     * Currently a no-op because ConfigManager does not hold disposable resources.
     */
    async dispose(): Promise<void> {
        this._telemetryService = undefined;
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
