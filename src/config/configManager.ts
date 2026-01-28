import * as vscode from "vscode";
import { LiteLLMConfig } from "../types";

export class ConfigManager {
	private static readonly BASE_URL_KEY = "litellm-connector.baseUrl";
	private static readonly API_KEY_KEY = "litellm-connector.apiKey";

	constructor(private readonly secrets: vscode.SecretStorage) {}

	/**
	 * Retrieves the current LiteLLM configuration from secret storage.
	 */
	async getConfig(): Promise<LiteLLMConfig> {
		const url = await this.secrets.get(ConfigManager.BASE_URL_KEY);
		const key = await this.secrets.get(ConfigManager.API_KEY_KEY);
		return {
			url: url || "",
			key: key || undefined,
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
