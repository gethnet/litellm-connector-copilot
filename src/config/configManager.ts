import * as vscode from "vscode";
import { LiteLLMConfig } from "../types";

export class ConfigManager {
	private static readonly BASE_URL_KEY = "litellm-connector.baseUrl";
	private static readonly API_KEY_KEY = "litellm-connector.apiKey";
	private static readonly INACTIVITY_TIMEOUT_KEY = "litellm-connector.inactivityTimeout";
	private static readonly DISABLE_CACHING_KEY = "litellm-connector.disableCaching";

	constructor(private readonly secrets: vscode.SecretStorage) {}

	/**
	 * Retrieves the current LiteLLM configuration from secret storage.
	 */
	async getConfig(): Promise<LiteLLMConfig> {
		const url = await this.secrets.get(ConfigManager.BASE_URL_KEY);
		const key = await this.secrets.get(ConfigManager.API_KEY_KEY);
		const inactivityTimeout = vscode.workspace.getConfiguration().get<number>(ConfigManager.INACTIVITY_TIMEOUT_KEY, 60);
		const disableCaching = vscode.workspace.getConfiguration().get<boolean>(ConfigManager.DISABLE_CACHING_KEY, true);

		return {
			url: url || "",
			key: key || undefined,
			inactivityTimeout,
			disableCaching,
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
}
