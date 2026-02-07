import * as vscode from "vscode";
import { ConfigManager } from "../config/configManager";

function createConfigHandler(configManager: ConfigManager) {
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

        vscode.window.showInformationMessage(`LiteLLM configuration saved.`);
    };
}

export function registerManageConfigCommand(context: vscode.ExtensionContext, configManager: ConfigManager) {
    return vscode.commands.registerCommand("litellm-connector.manage", createConfigHandler(configManager));
}
