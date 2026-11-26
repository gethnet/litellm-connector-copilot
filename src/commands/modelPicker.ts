import * as vscode from "vscode";
import type { ExtendedModelInformation } from "../utils/modelCapabilities";
import type { LiteLLMProviderBase } from "../providers/liteLLMProviderBase";
import { Logger } from "../utils/logger";
import type { TelemetryService } from "../telemetry/telemetryService";

/**
 * The vendor prefix VS Code qualifies extension provider model ids with.
 * The clipboard payload uses it so a pasted id is unambiguous in settings,
 * chat prompts, and issue reports; `ConfigManager.normalizeModelId` strips
 * it again when the commit-model setting is read, so round-tripping is safe.
 */
const MODEL_SELECTOR = "litellm-connector/";

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
 * Shows a QuickPick to select a model from the connector's last-known model
 * list. Selecting a model stores its namespaced id into the given setting and
 * copies the fully qualified id (`litellm-connector/<id>`) to the clipboard.
 * @param provider The provider whose display models populate the picker.
 * @param options Picker options.
 */
export async function showModelPicker(provider: LiteLLMProviderBase, options: ModelPickerOptions): Promise<void> {
    if (options.telemetryService) {
        options.telemetryService.captureModelPickerOpened(options.caller || "unknown");
        options.telemetryService.captureFeatureUsed("model-picker", options.caller || "unknown");
    }
    try {
        // Source candidates from the registry's display models — the same
        // last-known view the "LiteLLM: Show Available Models" command reads.
        // A vendor-level discoverModels({silent:true}) call is a no-op on
        // modern per-group configs (it returns [] without options.configuration
        // and would falsely blame the user's connection), and the extension
        // cannot enumerate provider groups itself. The display list is
        // populated by VS Code's host-driven per-group discovery; if it is
        // empty, the honest guidance is to run Reload Models first.
        const models = provider.getLastKnownModels();
        if (models.length === 0) {
            vscode.window.showInformationMessage(
                "No LiteLLM models are available yet. Run 'LiteLLM: Reload Models' (or open the model picker once) so provider groups resolve, then try again."
            );
            return;
        }

        const items: (vscode.QuickPickItem & { id?: string; modelId?: string })[] = models.map((m) => {
            const mExtended = m as ExtendedModelInformation;
            const fullyQualifiedId = `${MODEL_SELECTOR}${m.id}`;
            return {
                label: `${mExtended.backendName || "LiteLLM"} :: ${m.name}`,
                description: fullyQualifiedId,
                detail: mExtended.tooltip || "",
                // `id` keeps the namespaced registry id for callers that match
                // on it; `modelId` carries the fully qualified clipboard form.
                id: mExtended.id,
                modelId: fullyQualifiedId,
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
            matchOnDescription: true,
            matchOnDetail: true,
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

        // Selection always carries the fully qualified id (QuickPickItem.modelId,
        // set above). The label fallback exists only for stale callers.
        const selectedId = selected.id ?? models.find((m) => m.name === selected.label)?.id;
        const fullyQualifiedId = selected.modelId ?? (selectedId ? `${MODEL_SELECTOR}${selectedId}` : undefined);
        if (!selectedId || !fullyQualifiedId) {
            vscode.window.showErrorMessage("Selected model could not be resolved.");
            return;
        }

        // Copy the fully qualified id to the clipboard so it can be pasted
        // into settings, prompts, and issue reports — same contract as
        // "LiteLLM: Show Available Models". The setting still stores the
        // namespaced registry id; normalizeModelId strips the vendor prefix
        // on read, so both forms round-trip.
        await vscode.env.clipboard.writeText(fullyQualifiedId);

        await vscode.workspace
            .getConfiguration("litellm-connector")
            .update(options.settingKey, selectedId, vscode.ConfigurationTarget.Global);
        if (options.telemetryService) {
            options.telemetryService.captureConfigChanged(options.settingKey, "model-picker-select");
        }
        if (options.onSelect) {
            options.onSelect(selectedId);
        }
        vscode.window.showInformationMessage(
            `Selected model: ${selectedId}. Copied fully qualified model id: ${fullyQualifiedId}`
        );
    } catch (err) {
        Logger.error("Failed to show model picker", err);
        vscode.window.showErrorMessage("Failed to load models for selection.");
    }
}
