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
import {
    countOpenAIChatMessagesTokens,
    countTokens,
    estimateToolTokens,
    getReservedOutputTokens,
    getTotalTokenLimit,
} from "../adapters/tokenUtils";
import { decodeSSE } from "../adapters/sse/sseDecoder";
import { createInitialStreamingState, interpretStreamEvent } from "../adapters/streaming/liteLLMStreamInterpreter";
import type { StreamingState } from "../adapters/streaming/liteLLMStreamInterpreter";
import { emitPartsToVSCode } from "../adapters/streaming/vscodePartEmitter";
import type { EffortFallbackCache } from "../utils/reasoningEffortFallback";
import type { OpenAIUsageCompletionTokenDetails, OpenAIUsagePayload, OpenAIUsagePromptTokenDetails } from "../types";

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
    private _lastStreamUsage?: {
        promptTokens?: number;
        completionTokens?: number;
        systemTokens?: number;
        cachedTokens?: number;
        cacheCreationInputTokens?: number;
        reasoningTokens?: number;
        toolTokens?: number;
        acceptedPredictionTokens?: number;
        rejectedPredictionTokens?: number;
    };
    private _sawUsageDataPart = false;
    private _estimatedToolCallTokens = 0;

    constructor(secrets: vscode.SecretStorage, userAgent: string, effortFallbackCache?: EffortFallbackCache) {
        super(secrets, userAgent, effortFallbackCache);
    }

    private mergeUsagePayloadWithLastKnown(current: OpenAIUsagePayload): OpenAIUsagePayload {
        const previous = this._lastStreamUsage;
        if (!previous) {
            return current;
        }

        const pickMonotonicTokenCount = (currentValue?: number, previousValue?: number): number | undefined => {
            if (typeof currentValue === "number" && typeof previousValue === "number") {
                return Math.max(currentValue, previousValue);
            }
            if (typeof currentValue === "number") {
                return currentValue;
            }
            return previousValue;
        };

        const normalizedCurrentPromptDetails: OpenAIUsagePromptTokenDetails = {
            ...(current.prompt_tokens_details ?? {}),
        };
        const normalizedCurrentCompletionDetails: OpenAIUsageCompletionTokenDetails = {
            ...(current.completion_tokens_details ?? {}),
        };

        const mergedPromptTokens = Math.max(current.prompt_tokens, previous.promptTokens ?? 0);
        const mergedCompletionTokens = Math.max(current.completion_tokens, previous.completionTokens ?? 0);

        const mergedPromptDetails: OpenAIUsagePromptTokenDetails = {
            cached_tokens: pickMonotonicTokenCount(
                normalizedCurrentPromptDetails.cached_tokens ?? (current.prompt_tokens_details ? 0 : undefined),
                previous.cachedTokens
            ),
            cache_creation_input_tokens: pickMonotonicTokenCount(
                normalizedCurrentPromptDetails.cache_creation_input_tokens,
                previous.cacheCreationInputTokens
            ),
        };

        const mergedCompletionDetails: OpenAIUsageCompletionTokenDetails = {
            reasoning_tokens: pickMonotonicTokenCount(
                normalizedCurrentCompletionDetails.reasoning_tokens ??
                    (current.completion_tokens_details ? 0 : undefined),
                previous.reasoningTokens
            ),
            tool_tokens: pickMonotonicTokenCount(normalizedCurrentCompletionDetails.tool_tokens, previous.toolTokens),
            accepted_prediction_tokens: pickMonotonicTokenCount(
                normalizedCurrentCompletionDetails.accepted_prediction_tokens,
                previous.acceptedPredictionTokens
            ),
            rejected_prediction_tokens: pickMonotonicTokenCount(
                normalizedCurrentCompletionDetails.rejected_prediction_tokens,
                previous.rejectedPredictionTokens
            ),
        };

        const merged: OpenAIUsagePayload = {
            ...current,
            prompt_tokens: mergedPromptTokens,
            completion_tokens: mergedCompletionTokens,
            total_tokens: mergedPromptTokens + mergedCompletionTokens,
            system_prompt_tokens: pickMonotonicTokenCount(current.system_prompt_tokens, previous.systemTokens),
            prompt_tokens_details: Object.values(mergedPromptDetails).some((value) => typeof value === "number")
                ? mergedPromptDetails
                : undefined,
            completion_tokens_details: Object.values(mergedCompletionDetails).some((value) => typeof value === "number")
                ? mergedCompletionDetails
                : undefined,
            reserved_output_tokens: current.reserved_output_tokens,
            total_token_max: current.total_token_max,
        };

        return merged;
    }

    private logFinalUsageEnvelope(
        requestId: string,
        modelId: string,
        caller: string,
        usage: {
            tokensIn?: number;
            tokensOut?: number;
            cachedTokens?: number;
            cacheCreationInputTokens?: number;
            reasoningTokens?: number;
            toolTokens?: number;
            acceptedPredictionTokens?: number;
            rejectedPredictionTokens?: number;
            systemPromptTokens?: number;
            reservedOutputTokens?: number;
            totalTokenMax?: number;
            sawUsageDataPart: boolean;
        }
    ): void {
        Logger.debug(
            `[TokenUsage][Final] request_id=${requestId} model=${modelId} caller=${caller} ` +
                `tokens_in=${usage.tokensIn ?? "n/a"} tokens_out=${usage.tokensOut ?? "n/a"} ` +
                `cached_tokens=${usage.cachedTokens ?? "n/a"} cache_creation_input_tokens=${
                    usage.cacheCreationInputTokens ?? "n/a"
                } ` +
                `reasoning_tokens=${usage.reasoningTokens ?? "n/a"} tool_tokens=${usage.toolTokens ?? "n/a"} ` +
                `accepted_prediction_tokens=${usage.acceptedPredictionTokens ?? "n/a"} rejected_prediction_tokens=${
                    usage.rejectedPredictionTokens ?? "n/a"
                } ` +
                `system_prompt_tokens=${usage.systemPromptTokens ?? "n/a"} reserved_output_tokens=${
                    usage.reservedOutputTokens ?? "n/a"
                } ` +
                `total_token_max=${usage.totalTokenMax ?? "n/a"} streamed_usage=${usage.sawUsageDataPart}`
        );
    }

    private emitExperimentalUsageData(
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        tokensIn: number,
        tokensOut: number,
        reasoningTokens?: number,
        cachedTokens?: number,
        extra?: {
            systemPromptTokens?: number;
            toolTokens?: number;
            acceptedPredictionTokens?: number;
            rejectedPredictionTokens?: number;
            cacheCreationInputTokens?: number;
            reservedOutputTokens?: number;
            totalTokenMax?: number;
        }
    ): void {
        Logger.debug(
            `Emitting experimental usage data part | prompt_tokens: ${tokensIn} | completion_tokens: ${tokensOut} | reasoning_tokens: ${reasoningTokens ?? "undefined"} | cached_tokens: ${cachedTokens ?? "undefined"} | system_prompt_tokens: ${extra?.systemPromptTokens ?? "undefined"}`
        );

        const usagePayload: OpenAIUsagePayload = {
            prompt_tokens: tokensIn,
            completion_tokens: tokensOut,
            total_tokens: tokensIn + tokensOut,
        };

        const promptTokenDetails: OpenAIUsagePromptTokenDetails = {};
        if (typeof cachedTokens === "number") {
            promptTokenDetails.cached_tokens = cachedTokens;
        }
        if (typeof extra?.cacheCreationInputTokens === "number") {
            promptTokenDetails.cache_creation_input_tokens = extra.cacheCreationInputTokens;
        }
        if (Object.keys(promptTokenDetails).length > 0) {
            usagePayload.prompt_tokens_details = promptTokenDetails;
        }

        const completionTokenDetails: OpenAIUsageCompletionTokenDetails = {};
        if (typeof reasoningTokens === "number") {
            completionTokenDetails.reasoning_tokens = reasoningTokens;
        }
        if (typeof extra?.toolTokens === "number") {
            completionTokenDetails.tool_tokens = extra.toolTokens;
        }
        if (typeof extra?.acceptedPredictionTokens === "number") {
            completionTokenDetails.accepted_prediction_tokens = extra.acceptedPredictionTokens;
        }
        if (typeof extra?.rejectedPredictionTokens === "number") {
            completionTokenDetails.rejected_prediction_tokens = extra.rejectedPredictionTokens;
        }
        if (Object.keys(completionTokenDetails).length > 0) {
            usagePayload.completion_tokens_details = completionTokenDetails;
        }

        if (typeof extra?.systemPromptTokens === "number") {
            usagePayload.system_prompt_tokens = extra.systemPromptTokens;
        }
        if (typeof extra?.reservedOutputTokens === "number") {
            usagePayload.reserved_output_tokens = extra.reservedOutputTokens;
        }
        if (typeof extra?.totalTokenMax === "number") {
            usagePayload.total_token_max = extra.totalTokenMax;
        }

        const payloadJson = JSON.stringify(usagePayload);
        const payloadBytes = new TextEncoder().encode(payloadJson);

        progress.report(new vscode.LanguageModelDataPart(payloadBytes, "usage"));
    }

    async provideLanguageModelChatInformation(
        options: vscode.PrepareLanguageModelChatModelOptions,
        token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        // VS Code 1.120 expands the options shape to include `configuration` (per-group BYOK
        // values configured by the user). We pass the full options through to the base discovery
        // path so it can choose between configuration-based discovery (1.120 group system) and
        // legacy workspace-settings discovery transparently.
        const opts = options as vscode.PrepareLanguageModelChatModelOptions & {
            silent?: boolean;
            configuration?: Record<string, unknown>;
            groupName?: string;
        };
        return this.discoverModels(
            {
                silent: opts.silent ?? false,
                configuration: opts.configuration,
                groupName: opts.groupName,
            },
            token
        );
    }

    async provideTokenCount(
        model: LanguageModelChatInformation,
        text: string | LanguageModelChatRequestMessage,
        token: CancellationToken
    ): Promise<number> {
        return super.provideTokenCount(model, text, token);
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: readonly LanguageModelChatRequestMessage[],
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        this.resetStreamingState();
        const startTime = LiteLLMTelemetry.startTimer();
        const requestId = Math.random().toString(36).substring(7);

        // Check if vscode has thinking part API available.
        // Even if we are not the V2 provider, we can safely report thinking parts if the type exists.
        const ThinkingPart = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as
            | (new (
                  value: string | string[],
                  id?: string,
                  metadata?: Record<string, unknown>
              ) => vscode.LanguageModelResponsePart)
            | undefined;

        // Extract caller/justification from options or model tags
        const telemetry = this.getTelemetryOptions(options);
        const modelWithTags = model as vscode.LanguageModelChatInformation & { tags?: string[] };
        const caller = telemetry.caller || modelWithTags.tags?.[0] || "chat";
        const justification = telemetry.justification;

        if (this._telemetryService) {
            // We do not need the excess noise here.  But this block is useful...
            // this._telemetryService.captureFeatureUsed("chat", "chat");
            this._telemetryService.captureModelUsed(model.id, caller);
        }

        let tokensIn: number | undefined;

        Logger.info(
            `Chat request started | RequestID: ${requestId} | Model: ${model.id} | Caller: ${caller} | Justification: ${
                justification || "none"
            }`
        );

        let reservedOutputTokensForRequest: number | undefined;
        let totalTokenMaxForRequest: number | undefined;

        const trackingProgress: Progress<LanguageModelResponsePart> = {
            report: (part) => {
                if (part instanceof vscode.LanguageModelTextPart) {
                    this._partialAssistantText += part.value;
                } else if (ThinkingPart && part instanceof ThinkingPart) {
                    // Accumulate thinking tokens as well to count total output tokens accurately
                    const tp = part as unknown as { value: string | string[] };
                    this._partialAssistantText += Array.isArray(tp.value) ? tp.value.join("") : tp.value;
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    this._estimatedToolCallTokens += countTokens(`${part.name}${JSON.stringify(part.input ?? {})}`);
                } else if (part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage") {
                    try {
                        this._sawUsageDataPart = true;
                        const parsed = JSON.parse(Buffer.from(part.data).toString("utf-8")) as OpenAIUsagePayload;
                        const completionTokenDetails: OpenAIUsageCompletionTokenDetails = {
                            ...(parsed.completion_tokens_details ?? {}),
                        };
                        if (completionTokenDetails.tool_tokens === undefined && this._estimatedToolCallTokens > 0) {
                            completionTokenDetails.tool_tokens = this._estimatedToolCallTokens;
                        }

                        const enrichedUsage: OpenAIUsagePayload = {
                            ...parsed,
                            completion_tokens_details:
                                Object.keys(completionTokenDetails).length > 0 ? completionTokenDetails : undefined,
                            reserved_output_tokens: parsed.reserved_output_tokens ?? reservedOutputTokensForRequest,
                            total_token_max: parsed.total_token_max ?? totalTokenMaxForRequest,
                        };

                        const mergedUsage = this.mergeUsagePayloadWithLastKnown(enrichedUsage);

                        this._lastStreamUsage = {
                            promptTokens: mergedUsage.prompt_tokens,
                            completionTokens: mergedUsage.completion_tokens,
                            systemTokens: mergedUsage.system_prompt_tokens,
                            cachedTokens: mergedUsage.prompt_tokens_details?.cached_tokens,
                            cacheCreationInputTokens: mergedUsage.prompt_tokens_details?.cache_creation_input_tokens,
                            reasoningTokens: mergedUsage.completion_tokens_details?.reasoning_tokens,
                            toolTokens: mergedUsage.completion_tokens_details?.tool_tokens,
                            acceptedPredictionTokens: mergedUsage.completion_tokens_details?.accepted_prediction_tokens,
                            rejectedPredictionTokens: mergedUsage.completion_tokens_details?.rejected_prediction_tokens,
                        };

                        const enrichedBytes = new TextEncoder().encode(JSON.stringify(mergedUsage));
                        progress.report(new vscode.LanguageModelDataPart(enrichedBytes, "usage"));
                        return;
                    } catch {
                        // ignore malformed usage payload
                    }
                }
                progress.report(part);
            },
        };

        try {
            const config = await this._configManager.getConfig();

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
            const estimatedTransportInputTokens =
                countOpenAIChatMessagesTokens(requestBody.messages, modelToUse.id, modelInfo) +
                estimateToolTokens(requestBody.tools);
            const reservedOutputTokens = getReservedOutputTokens(modelToUse, requestBody.max_tokens, {
                estimatedInputTokens: estimatedTransportInputTokens,
                modelInfo,
            });
            const totalTokenMax = getTotalTokenLimit(modelToUse, modelInfo);
            reservedOutputTokensForRequest = reservedOutputTokens;
            totalTokenMaxForRequest = totalTokenMax;

            // Count the actual transport request after trimming/conversion.
            tokensIn = estimatedTransportInputTokens;

            let stream: ReadableStream<Uint8Array>;
            try {
                // Note: sendRequestWithRetry may fully handle /responses by emitting directly to progress.
                // In that case it returns an already-closed stream.
                stream = await this.sendRequestWithRetry(
                    requestBody,
                    messages,
                    modelToUse,
                    options,
                    trackingProgress,
                    token,
                    caller,
                    modelInfo
                );
            } catch (err: unknown) {
                this.logRequestPayloadOnFailure(requestBody, err, {
                    stage: "provideLanguageModelChatResponse",
                    modelId: modelToUse.id,
                    caller,
                    modelInfoMode: modelInfo?.mode,
                });

                if (token.isCancellationRequested) {
                    throw new Error("Operation cancelled by user", { cause: err });
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

                        if (
                            parsedMessage.toLowerCase().includes("stream_options") ||
                            parsedMessage.toLowerCase().includes("include_usage")
                        ) {
                            (this as unknown as { _usageOptOutModels: Set<string> })._usageOptOutModels.add(model.id);
                            delete (requestBody as { stream_options?: { include_usage?: boolean } }).stream_options;
                        }

                        if (token.isCancellationRequested) {
                            throw new Error("Operation cancelled by user", { cause: err });
                        }
                        try {
                            stream = await this.sendRequestWithRetry(
                                requestBody,
                                messages,
                                modelToUse,
                                options,
                                trackingProgress,
                                token,
                                caller,
                                modelInfo
                            );
                            await this.processStreamingResponse(stream, trackingProgress, token);

                            // Estimate tokensOut from the accumulated assistant text
                            const tokensOut = countTokens(this._partialAssistantText, modelToUse.id, modelInfo);

                            const metric = {
                                requestId,
                                model: modelToUse.id,
                                durationMs: LiteLLMTelemetry.endTimer(startTime),
                                tokensIn,
                                tokensOut,
                                status: "success" as const,
                                caller,
                            };
                            LiteLLMTelemetry.reportMetric(metric);
                            this.logFinalUsageEnvelope(requestId, modelToUse.id, caller, {
                                tokensIn,
                                tokensOut,
                                sawUsageDataPart: this._sawUsageDataPart,
                            });

                            // Disabling this to reduce noise / unecessary logging
                            // TODO: look into potentially removing this in the future if don't need it.
                            /* if (this._telemetryService) {
                                this._telemetryService.captureChatRequest({
                                    request_id: requestId,
                                    caller,
                                    model: modelToUse.id,
                                    endpoint: modelInfo?.mode ?? "chat",
                                    durationMs: metric.durationMs,
                                    tokensIn: tokensIn ?? 0,
                                    tokensOut,
                                    status: "success",
                                });
                            } */
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
                            throw new Error(retryErrorMessage, { cause: retryErr });
                        }
                    } else {
                        throw err;
                    }
                } else {
                    throw err;
                }
            }

            await this.processStreamingResponse(stream, trackingProgress, token);

            const usage = this._lastStreamUsage;
            const tokensOut =
                usage?.completionTokens ??
                countTokens(this._partialAssistantText, modelToUse.id, modelInfo) + this._estimatedToolCallTokens;
            const tokensInForTelemetry = usage?.promptTokens ?? tokensIn;
            const reasoningTokens = usage?.reasoningTokens;
            const cachedTokens = usage?.cachedTokens;
            const systemPromptTokens = usage?.systemTokens;
            const toolTokens =
                usage?.toolTokens ?? (this._estimatedToolCallTokens > 0 ? this._estimatedToolCallTokens : undefined);
            const acceptedPredictionTokens = usage?.acceptedPredictionTokens;
            const rejectedPredictionTokens = usage?.rejectedPredictionTokens;
            const cacheCreationInputTokens = usage?.cacheCreationInputTokens;

            const metric = {
                requestId,
                model: modelToUse.id,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                tokensIn: tokensInForTelemetry,
                tokensOut,
                promptCacheTokens: cachedTokens,
                cacheCreationInputTokens,
                reasoningTokens,
                toolTokens,
                acceptedPredictionTokens,
                rejectedPredictionTokens,
                reservedOutputTokens,
                totalTokenMax,
                status: "success" as const,
                caller,
                cacheReadRatio:
                    cachedTokens !== undefined && tokensInForTelemetry
                        ? cachedTokens / tokensInForTelemetry
                        : undefined,
            };
            LiteLLMTelemetry.reportMetric(metric);
            this.logFinalUsageEnvelope(requestId, modelToUse.id, caller, {
                tokensIn: tokensInForTelemetry,
                tokensOut,
                cachedTokens,
                cacheCreationInputTokens,
                reasoningTokens,
                toolTokens,
                acceptedPredictionTokens,
                rejectedPredictionTokens,
                systemPromptTokens,
                reservedOutputTokens,
                totalTokenMax,
                sawUsageDataPart: this._sawUsageDataPart,
            });

            // Disabling this to reduce noise / unecessary logging
            // TODO: look into potentially removing this in the future if don't need it.
            /*
            if (this._telemetryService) {
                this._telemetryService.captureChatRequest({
                    request_id: requestId,
                    caller,
                    model: modelToUse.id,
                    endpoint: modelInfo?.mode ?? "chat",
                    durationMs: metric.durationMs,
                    tokensIn: tokensIn ?? 0,
                    tokensOut,
                    status: "success",
                });
            }
            */

            if (
                config.experimentalEmitUsageData &&
                typeof tokensInForTelemetry === "number" &&
                !this._sawUsageDataPart
            ) {
                this.emitExperimentalUsageData(
                    trackingProgress,
                    tokensInForTelemetry,
                    tokensOut,
                    reasoningTokens,
                    cachedTokens,
                    {
                        systemPromptTokens,
                        toolTokens,
                        acceptedPredictionTokens,
                        rejectedPredictionTokens,
                        cacheCreationInputTokens,
                        reservedOutputTokens,
                        totalTokenMax,
                    }
                );
            }
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

            const metric = {
                requestId,
                model: model.id,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                tokensIn,
                status: "failure" as const,
                error: errorMessage,
                caller,
            };
            LiteLLMTelemetry.reportMetric(metric);

            if (this._telemetryService) {
                this._telemetryService.captureChatRequest({
                    request_id: requestId,
                    caller,
                    model: model.id,
                    endpoint: "unknown",
                    durationMs: metric.durationMs,
                    tokensIn: tokensIn ?? 0,
                    tokensOut: 0,
                    status: "failure",
                    error: errorMessage,
                    stack: err instanceof Error ? err.stack : undefined,
                });
            }
            throw new Error(errorMessage, { cause: err });
        }
    }

    protected resetStreamingState(): void {
        this._streamingState = createInitialStreamingState();
        this._partialAssistantText = "";
        this._lastStreamUsage = undefined;
        this._sawUsageDataPart = false;
        this._estimatedToolCallTokens = 0;
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
