import * as vscode from "vscode";
import type { LiteLLMProviderBase } from "../providers/liteLLMProviderBase";
import { Logger } from "../utils/logger";
import type { TelemetryService } from "../telemetry/telemetryService";

/**
 * Options for the model picker.
 */
export interface ModelPickerOptions {
    /**
     * The title of the picker.
     */
    title: string;
    /**
     * The setting key to update when a model is selected.
     */
    settingKey: string;
    /**
     * Optional callback when a model is selected.
     */
    onSelect?: (modelId: string) => void;
    /**
     * Optional callback when the selection is cleared.
     */
    onClear?: () => void;
    /**
     * Optional telemetry service.
     */
    telemetryService?: TelemetryService;
    /**
     * Optional caller context for telemetry.
     */
    caller?: string;
}

/**
 * Shows a QuickPick to select a model from the available models in LiteLLM.
 * @param provider The provider to use for model discovery.
 * @param options Picker options.
 */
export async function showModelPicker(provider: LiteLLMProviderBase, options: ModelPickerOptions): Promise<void> {
    if (options.telemetryService) {
        options.telemetryService.captureModelPickerOpened(options.caller || "unknown");
        options.telemetryService.captureFeatureUsed("model-picker", options.caller || "unknown");
    }
    try {
        // Ensure models are discovered
        const models = await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        if (models.length === 0) {
            vscode.window.showWarningMessage("No models available in LiteLLM. Please check your connection.");
            return;
        }

        const items: vscode.QuickPickItem[] = models.map((m) => {
            const mAny = m as unknown as { vendor?: string; tags?: string[] };
            return {
                label: m.name,
                // Keep routing value as the internal VS Code model id.
                // QuickPickItem has no separate value field, so we encode it in the description.
                // Instead, we update later by selecting label -> id mapping.
                description: mAny.vendor || "",
                detail: mAny.tags?.join(", ") || "",
            };
        });

        // Add a "Clear" option if there's an existing selection
        const config = await provider.getConfigManager().getConfig();
        const currentModel = config[options.settingKey as keyof typeof config] as string | undefined;

        if (currentModel) {
            items.unshift({
                label: "$(clear-all) Clear Selection",
                description: "Disable this feature",
                alwaysShow: true,
            });
        }

        const selected = await vscode.window.showQuickPick(items, {
            title: options.title,
            placeHolder: "Select a model to use...",
        });

        if (!selected) {
            return;
        }

        if (selected.label === "$(clear-all) Clear Selection") {
            await vscode.workspace
                .getConfiguration("litellm-connector")
                .update(options.settingKey, undefined, vscode.ConfigurationTarget.Global);
            if (options.telemetryService) {
                options.telemetryService.captureConfigChanged(options.settingKey, "model-picker-clear");
            }
            if (options.onClear) {
                options.onClear();
            }
            vscode.window.showInformationMessage(`Model cleared for ${options.settingKey}. Feature disabled.`);
            return;
        }

        const selectedId = models.find((m) => m.name === selected.label)?.id;
        if (!selectedId) {
            vscode.window.showErrorMessage("Selected model could not be resolved.");
            return;
        }

        await vscode.workspace
            .getConfiguration("litellm-connector")
            .update(options.settingKey, selectedId, vscode.ConfigurationTarget.Global);
        if (options.telemetryService) {
            options.telemetryService.captureConfigChanged(options.settingKey, "model-picker-select");
        }
        if (options.onSelect) {
            options.onSelect(selectedId);
        }
        vscode.window.showInformationMessage(`Selected model: ${selectedId}`);
    } catch (err) {
        Logger.error("Failed to show model picker", err);
        vscode.window.showErrorMessage("Failed to load models for selection.");
    }
}
