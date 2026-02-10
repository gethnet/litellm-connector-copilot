import * as vscode from "vscode";

import type { LiteLLMChatProvider } from "../providers";
import { Logger } from "../utils/logger";
import { LiteLLMTelemetry } from "../utils/telemetry";

const INLINE_COMPLETIONS_MODEL_ID_KEY = "litellm-connector.inlineCompletions.modelId";

type ModelWithOptionalTags = vscode.LanguageModelChatInformation & { tags?: readonly string[] };

export function registerSelectInlineCompletionModelCommand(provider: LiteLLMChatProvider): vscode.Disposable {
    return vscode.commands.registerCommand("litellm-connector.inlineCompletions.selectModel", async () => {
        const requestId = `ic_select_${Math.random().toString(36).slice(2, 10)}`;
        LiteLLMTelemetry.reportMetric({
            requestId,
            model: "n/a",
            status: "success",
            caller: "inline-completions.selectModel.opened",
        });

        let models = provider.getLastKnownModels();
        if (!models.length) {
            try {
                await provider.provideLanguageModelChatInformation(
                    { silent: true },
                    new vscode.CancellationTokenSource().token
                );
                models = provider.getLastKnownModels();
            } catch (err) {
                Logger.error("Failed to refresh models for inline completion picker", err);
            }
        }

        if (!models.length) {
            vscode.window.showInformationMessage(
                "No models available yet. Configure LiteLLM and run 'LiteLLM: Reload Models' first."
            );
            LiteLLMTelemetry.reportMetric({
                requestId,
                model: "n/a",
                status: "failure",
                error: "no_models",
                caller: "inline-completions.selectModel",
            });
            return;
        }

        // Prefer models tagged for inline completions.
        const compatible = models.filter((m) => (m as ModelWithOptionalTags).tags?.includes("inline-completions"));
        const list = compatible.length ? compatible : models;

        const picked = await vscode.window.showQuickPick(
            list
                .slice()
                .sort((a, b) => a.id.localeCompare(b.id))
                .map((m) => {
                    const tags = (m as ModelWithOptionalTags).tags ?? [];
                    return {
                        label: m.id,
                        description: m.name !== m.id ? m.name : undefined,
                        detail: tags.length ? `tags: ${tags.join(", ")}` : m.tooltip,
                    };
                }),
            {
                title: "LiteLLM: Select Inline Completion Model",
                placeHolder: "Pick a model id to use for inline completions",
                matchOnDescription: true,
                matchOnDetail: true,
            }
        );

        if (!picked) {
            LiteLLMTelemetry.reportMetric({
                requestId,
                model: "n/a",
                status: "failure",
                error: "cancelled",
                caller: "inline-completions.selectModel.cancelled",
            });
            return;
        }

        await vscode.workspace
            .getConfiguration()
            .update(INLINE_COMPLETIONS_MODEL_ID_KEY, picked.label, vscode.ConfigurationTarget.Global);

        LiteLLMTelemetry.reportMetric({
            requestId,
            model: picked.label,
            status: "success",
            caller: "inline-completions.selectModel.selected",
        });

        vscode.window.showInformationMessage(`Inline completions model set to: ${picked.label}`);
    });
}
