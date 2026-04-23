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

        /**
         * Extracts the backend name from a model's tooltip without fragile regex.
         * Tooltip format: "Provider:model contributed by BACKEND_NAME via Extension Name"
         * Returns the BACKEND_NAME, or fallback to vendor if available.
         */
        function extractBackendNameFromTooltip(tooltip: string | undefined, fallback: string | undefined): string {
            if (!tooltip) {
                return fallback || "";
            }

            // Find "contributed by" and "via" boundaries without relying on exact spacing
            const startMarker = "contributed by ";
            const endMarker = " via";

            const startIdx = tooltip.indexOf(startMarker);
            const endIdx = tooltip.indexOf(endMarker, startIdx);

            if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
                return tooltip.substring(startIdx + startMarker.length, endIdx).trim();
            }

            return fallback || "";
        }

        const items: vscode.QuickPickItem[] = models.map((m) => {
            const mAny = m as unknown as { vendor?: string; tags?: string[]; tooltip?: string; detail?: string };
            return {
                label: m.name,
                // Extract backend name from tooltip using robust parsing, fallback to vendor field
                description: extractBackendNameFromTooltip(mAny.tooltip, mAny.vendor),
                detail: mAny.detail || "",
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
