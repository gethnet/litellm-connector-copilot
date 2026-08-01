import * as vscode from "vscode";
import type { ConfigManager } from "../config/configManager";
import type { LiteLLMChatProvider } from "../providers";
import type { TelemetryService } from "../telemetry/telemetryService";
import { Logger } from "../utils/logger";

type ModelQuickPickItem = vscode.QuickPickItem & { modelId: string };

const MODEL_SELECTOR = "litellm-connector/";

function toSelectableModelId(modelId: string): string {
    return modelId.startsWith(MODEL_SELECTOR) ? modelId : `${MODEL_SELECTOR}${modelId}`;
}

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

/**
 * Creates the handler for the reset configuration command.
 * Shows a confirmation dialog before wiping all configuration.
 */
function createResetConfigurationHandler(
    configManager: ConfigManager,
    _telemetryService?: TelemetryService
): () => Promise<void> {
    return async (): Promise<void> => {
        // Show confirmation dialog
        const reset = "Reset Configuration";
        const cancel = "Cancel";

        const choice = await vscode.window.showWarningMessage(
            "This will remove all LiteLLM provider groups, API keys, and settings. " +
                "You will need to re-configure the extension from scratch.",
            { modal: true },
            reset,
            cancel
        );

        if (choice !== reset) {
            Logger.info("Reset configuration cancelled by user");
            return;
        }

        Logger.info("User confirmed reset configuration");

        try {
            await configManager.resetConfiguration();

            await vscode.window.showInformationMessage(
                "LiteLLM configuration has been reset. " +
                    "Use 'LiteLLM: Manage Configuration' to re-configure providers."
            );

            Logger.info("Configuration reset completed successfully");
        } catch (err: unknown) {
            Logger.error("Configuration reset failed", err);

            await vscode.window.showErrorMessage(
                `Failed to reset configuration: ${err instanceof Error ? err.message : String(err)}`
            );
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
                "No models are available yet. Configure a LiteLLM provider with 'LiteLLM: Manage Configuration', then run 'LiteLLM: Reload Models' before opening this picker."
            );
            return;
        }

        // Keep the picker to the requested two-line layout. The model group and
        // friendly name are the primary label; the complete ID is the secondary
        // description. Existing model tooltip data remains in `detail` so the
        // picker can surface provider pricing and limits without rebuilding it.
        const picked = await vscode.window.showQuickPick(
            models
                .slice()
                .sort((a: vscode.LanguageModelChatInformation, b: vscode.LanguageModelChatInformation) =>
                    a.id.localeCompare(b.id)
                )
                .map((m) => {
                    const selectableModelId = toSelectableModelId(m.id);
                    return {
                        label: `${
                            (m as vscode.LanguageModelChatInformation & { backendName?: string }).backendName ??
                            "LiteLLM"
                        } :: ${m.name}`,
                        description: selectableModelId,
                        detail: m.tooltip,
                        modelId: selectableModelId,
                    };
                }) as ModelQuickPickItem[],
            {
                title: "LiteLLM: Available Models",
                placeHolder: "Select a model to copy its fully qualified id to the clipboard",
                matchOnDescription: true,
                matchOnDetail: true,
            }
        );

        if (!picked) {
            return;
        }

        await vscode.env.clipboard.writeText(picked.modelId);
        vscode.window.showInformationMessage(`Copied fully qualified model id: ${picked.modelId}`);
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

export function registerResetConfigurationCommand(
    context: vscode.ExtensionContext,
    configManager: ConfigManager,
    telemetryService?: TelemetryService
): vscode.Disposable {
    return vscode.commands.registerCommand(
        "litellm-connector.resetConfiguration",
        createResetConfigurationHandler(configManager, telemetryService)
    );
}
