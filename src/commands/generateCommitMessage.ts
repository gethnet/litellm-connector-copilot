import * as vscode from "vscode";
import type { LiteLLMCommitMessageProvider } from "../providers/liteLLMCommitProvider";
import { GitUtils } from "../utils/gitUtils";
import { Logger } from "../utils/logger";
import { StructuredLogger } from "../observability/structuredLogger";
import { showModelPicker } from "./modelPicker";
import { countTokens } from "../adapters/tokenUtils";
import {
    computeDiffBudget,
    computeOutputReserve,
    countDiffBreadth,
    resolveCommitContextWindow,
} from "../utils/commitDiffBudget";
import { COMMIT_MESSAGE_PROMPT, COMMIT_SYSTEM_PROMPT, resolvePrompt } from "../utils/prompts";
import { stripMarkdownCodeBlocks } from "../utils";
import type { TelemetryService } from "../telemetry/telemetryService";

const COMMIT_CALLER = "commit-message";
const DIFF_PREAMBLE = "Here is the diff:\n\n";

async function selectCommitModel(modelId: string): Promise<vscode.LanguageModelChat | undefined> {
    const models = await vscode.lm.selectChatModels({ id: modelId });
    return models[0];
}

async function tryGenerateViaVSCodeModelRequest(
    selectedModel: vscode.LanguageModelChat | undefined,
    diff: string,
    systemPrompt: string,
    messagePrompt: string,
    token: vscode.CancellationToken,
    onProgress: (chunk: string) => void
): Promise<string | undefined> {
    // Route commit generation through VS Code's model request API first.
    // This forces VS Code to call our registered chat provider with the
    // provider-group configuration payload (`options.configuration`) attached.
    if (!selectedModel) {
        return undefined;
    }

    const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(systemPrompt),
        vscode.LanguageModelChatMessage.User(`${messagePrompt}\n\n${DIFF_PREAMBLE}${diff}`),
    ];

    const response = await selectedModel.sendRequest(
        messages,
        {
            justification: "Generate a concise git commit message from staged changes.",
            modelOptions: {},
        },
        token
    );

    let accumulated = "";
    for await (const chunk of response.stream) {
        if (token.isCancellationRequested) {
            break;
        }

        if (chunk instanceof vscode.LanguageModelTextPart) {
            accumulated += chunk.value;
            onProgress(chunk.value);
        }
    }

    return stripMarkdownCodeBlocks(accumulated);
}

/**
 * Registers the command to generate a git commit message.
 */
export function registerGenerateCommitMessageCommand(
    _provider: LiteLLMCommitMessageProvider,
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
            const config = await _provider.getConfigManager().getConfig();
            const modelId = config.commitModelIdOverride;
            const systemPrompt = resolvePrompt(config.commitSystemPromptOverride, COMMIT_SYSTEM_PROMPT);
            const messagePrompt = resolvePrompt(config.commitMessagePromptOverride, COMMIT_MESSAGE_PROMPT);

            if (!modelId) {
                const result = await vscode.window.showInformationMessage(
                    "No model configured for commit message generation. Would you like to select one?",
                    "Select Model"
                );
                if (result === "Select Model") {
                    await showModelPicker(_provider, {
                        title: "Select Commit Message Model",
                        settingKey: "commitModelIdOverride",
                        telemetryService: telemetryService,
                        caller: "commit-message",
                    });
                }
                return;
            }

            // Get staged diff — extract rootUri from SCM context to select the correct repository
            const scmContext = scm as { rootUri?: vscode.Uri } | undefined;
            const targetRootUri = scmContext?.rootUri;
            const diff = await GitUtils.getStagedDiff(targetRootUri);
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

            let selectedModel: vscode.LanguageModelChat | undefined;
            try {
                selectedModel = await selectCommitModel(modelId);
            } catch (selectErr) {
                Logger.error("VS Code model selection failed", selectErr);
                vscode.window.showErrorMessage(
                    "Failed to generate commit message: " +
                        (selectErr instanceof Error ? selectErr.message : String(selectErr))
                );
                return;
            }

            const modelInfo = _provider.getModelInfo(modelId);
            const maxInputTokens = resolveCommitContextWindow(selectedModel?.maxInputTokens, modelId, modelInfo);
            const breadth = countDiffBreadth(diff);
            const outputReserve = computeOutputReserve(breadth, config.commitOutputTokenReserve);
            const budget = computeDiffBudget({
                maxInputTokens,
                outputReserve,
                staticPrompts: [systemPrompt, messagePrompt, DIFF_PREAMBLE],
                modelId,
                modelInfo,
            });
            const estimatedDiffTokens = countTokens(diff, modelId, modelInfo);
            let processedDiff = diff;
            if (estimatedDiffTokens > budget) {
                processedDiff = GitUtils.compactDiff(diff, budget, modelId, modelInfo);
            }
            const processedTokens = countTokens(processedDiff, modelId, modelInfo);
            const isTruncated = processedDiff !== diff;

            StructuredLogger.info(
                "commit.diff_budget",
                {
                    maxInputTokens,
                    outputReserve,
                    budget,
                    diffTokens: estimatedDiffTokens,
                    files: breadth.files,
                    hunks: breadth.hunks,
                    compacted: isTruncated,
                },
                { model: modelId, caller: COMMIT_CALLER }
            );

            if (isTruncated) {
                StructuredLogger.warn(
                    "commit.diff_compacted",
                    {
                        originalTokens: estimatedDiffTokens,
                        resultTokens: processedTokens,
                        budget,
                    },
                    { model: modelId, caller: COMMIT_CALLER }
                );
                telemetryService?.captureTrimExecuted(
                    modelId,
                    COMMIT_CALLER,
                    estimatedDiffTokens,
                    processedTokens,
                    budget
                );
                vscode.window.showWarningMessage("The diff was truncated to fit within the model's context window.");
            }

            // Find the SCM input box — prefer the repository matching the SCM context
            const api = await GitUtils.getGitAPI();
            if (!api || api.repositories.length === 0) {
                return;
            }

            // Match the correct repository from SCM context, or fall back to first
            const matchedRepo = targetRootUri ? GitUtils.findRepositoryByRootUri(api, targetRootUri) : undefined;
            const repo = matchedRepo ?? api.repositories[0];

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
                        let generatedMessage: string | undefined;

                        try {
                            generatedMessage = await tryGenerateViaVSCodeModelRequest(
                                selectedModel,
                                processedDiff,
                                systemPrompt,
                                messagePrompt,
                                token,
                                (chunk) => {
                                    accumulatedText += chunk;
                                    const filtered = accumulatedText.replace(/^```(?:\w+)?\s*/, "").replace(/```$/, "");
                                    inputBox.value = filtered;
                                }
                            );
                        } catch (vscodeRouteErr) {
                            Logger.error("VS Code model request route failed", vscodeRouteErr);
                            vscode.window.showErrorMessage(
                                "Failed to generate commit message: " +
                                    (vscodeRouteErr instanceof Error ? vscodeRouteErr.message : String(vscodeRouteErr))
                            );
                            return;
                        }

                        if (generatedMessage === undefined) {
                            vscode.window.showErrorMessage(
                                "Failed to generate commit message: no response from the selected model."
                            );
                            return;
                        }

                        inputBox.value = generatedMessage;

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
