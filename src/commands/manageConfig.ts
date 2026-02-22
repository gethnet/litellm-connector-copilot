import * as vscode from "vscode";
import type { ConfigManager } from "../config/configManager";
import type { LiteLLMChatProvider } from "../providers";
import { LiteLLMClient } from "../adapters/litellmClient";

function createConfigHandler(configManager: ConfigManager, provider?: LiteLLMChatProvider) {
    return async () => {
        const config = await configManager.getConfig();

        const baseUrl = await vscode.window.showInputBox({
            title: `LiteLLM Base URL`,
            prompt: config.url
                ? "Update your LiteLLM base URL"
                : "Enter your LiteLLM base URL (e.g., http://localhost:4000 or https://api.litellm.ai)",
            ignoreFocusOut: true,
            value: config.url,
            placeHolder: "http://localhost:4000",
        });

        if (baseUrl === undefined) {
            return;
        }

        let apiKey = await vscode.window.showInputBox({
            title: `LiteLLM API Key`,
            prompt: config.key
                ? "Update your LiteLLM API key"
                : "Enter your LiteLLM API key (leave empty if not required)",
            ignoreFocusOut: true,
            password: true,
            // Show empty to avoid leaking in plain text.
            value: "",
            placeHolder: config.key ? "••••••••••••••••" : "Enter API Key",
        });

        if (apiKey === undefined) {
            return;
        }

        // If user enters the magic string, show the actual API key in plain text
        if (apiKey.trim() === "thisisunsafe" && config.key) {
            apiKey = await vscode.window.showInputBox({
                title: `LiteLLM API Key`,
                prompt: "Your API key (unmasked)",
                ignoreFocusOut: true,
                password: false,
                value: config.key,
                placeHolder: "Your API key",
            });

            if (apiKey === undefined) {
                return;
            }
        }

        // If user didn't change the value (left it blank/placeholder), keep the old key
        const newKey = apiKey.trim();
        const finalKey = newKey === "" ? config.key : newKey || undefined;

        await configManager.setConfig({
            url: baseUrl.trim(),
            key: finalKey,
        });

        // Trigger a model discovery refresh if a provider is available
        if (provider) {
            try {
                provider.clearModelCache();
                await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
            } catch (err) {
                console.error("Failed to refresh models after config change", err);
            }
        }

        vscode.window.showInformationMessage(`LiteLLM configuration saved.`);
    };
}

export function registerManageConfigCommand(
    context: vscode.ExtensionContext,
    configManager: ConfigManager,
    provider?: LiteLLMChatProvider
) {
    return vscode.commands.registerCommand("litellm-connector.manage", createConfigHandler(configManager, provider));
}

export function registerShowModelsCommand(provider: LiteLLMChatProvider) {
    return vscode.commands.registerCommand("litellm-connector.showModels", async () => {
        const models = provider.getLastKnownModels();
        if (!models.length) {
            vscode.window.showInformationMessage(
                "No cached models yet. Run 'LiteLLM: Reload Models' (or open the provider settings) to fetch models from LiteLLM."
            );
            return;
        }

        // Show a quick pick list with model ids (copy-friendly)
        const picked = await vscode.window.showQuickPick(
            models
                .slice()
                .sort((a, b) => a.id.localeCompare(b.id))
                .map((m) => ({
                    label: m.id,
                    description: m.name !== m.id ? m.name : undefined,
                    detail: m.tooltip,
                })),
            {
                title: "LiteLLM: Available Models (cached)",
                placeHolder: "Select a model id to copy to clipboard",
                matchOnDescription: true,
                matchOnDetail: true,
            }
        );

        if (!picked) {
            return;
        }

        await vscode.env.clipboard.writeText(picked.label);
        vscode.window.showInformationMessage(`Copied model id: ${picked.label}`);
    });
}

export function registerReloadModelsCommand(provider: LiteLLMChatProvider) {
    return vscode.commands.registerCommand("litellm-connector.reloadModels", async () => {
        provider.clearModelCache();
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "LiteLLM: Reloading models",
                cancellable: false,
            },
            async () => {
                // Trigger a fresh discovery request. VS Code will call discovery when it needs it,
                // but we do it proactively so completions pick up new models immediately.
                await provider.provideLanguageModelChatInformation(
                    { silent: true },
                    new vscode.CancellationTokenSource().token
                );
            }
        );

        const count = provider.getLastKnownModels().length;
        vscode.window.showInformationMessage(`LiteLLM: Reloaded ${count} models.`);
    });
}

export function registerCheckConnectionCommand(configManager: ConfigManager) {
    return vscode.commands.registerCommand("litellm-connector.checkConnection", async () => {
        const config = await configManager.getConfig();
        if (!config.url) {
            vscode.window.showErrorMessage("LiteLLM base URL not configured.");
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "LiteLLM: Checking connection",
                cancellable: true,
            },
            async (_progress, token) => {
                const client = new LiteLLMClient(config, "litellm-connector-copilot");
                try {
                    const result = await client.checkConnection(token);
                    vscode.window.showInformationMessage(
                        `LiteLLM: Connection successful! Latency: ${result.latencyMs}ms. Found ${result.modelCount} models.`
                    );
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`LiteLLM: Connection failed: ${msg}`);
                }
            }
        );
    });
}
