import * as vscode from "vscode";

import type { LiteLLMConfig } from "../types";
import { Logger } from "../utils/logger";
import { LiteLLMTelemetry } from "../utils/telemetry";
import { LiteLLMProviderBase } from "./liteLLMProviderBase";
import { countTokens } from "../adapters/tokenUtils";
import { StreamTokenCapture } from "../adapters/streaming/streamTokenCapture";
import { decodeSSE } from "../adapters/sse/sseDecoder";
import { createInitialStreamingState, interpretStreamEvent } from "../adapters/streaming/liteLLMStreamInterpreter";
import type { EffortFallbackCache } from "../utils/reasoningEffortFallback";

/**
 * Implements VS Code's LanguageModelTextCompletionProvider for inline completions.
 *
 * This provider reuses the shared ingress pipeline from LiteLLMProviderBase by
 * wrapping the prompt string into a chat message and building an OpenAI-style
 * chat request.
 */
export class LiteLLMCompletionProvider extends LiteLLMProviderBase {
    constructor(secrets: vscode.SecretStorage, userAgent: string, effortFallbackCache?: EffortFallbackCache) {
        super(secrets, userAgent, effortFallbackCache);
    }

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

        if (this._telemetryService) {
            // this may be chatty, but saving
            // this._telemetryService.captureFeatureUsed("completions", caller);
        }

        Logger.info(
            `Completion request started | RequestID: ${requestId} | Model: ${options.modelId || "auto"} | Caller: ${caller} | Justification: ${justification || "none"}`
        );

        let tokensIn: number | undefined;

        try {
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

            const tokenCapture = new StreamTokenCapture(
                model.id,
                {
                    report: (_part: vscode.LanguageModelResponsePart): void => {
                        // Completions do not forward parts to VS Code UI
                    },
                },
                modelInfo
            );
            tokenCapture.setEstimatedPromptTokens(tokensIn ?? 0);
            const trackingProgress = tokenCapture.progress;
            const stream = await this.sendRequestWithRetry(
                requestBody,
                messages,
                model,
                {
                    modelOptions: options.modelOptions,
                    tools: [],
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                trackingProgress,
                token,
                "inline-completions",
                modelInfo
            );

            const completionText = await this.extractCompletionTextFromStream(stream, token);
            const snapshot = tokenCapture.getSnapshot();
            const tokensOut = snapshot.sawUpstreamUsage
                ? snapshot.completionTokens
                : countTokens(completionText, model.id, modelInfo);

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
            // todo: remove this as it is too chatty
            if (this._telemetryService) {
                this._telemetryService.captureRequestCompleted({
                    request_id: requestId,
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
                    request_id: requestId,
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
            return this._lastModelList.find(
                (m: vscode.LanguageModelChatInformation) => m.id === config.modelIdOverride
            );
        }

        // Prefer models explicitly tagged for inline completions.
        return this._lastModelList.find((m: vscode.LanguageModelChatInformation) => {
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
