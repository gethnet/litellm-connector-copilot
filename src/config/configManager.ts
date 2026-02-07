import * as vscode from "vscode";
import { LiteLLMConfig } from "../types";

export class ConfigManager {
    private static readonly BASE_URL_KEY = "litellm-connector.baseUrl";
    private static readonly API_KEY_KEY = "litellm-connector.apiKey";
    private static readonly INACTIVITY_TIMEOUT_KEY = "litellm-connector.inactivityTimeout";
    private static readonly DISABLE_CACHING_KEY = "litellm-connector.disableCaching";
    private static readonly DISABLE_QUOTA_TOOL_REDACTION_KEY = "litellm-connector.disableQuotaToolRedaction";
    private static readonly MIGRATION_MARKER_KEY = "litellm-connector.migrated-to-v1.109";

    constructor(private readonly secrets: vscode.SecretStorage) {}

    /**
     * Retrieves the current LiteLLM configuration from secret storage.
     */
    async getConfig(): Promise<LiteLLMConfig> {
        const url = await this.secrets.get(ConfigManager.BASE_URL_KEY);
        const key = await this.secrets.get(ConfigManager.API_KEY_KEY);
        const inactivityTimeout = vscode.workspace
            .getConfiguration()
            .get<number>(ConfigManager.INACTIVITY_TIMEOUT_KEY, 60);
        const disableCaching = vscode.workspace
            .getConfiguration()
            .get<boolean>(ConfigManager.DISABLE_CACHING_KEY, true);
        const disableQuotaToolRedaction = vscode.workspace
            .getConfiguration()
            .get<boolean>(ConfigManager.DISABLE_QUOTA_TOOL_REDACTION_KEY, false);

        return {
            url: url || "",
            key: key || undefined,
            inactivityTimeout,
            disableCaching,
            disableQuotaToolRedaction,
        };
    }

    /**
     * Stores the LiteLLM configuration in secret storage.
     */
    async setConfig(config: LiteLLMConfig): Promise<void> {
        if (config.url) {
            await this.secrets.store(ConfigManager.BASE_URL_KEY, config.url);
        } else {
            await this.secrets.delete(ConfigManager.BASE_URL_KEY);
        }

        if (config.key) {
            await this.secrets.store(ConfigManager.API_KEY_KEY, config.key);
        } else {
            await this.secrets.delete(ConfigManager.API_KEY_KEY);
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
     * Converts VS Code's language model configuration to internal LiteLLMConfig format.
     * This is used when the provider receives configuration from the new v1.109+ API.
     * @param configuration The configuration object from the language model provider
     * @returns The converted LiteLLMConfig
     */
    convertProviderConfiguration(configuration: Record<string, unknown>): LiteLLMConfig {
        const baseUrl = (configuration.baseUrl as string) || "";
        const apiKey = (configuration.apiKey as string) || undefined;
        const inactivityTimeout = vscode.workspace
            .getConfiguration()
            .get<number>(ConfigManager.INACTIVITY_TIMEOUT_KEY, 60);
        const disableCaching = vscode.workspace
            .getConfiguration()
            .get<boolean>(ConfigManager.DISABLE_CACHING_KEY, true);
        const disableQuotaToolRedaction = vscode.workspace
            .getConfiguration()
            .get<boolean>(ConfigManager.DISABLE_QUOTA_TOOL_REDACTION_KEY, false);

        return {
            url: baseUrl,
            key: apiKey,
            inactivityTimeout,
            disableCaching,
            disableQuotaToolRedaction,
        };
    }

    /**
     * Migrates configuration from legacy secret storage to the new v1.109+ provider configuration.
     * This ensures users with existing configuration don't need to reconfigure after the update.
     * After successful migration, clears the old secret storage data.
     * @returns true if migration was successful, false if no migration was needed
     */
    async migrateToProviderConfiguration(): Promise<boolean> {
        try {
            // Fast path: Check if migration has already been done
            const migrationDone = await this.secrets.get(ConfigManager.MIGRATION_MARKER_KEY);
            if (migrationDone) {
                // Migration already completed, skip all processing
                return false;
            }

            // Check if there's existing configuration in secret storage
            const existingConfig = await this.getConfig();
            if (!existingConfig.url) {
                // No existing configuration to migrate, mark as done anyway to avoid re-checking
                await this.secrets.store(ConfigManager.MIGRATION_MARKER_KEY, "true");
                return false;
            }

            // Get the workspace configuration for language model chat provider settings
            const config = vscode.workspace.getConfiguration("litellm-connector");

            // Only perform migration if provider configuration is not already set
            const hasProviderConfig = config.has("baseUrl") && config.get("baseUrl");
            if (hasProviderConfig) {
                // Provider configuration already exists, just mark migration as done
                await this.secrets.store(ConfigManager.MIGRATION_MARKER_KEY, "true");
                return false;
            }

            // Migrate the configuration to workspace settings
            // Note: We update the workspace settings that correspond to the provider configuration
            await config.update("baseUrl", existingConfig.url, vscode.ConfigurationTarget.Global);
            if (existingConfig.key) {
                await config.update("apiKey", existingConfig.key, vscode.ConfigurationTarget.Global);
            }

            // Mark migration as completed
            await this.secrets.store(ConfigManager.MIGRATION_MARKER_KEY, "true");

            // Clear old configuration data from secret storage
            await this.clearLegacySecrets();

            return true;
        } catch (err) {
            // Log but don't throw - migration failure shouldn't break the extension
            console.error("[LiteLLM Connector] Migration error:", err);
            return false;
        }
    }

    /**
     * Clears legacy configuration data from secret storage.
     * This performs housekeeping after migration to v1.109+ provider configuration.
     */
    private async clearLegacySecrets(): Promise<void> {
        try {
            await this.secrets.delete(ConfigManager.BASE_URL_KEY);
            await this.secrets.delete(ConfigManager.API_KEY_KEY);
        } catch (err) {
            // Log but don't throw - clearing old data shouldn't break anything
            console.warn("[LiteLLM Connector] Error clearing legacy secrets:", err);
        }
    }

    /**
     * Cleans up all LiteLLM configuration data (both legacy and new).
     * Called on extension deactivation/uninstall to remove customized settings.
     */
    async cleanupAllConfiguration(): Promise<void> {
        try {
            // Clear secret storage
            await this.clearLegacySecrets();
            await this.secrets.delete(ConfigManager.MIGRATION_MARKER_KEY);

            // Clear workspace configuration
            const config = vscode.workspace.getConfiguration("litellm-connector");
            try {
                await config.update("baseUrl", undefined, vscode.ConfigurationTarget.Global);
                await config.update("apiKey", undefined, vscode.ConfigurationTarget.Global);
            } catch (err) {
                // If workspace config updates fail, log but continue
                console.warn("[LiteLLM Connector] Error clearing workspace configuration:", err);
            }
        } catch (err) {
            console.error("[LiteLLM Connector] Error during cleanup:", err);
        }
    }
}
