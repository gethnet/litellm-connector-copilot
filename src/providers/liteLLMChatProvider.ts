import * as vscode from "vscode";
import type {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatProvider,
    LanguageModelChatRequestMessage,
    LanguageModelResponsePart,
    Progress,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";

import { tryParseJSONObject } from "../utils";
import { Logger } from "../utils/logger";
import { LiteLLMTelemetry } from "../utils/telemetry";
import { LiteLLMProviderBase } from "./liteLLMProviderBase";
import { countTokens } from "../adapters/tokenUtils";
import { decodeSSE } from "../adapters/sse/sseDecoder";
import { createInitialStreamingState, interpretStreamEvent } from "../adapters/streaming/liteLLMStreamInterpreter";
import type { StreamingState } from "../adapters/streaming/liteLLMStreamInterpreter";
import { emitPartsToVSCode } from "../adapters/streaming/vscodePartEmitter";

/**
 * Chat provider implementation for VS Code's LanguageModelChatProvider.
 *
 * All shared orchestration (model discovery, request building, trimming, parameter filtering,
 * endpoint routing) is implemented in LiteLLMProviderBase.
 */
export class LiteLLMChatProvider extends LiteLLMProviderBase implements LanguageModelChatProvider {
    // Streaming state
    private _streamingState: StreamingState = createInitialStreamingState();
    private _partialAssistantText = "";

    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        return this.discoverModels(options, token);
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: readonly LanguageModelChatRequestMessage[],
        options: ProvideLanguageModelChatResponseOptions & { configuration?: Record<string, unknown> },
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        this.resetStreamingState();
        const startTime = LiteLLMTelemetry.startTimer();
        const requestId = Math.random().toString(36).substring(7);
        let tokensIn: number | undefined;

        // Extract caller/justification from options or model tags
        const telemetry = this.getTelemetryOptions(options);
        const modelWithTags = model as vscode.LanguageModelChatInformation & { tags?: string[] };
        const caller = telemetry.caller || modelWithTags.tags?.[0] || "chat";
        const justification = telemetry.justification;

        Logger.info(
            `Chat request started | RequestID: ${requestId} | Model: ${model.id} | Caller: ${caller} | Justification: ${
                justification || "none"
            }`
        );

        const trackingProgress: Progress<LanguageModelResponsePart> = {
            report: (part) => {
                if (part instanceof vscode.LanguageModelTextPart) {
                    this._partialAssistantText += part.value;
                }
                progress.report(part);
            },
        };

        try {
            const config = options.configuration
                ? this._configManager.convertProviderConfiguration(options.configuration)
                : await this._configManager.getConfig();

            if (!config.url) {
                throw new Error("LiteLLM configuration not found. Please configure the LiteLLM base URL.");
            }

            // Optional model override (primarily for completions). If set, we try to use it.
            // If the override isn't in cache yet, attempt a best-effort refresh.
            let modelToUse = model;
            if (config.modelIdOverride) {
                const overrideId = config.modelIdOverride;
                const cachedOverride = this._lastModelList.find((m) => m.id === overrideId);
                if (cachedOverride) {
                    modelToUse = cachedOverride;
                } else {
                    try {
                        Logger.info(`modelIdOverride set to '${overrideId}' but not in cache; refreshing model list`);
                        await this.discoverModels({ silent: true }, token);
                        const refreshed = this._lastModelList.find((m) => m.id === overrideId);
                        if (refreshed) {
                            modelToUse = refreshed;
                        } else {
                            Logger.warn(
                                `modelIdOverride '${overrideId}' not found after refresh; using selected model '${model.id}'`
                            );
                        }
                    } catch (refreshErr) {
                        Logger.warn("Failed to refresh model list for override; using selected model", refreshErr);
                    }
                }
            }

            const modelInfo = this._modelInfoCache.get(modelToUse.id);
            const requestBody = await this.buildOpenAIChatRequest(messages, modelToUse, options, modelInfo, caller);

            // Calculate tokensIn for telemetry
            tokensIn = countTokens(messages, modelToUse.id, modelInfo);

            let stream: ReadableStream<Uint8Array>;
            try {
                // Note: sendRequestToLiteLLM may fully handle /responses by emitting directly to progress.
                // In that case it returns an already-closed stream.
                stream = await this.sendRequestToLiteLLM(requestBody, trackingProgress, token, caller, modelInfo);
            } catch (err: unknown) {
                if (token.isCancellationRequested) {
                    throw new Error("Operation cancelled by user");
                }

                if (err instanceof Error && err.message.includes("LiteLLM API error")) {
                    const errorText = err.message.split("\n").slice(1).join("\n");
                    const parsedMessage = this.parseApiError(400, errorText);
                    if (
                        parsedMessage.toLowerCase().includes("unsupported parameter") ||
                        parsedMessage.toLowerCase().includes("not supported")
                    ) {
                        Logger.warn(`Retrying request without optional parameters due to: ${parsedMessage}`);
                        delete requestBody.temperature;
                        delete requestBody.top_p;
                        delete requestBody.frequency_penalty;
                        delete requestBody.presence_penalty;
                        delete requestBody.stop;

                        if (token.isCancellationRequested) {
                            throw new Error("Operation cancelled by user");
                        }
                        try {
                            stream = await this.sendRequestToLiteLLM(
                                requestBody,
                                trackingProgress,
                                token,
                                caller,
                                modelInfo
                            );
                            await this.processStreamingResponse(stream, trackingProgress, token);

                            // Estimate tokensOut from the accumulated assistant text
                            const tokensOut = countTokens(this._partialAssistantText, modelToUse.id, modelInfo);

                            LiteLLMTelemetry.reportMetric({
                                requestId,
                                model: modelToUse.id,
                                durationMs: LiteLLMTelemetry.endTimer(startTime),
                                tokensIn,
                                tokensOut,
                                status: "success",
                                caller,
                            });
                            return;
                        } catch (retryErr: unknown) {
                            // If retry fails, throw a more descriptive error
                            let retryErrorMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
                            if (retryErrorMessage.includes("LiteLLM API error")) {
                                const statusMatch = retryErrorMessage.match(/error: (\d+)/);
                                const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 400;
                                const errorParts = retryErrorMessage.split("\n");
                                const errorText = errorParts.length > 1 ? errorParts.slice(1).join("\n") : "";
                                const parsedMessage = this.parseApiError(statusCode, errorText);
                                retryErrorMessage = `LiteLLM Error (${model.id}): ${parsedMessage}. This model may not support certain parameters like temperature.`;
                            }
                            throw new Error(retryErrorMessage);
                        }
                    } else {
                        throw err;
                    }
                } else {
                    throw err;
                }
            }

            await this.processStreamingResponse(stream, trackingProgress, token);

            // Estimate tokensOut from the accumulated assistant text
            const tokensOut = countTokens(this._partialAssistantText, modelToUse.id, modelInfo);

            LiteLLMTelemetry.reportMetric({
                requestId,
                model: modelToUse.id,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                tokensIn,
                tokensOut,
                status: "success",
                caller,
            });
        } catch (err: unknown) {
            let errorMessage = err instanceof Error ? err.message : String(err);
            if (errorMessage.includes("LiteLLM API error")) {
                const statusMatch = errorMessage.match(/error: (\d+)/);
                const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 400;
                const errorParts = errorMessage.split("\n");
                const errorText = errorParts.length > 1 ? errorParts.slice(1).join("\n") : "";
                const parsedMessage = this.parseApiError(statusCode, errorText);
                errorMessage = `LiteLLM Error (${model.id}): ${parsedMessage}`;
                if (
                    parsedMessage.toLowerCase().includes("temperature") ||
                    parsedMessage.toLowerCase().includes("unsupported value")
                ) {
                    errorMessage +=
                        ". This model may not support certain parameters like temperature. Please check your model settings.";
                }
            }
            Logger.error("Chat request failed", err);
            LiteLLMTelemetry.reportMetric({
                requestId,
                model: model.id,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                tokensIn,
                status: "failure",
                error: errorMessage,
                caller,
            });
            throw new Error(errorMessage);
        }
    }

    async provideTokenCount(
        model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        token: vscode.CancellationToken
    ): Promise<number> {
        return super.provideTokenCount(model, text, token);
    }

    protected resetStreamingState(): void {
        this._streamingState = createInitialStreamingState();
        this._partialAssistantText = "";
    }

    /**
     * Processes an SSE streaming response from LiteLLM and emits VS Code response parts.
     *
     * Kept as `protected` to allow unit tests (and potential subclasses) to exercise the
     * streaming pipeline deterministically without stubbing network layers.
     */
    protected async processStreamingResponse(
        responseBody: ReadableStream<Uint8Array>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const config = await this._configManager.getConfig();
        const timeoutMs = (config.inactivityTimeout ?? 60) * 1000;
        let watchdog: NodeJS.Timeout | undefined;

        const resetWatchdog = () => {
            if (watchdog) {
                clearTimeout(watchdog);
            }
            watchdog = setTimeout(() => {
                Logger.warn(`Inactivity timeout after ${timeoutMs}ms`);
                // Note: We can't easily cancel the reader from here without a reference,
                // but decodeSSE handles cancellation via the token.
            }, timeoutMs);
        };

        token.onCancellationRequested(() => {
            if (watchdog) {
                clearTimeout(watchdog);
            }
        });

        try {
            resetWatchdog();
            for await (const payload of decodeSSE(responseBody, token)) {
                console.log("DEBUG: LiteLLMChatProvider payload:", payload);
                resetWatchdog();
                if (token.isCancellationRequested) {
                    console.log("DEBUG: LiteLLMChatProvider cancellation requested");
                    break;
                }

                const jsonResult = tryParseJSONObject(payload);
                if (!jsonResult.ok) {
                    continue;
                }
                const json = jsonResult.value;

                // Ensure streaming state is initialized (e.g. if processStreamingResponse is called directly in tests)
                if (!this._streamingState) {
                    this.resetStreamingState();
                }

                const parts = interpretStreamEvent(json, this._streamingState);
                console.log("DEBUG: LiteLLMChatProvider interpreted parts:", JSON.stringify(parts));
                emitPartsToVSCode(parts, progress);
            }
        } finally {
            if (watchdog) {
                clearTimeout(watchdog);
            }
        }
    }

    private stripControlTokens(text: string): string {
        return text
            .replace(/<\|[a-zA-Z0-9_-]+_section_(?:begin|end)\|>/g, "")
            .replace(/<\|tool_call_(?:argument_)?(?:begin|end)\|>/g, "");
    }
}
