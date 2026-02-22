import * as vscode from "vscode";
import type { LiteLLMCommitMessageProvider } from "../providers/liteLLMCommitProvider";
import { GitUtils } from "../utils/gitUtils";
import { Logger } from "../utils/logger";
import { showModelPicker } from "./modelPicker";

/**
 * Registers the command to generate a git commit message.
 */
export function registerGenerateCommitMessageCommand(provider: LiteLLMCommitMessageProvider): vscode.Disposable {
    return vscode.commands.registerCommand("litellm-connector.generateCommitMessage", async (scm: unknown) => {
        try {
            // Check if model is configured, if not, show picker
            const config = vscode.workspace.getConfiguration("litellm-connector");
            const modelId = config.get<string>("commitModelIdOverride");

            if (!modelId) {
                const result = await vscode.window.showInformationMessage(
                    "No model configured for commit message generation. Would you like to select one?",
                    "Select Model"
                );
                if (result === "Select Model") {
                    await showModelPicker(provider, {
                        title: "Select Commit Message Model",
                        settingKey: "commitModelIdOverride",
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

            // Check diff size
            const modelInfo = provider.getModelInfo(modelId);
            const maxTokens = modelInfo?.max_input_tokens || 128000;
            const { diff: processedDiff, isTruncated } = GitUtils.checkDiffSize(diff, maxTokens);

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
                                inputBox.value = accumulatedText;
                            }
                        );
                    } catch (err) {
                        Logger.error("Failed to generate commit message", err);
                        vscode.window.showErrorMessage(
                            "Failed to generate commit message: " + (err instanceof Error ? err.message : String(err))
                        );
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
