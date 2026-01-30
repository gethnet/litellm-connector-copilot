import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "./providers/liteLLMProvider";
import { ConfigManager } from "./config/configManager";
import { registerManageConfigCommand } from "./commands/manageConfig";

export function activate(context: vscode.ExtensionContext) {
	console.log("[LiteLLM Connector] Activating extension...");

	let ua = "litellm-vscode-chat/unknown VSCode/unknown";
	try {
		// Build a descriptive User-Agent to help quantify API usage
		const ext = vscode.extensions.getExtension("GethNet.litellm-connector-copilot");
		console.log(`[LiteLLM Connector] Extension object found: ${!!ext}`);
		const extVersion = ext?.packageJSON?.version ?? "unknown";
		const vscodeVersion = vscode.version;
		// Keep UA minimal: only extension version and VS Code version
		ua = `litellm-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;
	} catch (uaErr) {
		console.error("[LiteLLM Connector] Failed to build UA", uaErr);
	}

	console.log(`[LiteLLM Connector] UA: ${ua}`);

	const configManager = new ConfigManager(context.secrets);
	const provider = new LiteLLMChatModelProvider(context.secrets, ua);

	// Register the LiteLLM provider under the vendor id used in package.json
	try {
		console.log("[LiteLLM Connector] Registering LanguageModelChatProvider...");
		const registration = vscode.lm.registerLanguageModelChatProvider("litellm-connector", provider);
		if (registration) {
			context.subscriptions.push(registration);
			console.log("[LiteLLM Connector] Provider registered successfully.");
		} else {
			console.error("[LiteLLM Connector] registerLanguageModelChatProvider returned undefined/null");
		}
	} catch (err) {
		console.error("[LiteLLM Connector] Failed to register provider", err);
	}

	// Management commands to configure base URL and API key
	try {
		context.subscriptions.push(registerManageConfigCommand(context, configManager));
		console.log("[LiteLLM Connector] Config command registered.");
	} catch (cmdErr) {
		console.error("[LiteLLM Connector] Failed to register commands", cmdErr);
	}

	// Proactively check configuration and prompt user if missing
	configManager
		.isConfigured()
		.then((configured) => {
			if (!configured) {
				console.log("[LiteLLM Connector] Extension not configured. Prompting user...");
				vscode.window
					.showInformationMessage(
						"LiteLLM Connector is not configured. Please set your Base URL to enable LiteLLM models in Copilot.",
						"Configure Now"
					)
					.then((selection) => {
						if (selection === "Configure Now") {
							vscode.commands.executeCommand("litellm-connector.manage");
						}
					});
			}
		})
		.catch((err) => {
			console.error("[LiteLLM Connector] Error checking configuration status", err);
		});
}

export function deactivate() {}
