import * as vscode from "vscode";
import type { ConfigManager } from "../config/configManager";
import type { LiteLLMChatProvider } from "../providers";
import type { TelemetryService } from "../telemetry/telemetryService";
import { MultiBackendClient } from "../adapters/multiBackendClient";

function createConfigHandler(
    _configManager: ConfigManager,
    _provider?: LiteLLMChatProvider,
    _telemetryService?: TelemetryService
) {
    return async (): Promise<void> => {
        const openLanguageModels = "Open Language Models";
        const choice = await vscode.window.showInformationMessage(
            "LiteLLM Connector is now configured through VS Code's Language Models view. " +
                'Use "Add Model..." to add or edit a LiteLLM provider.',
            openLanguageModels
        );

        if (choice !== openLanguageModels) {
            return;
        }

        try {
            await vscode.commands.executeCommand("workbench.action.chat.manage");
        } catch {
            // Fallback for builds where the chat management command is unavailable.
            await vscode.commands.executeCommand("workbench.action.openSettings", "@tag:language-model");
        }
    };
}

export function registerManageConfigCommand(
    context: vscode.ExtensionContext,
    configManager: ConfigManager,
    provider?: LiteLLMChatProvider,
    telemetryService?: TelemetryService
): vscode.Disposable {
    return vscode.commands.registerCommand(
        "litellm-connector.manage",
        createConfigHandler(configManager, provider, telemetryService)
    );
}

export function registerShowModelsCommand(
    provider: LiteLLMChatProvider,
    telemetryService?: TelemetryService
): vscode.Disposable {
    return vscode.commands.registerCommand("litellm-connector.showModels", async () => {
        if (telemetryService) {
            telemetryService.captureCommandExecuted("litellm-connector.showModels");
        }
        const models = provider.getLastKnownModels();
        if (!models.length) {
            vscode.window.showInformationMessage(
                "No cached models yet. Run 'LiteLLM: Reload Models' (or open the provider settings) to fetch models from LiteLLM."
            );
            return;
        }

        type ModelQuickPickItem = vscode.QuickPickItem & { modelId: string };

        // Show a quick pick list with user-facing backend:model label.
        // Copy the internal routable model id to the clipboard.
        const picked = await vscode.window.showQuickPick(
            models
                .slice()
                .sort((a: vscode.LanguageModelChatInformation, b: vscode.LanguageModelChatInformation) =>
                    a.id.localeCompare(b.id)
                )
                .map((m) => ({
                    label: m.name,
                    description: m.name !== m.id ? m.name : undefined,
                    detail: m.tooltip,
                    modelId: m.id,
                })) as ModelQuickPickItem[],
            {
                title: "LiteLLM: Available Models (cached)",
                placeHolder: "Select a model to copy its id to clipboard",
                matchOnDescription: true,
                matchOnDetail: true,
            }
        );

        if (!picked) {
            return;
        }

        await vscode.env.clipboard.writeText(picked.modelId);
        vscode.window.showInformationMessage(`Copied model id: ${picked.modelId}`);
    });
}

export function registerReloadModelsCommand(
    provider: LiteLLMChatProvider,
    telemetryService?: TelemetryService
): vscode.Disposable {
    return vscode.commands.registerCommand("litellm-connector.reloadModels", async () => {
        if (telemetryService) {
            telemetryService.captureCommandExecuted("litellm-connector.reloadModels");
        }
        provider.clearModelCache();
        try {
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
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(`LiteLLM: Model reload failed: ${msg}`);
        }
    });
}

export function registerCheckConnectionCommand(
    configManager: ConfigManager,
    telemetryService?: TelemetryService
): vscode.Disposable {
    return vscode.commands.registerCommand("litellm-connector.checkConnection", async () => {
        if (telemetryService) {
            telemetryService.captureCommandExecuted("litellm-connector.checkConnection");
        }
        const backends = await configManager.resolveBackends();
        if (backends.length === 0) {
            vscode.window.showWarningMessage("No enabled backends configured.");
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "LiteLLM: Checking connections",
                cancellable: true,
            },
            async (_progress, token) => {
                const multiClient = new MultiBackendClient(backends, "litellm-connector-copilot");
                try {
                    const results = await multiClient.checkConnectionAll(token);
                    const successCount = results.filter((r) => !r.error).length;
                    const details = results
                        .map(
                            (r) => `${r.backendName}: ${r.error ? `$(error) ${r.error}` : `$(check) ${r.latencyMs}ms`}`
                        )
                        .join("\n");

                    if (successCount === results.length) {
                        vscode.window.showInformationMessage(`LiteLLM: All ${results.length} connections successful!`);
                    } else {
                        vscode.window.showWarningMessage(
                            `LiteLLM: ${successCount}/${results.length} connections successful.\n\n${details}`
                        );
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`LiteLLM: Connection check failed: ${msg}`);
                }
            }
        );
    });
}

// Legacy management commands removed; configuration now uses VS Code Language Models UI.
