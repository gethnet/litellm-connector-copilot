import * as vscode from "vscode";
import type { LiteLLMConfig } from "../types";
import { LiteLLMProviderBase } from "./liteLLMProviderBase";
import { LiteLLMTelemetry } from "../utils/telemetry";
import { Logger } from "../utils/logger";
import { countTokens } from "../adapters/tokenUtils";
import { decodeSSE } from "../adapters/sse/sseDecoder";
import { createInitialStreamingState, interpretStreamEvent } from "../adapters/streaming/liteLLMStreamInterpreter";
import { COMMIT_MESSAGE_PROMPT, COMMIT_SYSTEM_PROMPT } from "../utils/prompts";

/**
 * Provider for generating Git commit messages using LiteLLM.
 * Extends the shared orchestration from LiteLLMProviderBase.
 */
export class LiteLLMCommitMessageProvider extends LiteLLMProviderBase {
    /**
     * Generates a commit message from a git diff.
     * @param diff The git diff to analyze.
     * @param options Language model request options.
     * @param token Cancellation token.
     * @param onProgress Callback for streaming response parts.
     */
    async provideCommitMessage(
        diff: string,
        options: vscode.LanguageModelChatRequestOptions,
        token: vscode.CancellationToken,
        onProgress?: (text: string) => void
    ): Promise<string> {
        const requestId = Math.random().toString(36).substring(7);
        const startTime = LiteLLMTelemetry.startTimer();
        let tokensIn: number | undefined;
        let modelId = "unknown";

        try {
            const config = await this._configManager.getConfig();

            if (!config.url) {
                throw new Error("LiteLLM configuration not found. Please configure the LiteLLM base URL.");
            }

            // Select a model suitable for commit message generation
            const model = await this.resolveCommitModel(config, token);
            if (!model) {
                throw new Error("No model available for commit message generation");
            }
            modelId = model.id;
            const modelInfo = this._modelInfoCache.get(model.id);

            // Construct the chat messages
            const messages: vscode.LanguageModelChatRequestMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelTextPart(COMMIT_SYSTEM_PROMPT)],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [
                        new vscode.LanguageModelTextPart(`${COMMIT_MESSAGE_PROMPT}\n\nHere is the diff:\n\n${diff}`),
                    ],
                    name: undefined,
                },
            ];

            // Calculate tokensIn for telemetry
            tokensIn = countTokens(messages, model.id, modelInfo);

            // Build the OpenAI-compatible request body
            const requestBody = await this.buildOpenAIChatRequest(
                messages,
                model,
                {
                    modelOptions: options.modelOptions,
                    tools: [],
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                modelInfo,
                "scm-generator"
            );

            // Send the request
            const nullProgress: vscode.Progress<vscode.LanguageModelResponsePart> = {
                report: (part) => {
                    if (part instanceof vscode.LanguageModelTextPart && onProgress) {
                        onProgress(part.value);
                    }
                },
            };

            const stream = await this.sendRequestToLiteLLM(
                requestBody,
                nullProgress,
                token,
                "scm-generator",
                modelInfo
            );

            // Extract the final text from the stream
            const commitMessage = await this.extractTextFromStream(stream, token, onProgress);

            // Estimate tokensOut from the generated text
            const tokensOut = countTokens(commitMessage, model.id, modelInfo);

            LiteLLMTelemetry.reportMetric({
                requestId,
                model: model.id,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                tokensIn,
                tokensOut,
                status: "success",
                caller: "scm-generator",
            });

            return commitMessage.trim();
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            Logger.error(`Commit message generation failed: ${errorMsg}`, err);

            LiteLLMTelemetry.reportMetric({
                requestId,
                model: modelId,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                tokensIn,
                status: "failure",
                error: errorMsg,
                caller: "scm-generator",
            });

            throw err;
        }
    }

    /**
     * Resolves the model to use for commit message generation.
     */
    private async resolveCommitModel(
        config: LiteLLMConfig,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation | undefined> {
        Logger.debug("Starting Commit Model Resolution");
        if (this._lastModelList.length === 0) {
            Logger.trace("No model list data discovered");
            await this.discoverModels({ silent: true }, token);
        }

        // Use the override if provided in settings
        if (config.commitModelIdOverride) {
            Logger.trace(`Returning model data ${config.commitModelIdOverride}`);
            return this._lastModelList.find((m) => m.id === config.commitModelIdOverride);
        }

        // Prefer models explicitly tagged for SCM generation
        return this._lastModelList.find((m) => {
            const tags = (m as unknown as { tags?: string[] }).tags;
            return tags?.includes("scm-generator") === true;
        });
    }

    /**
     * Extracts text from the LiteLLM SSE stream and optionally calls a progress callback.
     */
    private async extractTextFromStream(
        stream: ReadableStream<Uint8Array>,
        token: vscode.CancellationToken,
        onProgress?: (text: string) => void
    ): Promise<string> {
        let fullText = "";
        const state = createInitialStreamingState();

        try {
            for await (const payload of decodeSSE(stream, token)) {
                if (token.isCancellationRequested) {
                    break;
                }

                const json = this.tryParseJSON(payload);
                if (!json) {
                    continue;
                }

                const parts = interpretStreamEvent(json, state);
                for (const part of parts) {
                    if (part.type === "text") {
                        fullText += part.value;
                        if (onProgress) {
                            onProgress(part.value);
                        }
                    }
                }
            }
        } catch (err) {
            Logger.warn("Error while extracting commit text", err);
        }

        return fullText;
    }

    private tryParseJSON(text: string): unknown {
        try {
            return JSON.parse(text);
        } catch {
            return undefined;
        }
    }
}
