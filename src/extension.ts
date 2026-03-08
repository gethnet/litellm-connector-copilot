import * as vscode from "vscode";
import { LiteLLMChatProvider } from "./providers";
import { LiteLLMChatProviderV2 } from "./providers/liteLLMChatProviderV2";
import { ConfigManager } from "./config/configManager";
import {
    registerManageConfigCommand,
    registerReloadModelsCommand,
    registerShowModelsCommand,
    registerCheckConnectionCommand,
    registerResetConfigCommand,
} from "./commands/manageConfig";
import { showModelPicker } from "./commands/modelPicker";
import { registerSelectInlineCompletionModelCommand } from "./commands/inlineCompletions";
import { registerGenerateCommitMessageCommand } from "./commands/generateCommitMessage";
import { LiteLLMCommitMessageProvider } from "./providers/liteLLMCommitProvider";
import { Logger } from "./utils/logger";
import { InlineCompletionsRegistrar } from "./inlineCompletions/registerInlineCompletions";

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
    const chatProviderV1 = new LiteLLMChatProvider(context.secrets, ua);
    const chatProviderV2 = new LiteLLMChatProviderV2(context.secrets, ua);
    const commitProvider = new LiteLLMCommitMessageProvider(context.secrets, ua);

    // Register based on config
    void configManager.getConfig().then((config) => {
        const activeChatProvider = config.v2ApiEnabled ? chatProviderV2 : chatProviderV1;

        // Register the LiteLLM provider under the vendor id used in package.json
        try {
            Logger.info(`Registering LanguageModelChatProvider (V2: ${!!config.v2ApiEnabled})...`);
            const registration = vscode.lm.registerLanguageModelChatProvider(
                "litellm-connector",
                activeChatProvider as unknown as vscode.LanguageModelChatProvider
            );
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
            context.subscriptions.push(
                registerManageConfigCommand(
                    context,
                    configManager,
                    activeChatProvider as unknown as LiteLLMChatProvider
                )
            );
            context.subscriptions.push(registerShowModelsCommand(activeChatProvider as unknown as LiteLLMChatProvider));
            context.subscriptions.push(
                registerReloadModelsCommand(activeChatProvider as unknown as LiteLLMChatProvider)
            );
            context.subscriptions.push(registerCheckConnectionCommand(configManager));
            context.subscriptions.push(
                registerResetConfigCommand(configManager, activeChatProvider as unknown as LiteLLMChatProvider)
            );
            context.subscriptions.push(
                registerSelectInlineCompletionModelCommand(activeChatProvider as unknown as LiteLLMChatProvider)
            );
            context.subscriptions.push(registerGenerateCommitMessageCommand(commitProvider));
            context.subscriptions.push(
                vscode.commands.registerCommand("litellm-connector.generateCommitMessage.selectModel", async () => {
                    await showModelPicker(commitProvider, {
                        title: "Select Commit Message Model",
                        settingKey: "commitModelIdOverride",
                    });
                })
            );
            Logger.info("Config command registered.");
        } catch (cmdErr) {
            Logger.error("Failed to register commands", cmdErr);
        }
    });

    // Stable inline completions (optional; disabled by default)
    const inlineRegistrar = new InlineCompletionsRegistrar(context.secrets, ua, context);
    inlineRegistrar.initialize();
    context.subscriptions.push(inlineRegistrar);

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
                        "LiteLLM Connector is not configured. Configure your Base URL and API Key to continue.",
                        "Configure"
                    )
                    .then((selection) => {
                        if (selection === "Configure") {
                            // Use the classic configuration flow (reliable for model discovery).
                            vscode.commands.executeCommand("litellm-connector.manage");
                        }
                    });
            }
        })
        .catch((err) => {
            Logger.error("Error checking configuration status", err);
        });
}

export async function deactivate() {
    // Intentionally do not clear user configuration on deactivate.
    // Users expect provider settings and secrets to persist across reloads.
}
