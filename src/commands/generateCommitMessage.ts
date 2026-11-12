import * as vscode from "vscode";
import type { LiteLLMProviderBase } from "../providers/liteLLMProviderBase";
import { GitUtils } from "../utils/gitUtils";
import { Logger } from "../utils/logger";
import { StructuredLogger } from "../observability/structuredLogger";
import { showModelPicker } from "./modelPicker";
import { countTokens, isContextOverflowError } from "../adapters/tokenUtils";
import { countDiffBreadth } from "../utils/commitDiffBudget";
import { buildCommitMessages, prepareCommitRequest, shrinkCommitDiff } from "./commitRequestPreparation";
import { COMMIT_MESSAGE_PROMPT, COMMIT_SYSTEM_PROMPT, resolvePrompt } from "../utils/prompts";
import { stripMarkdownCodeBlocks } from "../utils";
import type { TelemetryService } from "../telemetry/telemetryService";

const COMMIT_CALLER = "commit-message";
const MAX_OVERFLOW_RETRIES = 2;
const ACTIVE_CONTEXT = "litellm-connector.commitGenerationActive";

async function selectCommitModel(modelId: string): Promise<vscode.LanguageModelChat | undefined> {
    const models = await vscode.lm.selectChatModels({ id: modelId });
    return models[0];
}

async function tryGenerateViaVSCodeModelRequest(
    selectedModel: vscode.LanguageModelChat | undefined,
    diff: string,
    systemPrompt: string,
    messagePrompt: string,
    outputCap: number,
    token: vscode.CancellationToken,
    onProgress: (chunk: string) => void
): Promise<string | undefined> {
    // Route commit generation through VS Code's model request API first.
    // This forces VS Code to call our registered chat provider with the
    // provider-group configuration payload (`options.configuration`) attached.
    if (!selectedModel) {
        return undefined;
    }

    const messages = buildCommitMessages(diff, systemPrompt, messagePrompt);

    const response = await selectedModel.sendRequest(
        messages,
        {
            justification: "Generate a concise git commit message from staged changes.",
            // Preserve both instructions; this does not bypass the builder's final input guard.
            modelOptions: { max_tokens: outputCap, litellm_connector_preserve_messages: true },
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

export function registerGenerateCommitMessageCommand(
    _provider: LiteLLMProviderBase,
    telemetryService?: TelemetryService
): vscode.Disposable {
    // One operation owns the global SCM action until its asynchronous cleanup finishes.
    let active: vscode.CancellationTokenSource | undefined;
    const generate = vscode.commands.registerCommand(
        "litellm-connector.generateCommitMessage",
        async (scm: unknown) => {
            if (active) {
                return;
            }
            const source = new vscode.CancellationTokenSource();
            active = source;
            try {
                await vscode.commands.executeCommand("setContext", ACTIVE_CONTEXT, true);
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.SourceControl, title: "Generating commit message..." },
                    async (_progress, progressToken) => {
                        const listener = progressToken.onCancellationRequested(() => source.cancel());
                        try {
                            await generateCommitMessage(_provider, telemetryService, scm, source.token);
                        } finally {
                            listener.dispose();
                        }
                    }
                );
            } finally {
                try {
                    await vscode.commands.executeCommand("setContext", ACTIVE_CONTEXT, false);
                } finally {
                    source.dispose();
                    active = undefined;
                }
            }
        }
    );
    const stop = vscode.commands.registerCommand("litellm-connector.stopCommitMessageGeneration", () => {
        active?.cancel();
    });
    return vscode.Disposable.from(generate, stop, new vscode.Disposable(() => active?.cancel()));
}

async function generateCommitMessage(
    _provider: LiteLLMProviderBase,
    telemetryService: TelemetryService | undefined,
    scm: unknown,
    token: vscode.CancellationToken
): Promise<void> {
    if (token.isCancellationRequested) {
        return;
    }
    const startTime = Date.now();
    if (telemetryService) {
        telemetryService.captureCommandExecuted("generateCommitMessage");
        telemetryService.captureFeatureUsed("commit-message", "commit-message");
    }
    try {
        // Check if model is configured, if not, show picker
        const config = await _provider.getConfigManager().getConfig();
        if (token.isCancellationRequested) {
            return;
        }
        const modelId = config.commitModelIdOverride;
        const systemPrompt = resolvePrompt(config.commitSystemPromptOverride, COMMIT_SYSTEM_PROMPT);
        const messagePrompt = resolvePrompt(config.commitMessagePromptOverride, COMMIT_MESSAGE_PROMPT);

        if (!modelId) {
            const result = await vscode.window.showInformationMessage(
                "No model configured for commit message generation. Would you like to select one?",
                "Select Model"
            );
            if (!token.isCancellationRequested && result === "Select Model") {
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
        if (token.isCancellationRequested) {
            return;
        }
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
            if (token.isCancellationRequested) {
                return;
            }
            Logger.error("VS Code model selection failed", selectErr);
            vscode.window.showErrorMessage(
                "Failed to generate commit message: " +
                    (selectErr instanceof Error ? selectErr.message : String(selectErr))
            );
            return;
        }
        if (token.isCancellationRequested) {
            return;
        }

        const breadth = countDiffBreadth(diff);
        let prepared: Awaited<ReturnType<typeof prepareCommitRequest>>;
        try {
            prepared = await prepareCommitRequest(
                _provider,
                modelId,
                selectedModel?.maxInputTokens,
                diff,
                systemPrompt,
                messagePrompt,
                config.commitOutputTokenReserve,
                token
            );
        } catch (preflightErr) {
            Logger.error("Commit preflight failed", preflightErr);
            throw preflightErr;
        }
        if (token.isCancellationRequested) {
            return;
        }
        const { modelInfo, rawModelId, inputBudget, outputReserve, estimatedDiffTokens } = prepared;
        let activeOutputReserve = prepared.outputReserve;
        let budget = prepared.budget;
        let processedDiff = prepared.diff;
        let processedTokens = prepared.processedTokens;
        const isTruncated = processedDiff !== diff;
        void breadth;

        StructuredLogger.debug(
            "commit.diff_budget",
            {
                inputBudget,
                outputReserve,
                budget,
                diffTokens: estimatedDiffTokens,
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
            telemetryService?.captureTrimExecuted(modelId, COMMIT_CALLER, estimatedDiffTokens, processedTokens, budget);
            vscode.window.showWarningMessage("The diff was truncated to fit within the model's context window.");
        }
        // Silence the unused-binding check; raw/breadth are logged via debug structured fields.
        void rawModelId;
        void inputBudget;

        // Find the SCM input box — prefer the repository matching the SCM context
        const api = await GitUtils.getGitAPI();
        if (token.isCancellationRequested) {
            return;
        }
        if (!api || api.repositories.length === 0) {
            return;
        }

        // Never write into a different repository when the requested one disappeared.
        const matchedRepo = targetRootUri ? GitUtils.findRepositoryByRootUri(api, targetRootUri) : undefined;
        const repo = targetRootUri ? matchedRepo : api.repositories[0];
        if (!repo) {
            return;
        }

        const scmAny = scm as { inputBox?: { value: string; placeholder: string; enabled: boolean } };
        const repoAny = repo as { inputBox?: { value: string; placeholder: string; enabled: boolean } };
        const inputBox = repoAny.inputBox || (scmAny && scmAny.inputBox);

        if (!inputBox) {
            Logger.error("Could not find SCM input box");
            return;
        }

        // Keep the original draft unless generation completes with a usable message.
        const originalValue = inputBox.value;
        inputBox.value = "";
        const originalPlaceholder = inputBox.placeholder;
        const originalEnabled = inputBox.enabled;
        inputBox.placeholder = "Generating commit message...";
        inputBox.enabled = false;
        let completed = false;

        try {
            let accumulatedText = "";
            let generatedMessage: string | undefined;

            for (let retries = 0; ; retries++) {
                try {
                    generatedMessage = await tryGenerateViaVSCodeModelRequest(
                        selectedModel,
                        processedDiff,
                        systemPrompt,
                        messagePrompt,
                        activeOutputReserve,
                        token,
                        (chunk) => {
                            if (token.isCancellationRequested) {
                                return;
                            }
                            accumulatedText += chunk;
                            const filtered = accumulatedText.replace(/^```(?:\w+)?\s*/, "").replace(/```$/, "");
                            inputBox.value = filtered;
                        }
                    );
                    break;
                } catch (vscodeRouteErr) {
                    if (token.isCancellationRequested) {
                        return;
                    }
                    if (isContextOverflowError(vscodeRouteErr) && retries < MAX_OVERFLOW_RETRIES) {
                        const previousLength = processedDiff.length;
                        const previousTokens = countTokens(processedDiff, rawModelId, modelInfo);
                        const smaller = shrinkCommitDiff(processedDiff, budget, rawModelId, modelInfo);
                        const retryPrepared = await prepareCommitRequest(
                            _provider,
                            modelId,
                            selectedModel?.maxInputTokens,
                            smaller,
                            systemPrompt,
                            messagePrompt,
                            config.commitOutputTokenReserve,
                            token
                        ).catch((err: unknown) => {
                            // Preserve the original cause so upstream classifier stays informed.
                            if (err instanceof Error) {
                                throw err;
                            }
                            throw new Error("Remote count/recovery exhausted for commit retry", {
                                cause: err,
                            });
                        });
                        if (token.isCancellationRequested) {
                            return;
                        }
                        processedDiff = retryPrepared.diff;
                        processedTokens = retryPrepared.processedTokens;
                        activeOutputReserve = retryPrepared.outputReserve;
                        budget = Math.min(budget, retryPrepared.budget);
                        if (processedTokens >= previousTokens || processedDiff.length >= previousLength) {
                            throw new Error("Context window exceeded. Commit retry made no progress.", {
                                cause: vscodeRouteErr,
                            });
                        }
                        void previousTokens;
                        accumulatedText = "";
                        inputBox.value = "";
                        StructuredLogger.warn(
                            "commit.diff_overflow_retry",
                            { attempt: retries + 1, budget, previousTokens, resultTokens: processedTokens },
                            { model: modelId, caller: COMMIT_CALLER }
                        );
                        if (!isTruncated && retries === 0) {
                            vscode.window.showWarningMessage(
                                "The diff was truncated to fit within the model's context window."
                            );
                        }
                        continue;
                    }
                    Logger.error("VS Code model request route failed", vscodeRouteErr);
                    vscode.window.showErrorMessage(
                        "Failed to generate commit message: " +
                            (vscodeRouteErr instanceof Error ? vscodeRouteErr.message : String(vscodeRouteErr))
                    );
                    return;
                }
            }

            if (token.isCancellationRequested) {
                return;
            }
            if (!generatedMessage?.trim()) {
                vscode.window.showErrorMessage(
                    "Failed to generate commit message: no response from the selected model."
                );
                return;
            }

            inputBox.value = generatedMessage;
            completed = true;

            /* if (telemetryService) {
                            telemetryService.captureCommitMessageGenerated({
                                model: modelId,
                                durationMs: Date.now() - startTime,
                                status: "success",
                            });
                        } */
        } catch (err) {
            if (token.isCancellationRequested) {
                return;
            }
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
            if (!completed || token.isCancellationRequested) {
                inputBox.value = originalValue;
            }
            inputBox.placeholder = originalPlaceholder;
            inputBox.enabled = originalEnabled;
        }
    } catch (err) {
        if (!token.isCancellationRequested) {
            Logger.error("Error in generateCommitMessage command", err);
            vscode.window.showErrorMessage(
                "Failed to generate commit message: " +
                    (err instanceof Error ? err.message : "Commit preparation failed.")
            );
        }
    }
}
