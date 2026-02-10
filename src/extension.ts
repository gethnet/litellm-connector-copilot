import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "./providers/liteLLMProvider";
import { ConfigManager } from "./config/configManager";
import {
    registerManageConfigCommand,
    registerReloadModelsCommand,
    registerShowModelsCommand,
} from "./commands/manageConfig";
import { Logger } from "./utils/logger";

// Store the config manager for cleanup on deactivation
let configManagerInstance: ConfigManager | undefined;

export function activate(context: vscode.ExtensionContext) {
    Logger.initialize(context);
    Logger.info("Activating extension...");

    let ua = "litellm-vscode-chat/unknown VSCode/unknown";
    try {
        // Build a descriptive User-Agent to help quantify API usage
        const ext = vscode.extensions.getExtension("GethNet.litellm-connector-copilot");
        Logger.debug(`Extension object found: ${!!ext}`);
        const extVersion = ext?.packageJSON?.version ?? "unknown";
        const vscodeVersion = vscode.version;
        // Keep UA minimal: only extension version and VS Code version
        ua = `litellm-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;
    } catch (uaErr) {
        Logger.error("Failed to build UA", uaErr);
    }

    Logger.info(`UA: ${ua}`);

    configManagerInstance = new ConfigManager(context.secrets);
    const configManager = configManagerInstance;
    const provider = new LiteLLMChatModelProvider(context.secrets, ua);

    // Attempt to migrate configuration from legacy secret storage to new v1.109+ provider configuration
    configManager
        .migrateToProviderConfiguration()
        .then((migrated) => {
            if (migrated) {
                Logger.info("Successfully migrated configuration to v1.109+ provider settings.");
                vscode.window.showInformationMessage(
                    "LiteLLM Connector has been updated. Your configuration has been automatically migrated to the new settings format."
                );
            }
        })
        .catch((err) => {
            Logger.error("Error during configuration migration", err);
        });

    // Register the LiteLLM provider under the vendor id used in package.json
    try {
        Logger.info("Registering LanguageModelChatProvider...");
        const registration = vscode.lm.registerLanguageModelChatProvider("litellm-connector", provider);
        if (registration) {
            context.subscriptions.push(registration);
            Logger.info("Provider registered successfully.");
        } else {
            Logger.error("registerLanguageModelChatProvider returned undefined/null");
        }
    } catch (err) {
        Logger.error("Failed to register provider", err);
    }

    // Management commands to configure base URL and API key
    try {
        context.subscriptions.push(registerManageConfigCommand(context, configManager));
        context.subscriptions.push(registerShowModelsCommand(provider));
        context.subscriptions.push(registerReloadModelsCommand(provider));
        Logger.info("Config command registered.");
    } catch (cmdErr) {
        Logger.error("Failed to register commands", cmdErr);
    }

    // Note: Configuration is now primarily handled through VS Code's Language Model provider settings UI (v1.109+).
    // The legacy management command is retained for backward compatibility.
    // Proactively check configuration and prompt user if missing
    configManager
        .isConfigured()
        .then((configured) => {
            if (!configured) {
                Logger.info("Extension not configured. Prompting user...");
                vscode.window
                    .showInformationMessage(
                        "LiteLLM Connector is not configured. Please configure your Base URL and API Key in the LiteLLM Chat Provider settings.",
                        "Open Settings"
                    )
                    .then((selection) => {
                        if (selection === "Open Settings") {
                            vscode.commands.executeCommand(
                                "workbench.action.openSettings",
                                "@provider:litellm-connector"
                            );
                        }
                    });
            }
        })
        .catch((err) => {
            Logger.error("Error checking configuration status", err);
        });
}

export async function deactivate() {
    // Clean up configuration data when extension is deactivated or uninstalled
    if (configManagerInstance) {
        try {
            Logger.info("Cleaning up LiteLLM configuration...");
            await configManagerInstance.cleanupAllConfiguration();
            Logger.info("Configuration cleanup completed.");
        } catch (err) {
            Logger.error("Error during deactivation cleanup", err);
        }
    }
}
