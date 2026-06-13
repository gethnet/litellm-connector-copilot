import type * as vscode from "vscode";
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
import { StructuredLogger } from "../observability/structuredLogger";
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
import { StreamTokenCapture } from "../adapters/streaming/streamTokenCapture";

/**
 * Chat provider implementation for VS Code's LanguageModelChatProvider.
 *
 * All shared orchestration (model discovery, request building, trimming, parameter filtering,
 * endpoint routing) is implemented in LiteLLMProviderBase.
 */
export class LiteLLMChatProvider extends LiteLLMProviderBase implements LanguageModelChatProvider {
    // Streaming state
    private _streamingState: StreamingState = createInitialStreamingState();
    private _tokenCapture?: StreamTokenCapture;

    constructor(secrets: vscode.SecretStorage, userAgent: string, effortFallbackCache?: EffortFallbackCache) {
        super(secrets, userAgent, effortFallbackCache);
    }

    /************************************************
     * TODO: REMOVE IF UNUSED IN VERSION 2.3
     * REASON: Saving in the event this code is
     *       actually necessary.
     *  REMOVE BY: V2.3
     *  CONDITION: IF UNUSED/COMMENTED
     */
    /*
    private mergeUsagePayloadWithLastKnown(current: OpenAIUsagePayload): OpenAIUsagePayload {
        const previous = this._tokenCapture?.getSnapshot();
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
            system_prompt_tokens: pickMonotonicTokenCount(current.system_prompt_tokens, previous.systemPromptTokens),
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
*/
    /************************************************
     * End of code block
     ***********************************************/

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
        token: CancellationToken,
        configuration?: Record<string, unknown>
    ): Promise<number> {
        return super.provideTokenCount(model, text, token, configuration);
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
        /************************************************
         * TODO: REMOVE IF UNUSED IN VERSION 2.3
         * REASON: Saving in the event this code is
         *       actually necessary.
         *  REMOVE BY: V2.3
         *  CONDITION: IF UNUSED/COMMENTED
         */
        /*
        const ThinkingPart = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as
            | (new (
                  value: string | string[],
                  id?: string,
                  metadata?: Record<string, unknown>
              ) => vscode.LanguageModelResponsePart)
            | undefined;
*/
        /************************************************
         * End of code block
         ***********************************************/
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
        Logger.trace(
            `Chat request: received model id="${model.id}" name="${model.name}" hasOptionsConfig=${(options as { configuration?: unknown }).configuration !== undefined}`
        );

        // <Line of Code>; // TODO: Remove by v2.3 if still commented
        // let reservedOutputTokensForRequest: number | undefined;
        // let totalTokenMaxForRequest: number | undefined;

        // Capability lookups go directly to the BackendRegistry — the single
        // source of truth. There is no per-provider mirror cache, so a stale
        // entry from a previous backend cannot be served for a different
        // backend's request.
        const modelInfo = this._registry.getModelInfo(model.id);
        // `StreamTokenCapture` uses the model id for `countTokens` heuristics
        // (tokenizer family lookup). The namespaced id breaks those heuristics,
        // so we hand it the raw model name instead.
        this._tokenCapture = new StreamTokenCapture(this.getRawModelName(model.id), progress, modelInfo);
        const tokenCapture = this._tokenCapture;
        const trackingProgress = tokenCapture.progress;

        try {
            const config = await this._configManager.getConfig();

            // Optional model override (primarily for completions). If set, we try to use it.
            // If the override isn't registered yet, attempt a best-effort refresh.
            //
            // The override is a RAW model name (e.g. `azure_ai/gpt-5.4-mini`),
            // not the namespaced id. The registry is keyed by namespaced id, so
            // we use `findBackendForRawName` to resolve the override back to a
            // backend before adopting it.
            let modelToUse = model;
            if (config.modelIdOverride) {
                const overrideId = config.modelIdOverride;
                if (this._registry.findBackendForRawName(overrideId)) {
                    Logger.trace(
                        `Chat request: applying modelIdOverride overrideId="${overrideId}" originalModelId="${model.id}"`
                    );
                    // The override is reachable; we know its baseUrl/apiKey from
                    // the registry. Synthesize a minimal LanguageModelChatInformation
                    // that VS Code will accept (it only needs the id and family
                    // for downstream request building).
                    modelToUse = {
                        ...model,
                        id: overrideId,
                    };
                } else {
                    try {
                        Logger.info(`modelIdOverride set to '${overrideId}' but not registered; refreshing model list`);
                        await this.discoverModels({ silent: true }, token);
                        if (this._registry.findBackendForRawName(overrideId)) {
                            Logger.trace(
                                `Chat request: applying modelIdOverride after refresh overrideId="${overrideId}" originalModelId="${model.id}"`
                            );
                            modelToUse = { ...model, id: overrideId };
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
            Logger.trace(
                `Chat request: modelToUse.id="${modelToUse.id}" rawModelName="${this.getRawModelName(modelToUse.id)}"`
            );

            // Capability lookup goes directly to the BackendRegistry. The
            // `modelToUse.id` is either the namespaced id VS Code handed us
            // or, when `modelIdOverride` rewrote it, the raw model name; the
            // registry's `lookup` will return `undefined` for the raw-name
            // case and `getModelInfo` will also return `undefined` for it
            // (capabilities are stored under the namespaced key), so the
            // request builder will use the override path's defaults. This
            // is the same single-source-of-truth read as above.
            const modelInfo = this._registry.getModelInfo(modelToUse.id);
            const requestBody = await this.buildOpenAIChatRequest(messages, modelToUse, options, modelInfo, caller);
            // The model id in `modelToUse` is the namespaced `<routing>/<raw>`
            // form VS Code hands us. The tokenizer heuristics (and the
            // `isParameterSupported` / `usageOptOutModels` lookups inside the
            // request builder) key off the raw model family, not the routing
            // prefix. The request builder extracts the raw name internally
            // before populating `request.model`.
            const rawModelIdForTokenizers = this.getRawModelName(modelToUse.id);
            const estimatedTransportInputTokens =
                countOpenAIChatMessagesTokens(requestBody.messages, rawModelIdForTokenizers, modelInfo) +
                estimateToolTokens(requestBody.tools);
            const reservedOutputTokens = getReservedOutputTokens(modelToUse, requestBody.max_tokens, {
                estimatedInputTokens: estimatedTransportInputTokens,
                modelInfo,
            });
            const totalTokenMax = getTotalTokenLimit(modelToUse, modelInfo);
            // <Line of Code>; // TODO: Remove by v2.3 if still commented
            // reservedOutputTokensForRequest = reservedOutputTokens;
            // totalTokenMaxForRequest = totalTokenMax;
            tokenCapture.setEstimatedPromptTokens(estimatedTransportInputTokens);
            const systemPromptContent = requestBody.messages.find((m) => m.role === "system")?.content;
            if (typeof systemPromptContent === "string") {
                tokenCapture.setEstimatedSystemPromptTokens(
                    countTokens(systemPromptContent, rawModelIdForTokenizers, modelInfo)
                );
            }
            tokenCapture.setReservedOutputTokens(reservedOutputTokens);
            tokenCapture.setTotalTokenMax(totalTokenMax);

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

                            // Flush usage after processing the retried stream

                            tokenCapture.flushUsage();

                            const snapshot = tokenCapture.getSnapshot();
                            const tokensOut = snapshot.completionTokens;

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
                                sawUsageDataPart: snapshot.sawUpstreamUsage,
                            });

                            // Return early - all processing complete, prevent fall-through
                            // to avoid double-processing the already-consumed stream
                            return;

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

            // Flush usage data if no upstream usage was seen during streaming
            // This ensures usage is always reported to VS Code
            const capture = this._tokenCapture;
            if (capture) {
                capture.flushUsage();
            }

            const snapshot = capture?.getSnapshot() ?? {
                promptTokens: tokensIn ?? 0,
                cachedTokens: 0,
                cacheCreationInputTokens: 0,
                systemPromptTokens: 0,
                completionTokens: 0,
                reasoningTokens: 0,
                toolTokens: 0,
                acceptedPredictionTokens: 0,
                rejectedPredictionTokens: 0,
                sawUpstreamUsage: false,
            };
            const tokensOut = Math.max(snapshot.completionTokens, snapshot.toolTokens);
            const tokensInForTelemetry = snapshot.promptTokens ?? tokensIn;
            const reasoningTokens = snapshot.reasoningTokens || undefined;
            const cachedTokens = snapshot.cachedTokens || undefined;
            const systemPromptTokens = snapshot.systemPromptTokens || undefined;
            const toolTokens = snapshot.toolTokens || undefined;
            const acceptedPredictionTokens = snapshot.acceptedPredictionTokens || undefined;
            const rejectedPredictionTokens = snapshot.rejectedPredictionTokens || undefined;
            const cacheCreationInputTokens = snapshot.cacheCreationInputTokens || undefined;

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
                sawUsageDataPart: snapshot.sawUpstreamUsage,
            });

            // Usage data is now handled exclusively by StreamTokenCapture
            // which intercepts usage DataParts during streaming and enriches them
            // No need for separate emitExperimentalUsageData call

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
            // Node.js wraps network failures (ECONNREFUSED, DNS errors) as
            // "TypeError: fetch failed" without surfacing the root cause in
            // the error message. Extract the chained `.cause` so operators
            // see the real reason (e.g. ECONNREFUSED) rather than a generic label.
            const rootCause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
            Logger.error("Chat request failed", err);
            if (rootCause) {
                StructuredLogger.error("request.fetch_failed", {
                    model: model.id,
                    cause: rootCause,
                    requestId,
                });
            }

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
        this._tokenCapture = undefined;
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

        // Create an AbortController to actually cancel the stream on timeout
        const controller = new AbortController();

        const resetWatchdog = () => {
            if (watchdog) {
                clearTimeout(watchdog);
            }
            watchdog = setTimeout(() => {
                Logger.warn(`Inactivity timeout after ${timeoutMs}ms`);
                controller.abort();
            }, timeoutMs);
        };

        token.onCancellationRequested(() => {
            if (watchdog) {
                clearTimeout(watchdog);
            }
            controller.abort();
        });

        try {
            resetWatchdog();
            for await (const payload of decodeSSE(responseBody, token, controller.signal)) {
                resetWatchdog();

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
                emitPartsToVSCode(parts, progress);
            }
        } catch (error: unknown) {
            StructuredLogger.error("stream.process_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
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
