import * as vscode from "vscode";

import type { LiteLLMConfig } from "../types";
import { Logger } from "../utils/logger";
import { LiteLLMTelemetry } from "../utils/telemetry";
import { LiteLLMProviderBase } from "./liteLLMProviderBase";
import { countTokens } from "../adapters/tokenUtils";
import { decodeSSE } from "../adapters/sse/sseDecoder";
import { createInitialStreamingState, interpretStreamEvent } from "../adapters/streaming/liteLLMStreamInterpreter";

/**
 * Implements VS Code's LanguageModelTextCompletionProvider for inline completions.
 *
 * This provider reuses the shared ingress pipeline from LiteLLMProviderBase by
 * wrapping the prompt string into a chat message and building an OpenAI-style
 * chat request.
 */
export class LiteLLMCompletionProvider extends LiteLLMProviderBase {
    async provideTextCompletion(
        prompt: string,
        options: {
            modelId?: string;
            modelOptions?: Record<string, unknown>;
        },
        token: vscode.CancellationToken
    ): Promise<{ insertText: string }> {
        const requestId = Math.random().toString(36).substring(7);
        const startTime = LiteLLMTelemetry.startTimer();
        const caller = options.modelId?.includes("inline") ? "inline-completions" : "text-completion";
        const justification = (options as { justification?: string }).justification;

        Logger.info(
            `Completion request started | RequestID: ${requestId} | Model: ${options.modelId || "auto"} | Caller: ${caller} | Justification: ${justification || "none"}`
        );

        let tokensIn: number | undefined;

        try {
            if (!(await this._configManager.isConfigured())) {
                throw new Error("LiteLLM configuration not found. Please configure at least one backend.");
            }

            const config = await this._configManager.getConfig();

            const model = await this.resolveCompletionModel(config, token);
            if (!model) {
                throw new Error("No model available for completions");
            }

            const modelInfo = this._modelInfoCache.get(model.id);
            const messages: vscode.LanguageModelChatRequestMessage[] = [this.wrapPromptAsMessage(prompt)];

            // Calculate tokensIn for telemetry
            tokensIn = countTokens(messages, model.id, modelInfo);

            // Reuse the base request pipeline. We pass a minimal ProvideLanguageModelChatResponseOptions-like
            // structure with model options.
            const requestBody = await this.buildOpenAIChatRequest(
                messages,
                model,
                {
                    modelOptions: options.modelOptions,
                    tools: [],
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                modelInfo,
                "inline-completions"
            );

            // For completions we don't emit progress parts; we just need the raw stream to extract text.
            const nullProgress: vscode.Progress<vscode.LanguageModelResponsePart> = { report: () => {} };
            const stream = await this.sendRequestToLiteLLM(
                requestBody,
                nullProgress,
                token,
                "inline-completions",
                modelInfo
            );

            const completionText = await this.extractCompletionTextFromStream(stream, token);

            // Estimate tokensOut from the completion text
            const tokensOut = countTokens(completionText, model.id, modelInfo);

            const durationMs = LiteLLMTelemetry.endTimer(startTime);
            LiteLLMTelemetry.reportMetric({
                requestId,
                model: model.id,
                durationMs,
                tokensIn,
                tokensOut,
                status: "success",
                caller: "inline-completions",
            });

            if (this._telemetryService) {
                this._telemetryService.captureRequestCompleted({
                    caller: "inline-completions",
                    model: model.id,
                    endpoint: modelInfo?.mode ?? "chat",
                    durationMs,
                    tokensIn: tokensIn ?? 0,
                    tokensOut,
                });
            }

            return {
                insertText: completionText,
            };
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            Logger.error(`Completions failed: ${errorMsg}`, err);

            const durationMs = LiteLLMTelemetry.endTimer(startTime);
            LiteLLMTelemetry.reportMetric({
                requestId,
                model: options.modelId ?? "unknown",
                durationMs,
                tokensIn,
                status: "failure",
                error: errorMsg,
                caller: "inline-completions",
            });

            if (this._telemetryService) {
                this._telemetryService.captureRequestFailed({
                    caller: "inline-completions",
                    model: options.modelId ?? "unknown",
                    endpoint: "unknown",
                    durationMs,
                    errorType: errorMsg,
                });
            }

            throw err;
        }
    }

    private wrapPromptAsMessage(prompt: string): vscode.LanguageModelChatRequestMessage {
        return {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart(prompt)],
            name: undefined,
        };
    }

    private async resolveCompletionModel(
        config: LiteLLMConfig,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation | undefined> {
        if (this._lastModelList.length === 0) {
            await this.discoverModels({ silent: true }, token);
        }

        if (config.modelIdOverride) {
            return this._lastModelList.find((m) => m.id === config.modelIdOverride);
        }

        // Prefer models explicitly tagged for inline completions.
        return this._lastModelList.find((m) => {
            const tags = (m as unknown as { tags?: string[] }).tags;
            return tags?.includes("inline-completions") === true;
        });
    }

    private async extractCompletionTextFromStream(
        stream: ReadableStream<Uint8Array>,
        token: vscode.CancellationToken
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
                    }
                }
            }
        } catch (err) {
            Logger.warn("Error while extracting completion text", err);
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
