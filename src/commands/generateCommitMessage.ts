import * as vscode from "vscode";
import type { LiteLLMCommitMessageProvider } from "../providers/liteLLMCommitProvider";
import { deriveCapabilitiesFromModelInfo } from "../utils/modelCapabilities";
import { GitUtils } from "../utils/gitUtils";
import { Logger } from "../utils/logger";
import { showModelPicker } from "./modelPicker";
import { calculateAvailableContext } from "../adapters/tokenUtils";
import { COMMIT_MESSAGE_PROMPT, COMMIT_SYSTEM_PROMPT } from "../utils/prompts";
import { stripMarkdownCodeBlocks } from "../utils";
import type { TelemetryService } from "../telemetry/telemetryService";

/**
 * Registers the command to generate a git commit message.
 */
export function registerGenerateCommitMessageCommand(
    provider: LiteLLMCommitMessageProvider,
    telemetryService?: TelemetryService
): vscode.Disposable {
    return vscode.commands.registerCommand("litellm-connector.generateCommitMessage", async (scm: unknown) => {
        const startTime = Date.now();
        if (telemetryService) {
            telemetryService.captureCommandExecuted("generateCommitMessage");
            telemetryService.captureFeatureUsed("commit-message", "commit-message");
        }
        try {
            // Check if model is configured, if not, show picker
            const config = await provider.getConfigManager().getConfig();
            const modelId = config.commitModelIdOverride;

            if (!modelId) {
                const result = await vscode.window.showInformationMessage(
                    "No model configured for commit message generation. Would you like to select one?",
                    "Select Model"
                );
                if (result === "Select Model") {
                    await showModelPicker(provider, {
                        title: "Select Commit Message Model",
                        settingKey: "commitModelIdOverride",
                        telemetryService: telemetryService,
                        caller: "commit-message",
                    });
                }
                return;
            }

            // Get staged diff
            const diff = await GitUtils.getStagedDiff();
            if (diff === undefined) {
                vscode.window.showErrorMessage(
                    "No staged changes found. Please stage your changes before generating a commit message."
                );
                return;
            }
            if (diff === "") {
                vscode.window.showInformationMessage("No staged changes found.");
                return;
            }

            // Check diff size with precise context calculation
            const modelInfo = provider.getModelInfo(modelId);
            const capabilities = deriveCapabilitiesFromModelInfo(modelId, modelInfo);

            // Calculate precise budget: MaxInput - MaxOutput - Static Prompts
            const availableTokens = calculateAvailableContext(
                capabilities.maxInputTokens,
                modelInfo?.max_output_tokens || 2000, // Reserve space for the commit message
                [COMMIT_SYSTEM_PROMPT, COMMIT_MESSAGE_PROMPT, "Here is the diff:\n\n"],
                modelId,
                modelInfo
            );

            const estimatedDiffTokens = diff.length / 4;
            let processedDiff = diff;
            let isTruncated = false;

            if (estimatedDiffTokens > availableTokens) {
                // Try to compact the diff first before hard truncation
                processedDiff = GitUtils.compactDiff(diff, availableTokens);

                // If still too large, it was already truncated within compactDiff if needed,
                // but we check if it's different from original to show warning.
                if (processedDiff.length < diff.length) {
                    isTruncated = true;
                    Logger.warn(
                        `Diff compacted/truncated for ${modelId}. Available: ${availableTokens}, Original Estimated: ${estimatedDiffTokens}`
                    );
                }
            }

            if (isTruncated) {
                vscode.window.showWarningMessage("The diff was truncated to fit within the model's context window.");
            }

            // Find the SCM input box
            const api = await GitUtils.getGitAPI();
            if (!api || api.repositories.length === 0) {
                return;
            }
            const repo = api.repositories[0];
            const scmAny = scm as { inputBox?: { value: string; placeholder: string; enabled: boolean } };
            const repoAny = repo as { inputBox?: { value: string; placeholder: string; enabled: boolean } };
            const inputBox = repoAny.inputBox || (scmAny && scmAny.inputBox);

            if (!inputBox) {
                Logger.error("Could not find SCM input box");
                return;
            }

            // Clear existing message
            inputBox.value = "";
            const originalPlaceholder = inputBox.placeholder;
            inputBox.placeholder = "Generating commit message...";
            inputBox.enabled = false;

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.SourceControl,
                    title: "Generating commit message...",
                    cancellable: true,
                },
                async (progress, token) => {
                    try {
                        let accumulatedText = "";
                        await provider.provideCommitMessage(
                            processedDiff,
                            {
                                modelOptions: {},
                            } as vscode.LanguageModelChatRequestOptions,
                            token,
                            (chunk) => {
                                accumulatedText += chunk;
                                // Update input box incrementally (streaming effect)
                                // We apply a light filter here to hide backticks/markdown tags
                                // as they arrive, providing a cleaner UI experience.
                                const filtered = accumulatedText
                                    .replace(/^```(?:\w+)?\s*/, "") // Strip starting block
                                    .replace(/```$/, ""); // Strip ending block if it just arrived
                                inputBox.value = filtered;
                            }
                        );
                        // Ensure final value is fully sanitized
                        inputBox.value = stripMarkdownCodeBlocks(accumulatedText);

                        /* if (telemetryService) {
                            telemetryService.captureCommitMessageGenerated({
                                model: modelId,
                                durationMs: Date.now() - startTime,
                                status: "success",
                            });
                        } */
                    } catch (err) {
                        Logger.error("Failed to generate commit message", err);
                        vscode.window.showErrorMessage(
                            "Failed to generate commit message: " + (err instanceof Error ? err.message : String(err))
                        );

                        if (telemetryService) {
                            telemetryService.captureCommitMessageGenerated({
                                model: modelId,
                                durationMs: Date.now() - startTime,
                                status: "failure",
                            });
                        }
                    } finally {
                        inputBox.placeholder = originalPlaceholder;
                        inputBox.enabled = true;
                    }
                }
            );
        } catch (err) {
            Logger.error("Error in generateCommitMessage command", err);
        }
    });
}
