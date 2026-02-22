import * as vscode from "vscode";
import type { LiteLLMProviderBase } from "../providers/liteLLMProviderBase";
import { Logger } from "../utils/logger";

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
}

/**
 * Shows a QuickPick to select a model from the available models in LiteLLM.
 * @param provider The provider to use for model discovery.
 * @param options Picker options.
 */
export async function showModelPicker(provider: LiteLLMProviderBase, options: ModelPickerOptions): Promise<void> {
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
                label: m.id,
                description: mAny.vendor || "",
                detail: mAny.tags?.join(", ") || "",
            };
        });

        // Add a "Clear" option if there's an existing selection
        const config = vscode.workspace.getConfiguration("litellm-connector");
        const currentModel = config.get<string>(options.settingKey);

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
            await config.update(options.settingKey, undefined, vscode.ConfigurationTarget.Global);
            if (options.onClear) {
                options.onClear();
            }
            vscode.window.showInformationMessage(`Model cleared for ${options.settingKey}. Feature disabled.`);
            return;
        }

        await config.update(options.settingKey, selected.label, vscode.ConfigurationTarget.Global);
        if (options.onSelect) {
            options.onSelect(selected.label);
        }
        vscode.window.showInformationMessage(`Selected model: ${selected.label}`);
    } catch (err) {
        Logger.error("Failed to show model picker", err);
        vscode.window.showErrorMessage("Failed to load models for selection.");
    }
}
