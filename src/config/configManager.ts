import * as vscode from "vscode";
import type { LiteLLMConfig } from "../types";

export class ConfigManager {
    private static readonly BASE_URL_KEY = "litellm-connector.baseUrl";
    private static readonly API_KEY_KEY = "litellm-connector.apiKey";
    private static readonly API_KEY_SECRET_REF_KEY = "litellm-connector.apiKeySecretRef";
    private static readonly DEFAULT_API_KEY_SECRET_REF = "default";
    private static readonly INACTIVITY_TIMEOUT_KEY = "litellm-connector.inactivityTimeout";
    private static readonly DISABLE_CACHING_KEY = "litellm-connector.disableCaching";
    private static readonly EXPERIMENTAL_EMIT_USAGE_DATA_KEY = "litellm-connector.experimentalEmitUsageData";
    private static readonly DISABLE_QUOTA_TOOL_REDACTION_KEY = "litellm-connector.disableQuotaToolRedaction";
    private static readonly MODEL_OVERRIDES_KEY = "litellm-connector.modelOverrides";
    private static readonly MODEL_ID_OVERRIDE_KEY = "litellm-connector.modelIdOverride";
    private static readonly INLINE_COMPLETIONS_ENABLED_KEY = "litellm-connector.inlineCompletions.enabled";
    private static readonly INLINE_COMPLETIONS_MODEL_ID_KEY = "litellm-connector.inlineCompletions.modelId";
    private static readonly SCM_COMMIT_MSG_MODEL_ID_KEY = "litellm-connector.commitModelIdOverride";
    constructor(private readonly secrets: vscode.SecretStorage) {}

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
        const modelOverrides = vscode.workspace
            .getConfiguration()
            .get<Record<string, string[]>>(ConfigManager.MODEL_OVERRIDES_KEY, {});
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
        return {
            url,
            key: key || undefined,
            inactivityTimeout,
            disableCaching,
            experimentalEmitUsageData,
            disableQuotaToolRedaction,
            modelOverrides,
            modelIdOverride: modelIdOverride.length > 0 ? modelIdOverride : undefined,
            inlineCompletionsEnabled,
            inlineCompletionsModelId:
                inlineCompletionsModelId.length > 0
                    ? inlineCompletionsModelId
                    : modelIdOverride.length > 0
                      ? modelIdOverride
                      : undefined,
            commitModelIdOverride: `${scmGitCompletionsModelId}`,
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
    }

    /**
     * Checks if the configuration is complete.
     */
    async isConfigured(): Promise<boolean> {
        const config = await this.getConfig();
        return !!config.url;
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
