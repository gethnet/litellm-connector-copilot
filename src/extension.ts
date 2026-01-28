import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "./providers/liteLLMProvider";
import { ConfigManager } from "./config/configManager";
import { registerManageConfigCommand } from "./commands/manageConfig";

export function activate(context: vscode.ExtensionContext) {
	// Build a descriptive User-Agent to help quantify API usage
	const ext = vscode.extensions.getExtension("gethnet.litellm-vscode-chat");
	const extVersion = ext?.packageJSON?.version ?? "unknown";
	const vscodeVersion = vscode.version;
	// Keep UA minimal: only extension version and VS Code version
	const ua = `litellm-vscode-chat/${extVersion} VSCode/${vscodeVersion}`;

	const configManager = new ConfigManager(context.secrets);
	const provider = new LiteLLMChatModelProvider(context.secrets, ua);

	// Register the LiteLLM provider under the vendor id used in package.json
	vscode.lm.registerLanguageModelChatProvider("litellm-connector", provider);

	// Management commands to configure base URL and API key
	context.subscriptions.push(registerManageConfigCommand(context, configManager));
}

export function deactivate() {}
