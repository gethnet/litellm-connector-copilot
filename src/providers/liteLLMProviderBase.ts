import * as vscode from "vscode";
import { LiteLLMClient } from "../adapters/litellmClient";
import type {
    LanguageModelChatInformation,
    LanguageModelChatRequestMessage,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";

import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../types";
import { convertMessages, convertTools, normalizeMessagesForV2Pipeline } from "../utils";
import {
    trimMessagesToFitBudget,
    estimateToolTokens,
    isContextOverflowError,
    countTokens,
} from "../adapters/tokenUtils";
import { countTokensForV2Messages } from "../adapters/tokenUtils";
import { ConfigManager } from "../config/configManager";
import { Logger } from "../utils/logger";
import type { TelemetryService } from "../telemetry/telemetryService";
import type { ReviewPromptService } from "../engagement/reviewPromptService";
import { getSupportedReasoningEfforts } from "../utils/modelCapabilities";
import type { SupportedReasoningEffort } from "../types";
import {
    EffortFallbackCache,
    hasShownReasoningFallbackNotification,
    isReasoningError,
    markReasoningFallbackNotified,
} from "../utils/reasoningEffortFallback";
import type { V2ChatMessage } from "./v2Types";
import type { BackendSession } from "./backendSession";
import { RequestBuilder } from "./base/requestBuilder";
import { Transport } from "./base/transport";
import type { RequestBuilderDeps, TransportDeps } from "./base/types";
import { LiteLLMProviderRegistry } from "./liteLLMProviderRegistry";
import {
    detectQuotaToolRedaction as detectQuotaToolRedactionImpl,
    sanitizeErrorTextForLogs as sanitizeErrorTextForLogsImpl,
    collectMessageText as collectMessageTextImpl,
    logRequestPayloadOnFailure as logRequestPayloadOnFailureImpl,
} from "./base/quotaRedaction";
import {
    isParameterSupported as isParameterSupportedImpl,
    stripUnsupportedParametersFromRequest as stripUnsupportedParametersFromRequestImpl,
} from "./base/parameterFiltering";
import { resolveCallTimeConfiguration } from "./base/callConfig";
import { LRUCache } from "../utils/lruCache";
import { AuditTrail } from "../observability/auditTrail";

/**
 * Shared orchestration base for all LiteLLM-backed VS Code language model providers.
 *
 * Single-provider architecture: every request is routed to the backend whose
 * configuration VS Code passes on the originating call (`options.configuration`).
 * We do NOT maintain a global cross-backend model list or parse model IDs to
 * resolve a backend. VS Code already isolates per-group calls; our job is to
 * honor that and not second-guess it.
 *
 * Responsibilities:
 * - Wiring the BackendRegistry's `onDidChange` event to VS Code's
 *   `onDidChangeLanguageModelChatInformation` so the picker refreshes when
 *   a backend's model set actually changes.
 * - Shared request ingress pipeline (normalize, validate, filter, trim)
 * - Endpoint routing (via call-time configuration)
 * - Shared error parsing and capability mapping
 * - Shared quota/tool-redaction heuristics
 *
 * Non-responsibilities:
 * - Model discovery (lives in the BackendRegistry — see
 *   `LiteLLMProviderRegistry.discoverModels`).
 * - VS Code protocol specifics (stream parsing, response part emission)
 * - Cross-backend routing (handled by VS Code 1.120 per-group config)
 */
export abstract class LiteLLMProviderBase {
    protected readonly _configManager: ConfigManager;
    protected readonly _onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformationEmitter.event;

    /**
     * The BackendRegistry — single source of truth for backends and their
     * associated models. The base provider subscribes to its `onDidChange`
     * event and forwards it to VS Code. The provider does NOT have a
     * separate discovery class; the registry owns discovery, namespacing,
     * change detection, and the per-model capability caches.
     */
    protected readonly _registry: LiteLLMProviderRegistry;

    private readonly _requestBuilder: RequestBuilder;
    private readonly _transport: Transport;
    protected readonly _effortFallbackCache: EffortFallbackCache;
    // Per-session memo of models that have rejected `stream_options.include_usage`
    // on a live upstream call. NOT a model-info cache: it cannot be corrupted by
    // stale capability data and it is keyed by the namespaced id VS Code hands
    // back at request time. Without this, the request builder would re-send
    // `include_usage: true` on every request to a model that previously rejected
    // it, causing an infinite retry loop.
    private _usageOptOutModels = new Set<string>();

    protected _telemetryService?: TelemetryService;
    protected _reviewPromptService?: ReviewPromptService;

    private _onModernConfigurationDetected?: () => void;

    constructor(
        protected readonly secrets: vscode.SecretStorage,
        protected readonly userAgent: string,
        effortFallbackCache?: EffortFallbackCache
    ) {
        this._configManager = new ConfigManager(secrets);
        this._effortFallbackCache = effortFallbackCache ?? new EffortFallbackCache();
        this._registry = new LiteLLMProviderRegistry({
            configManager: this._configManager,
            userAgent: this.userAgent,
            onModernConfigurationDetected: () => {
                this._onModernConfigurationDetected?.();
            },
        });

        // Forward the registry's `onDidChange` event to VS Code so the
        // picker refreshes when a backend's model set actually changes.
        this._registry.onDidChange(() => {
            Logger.info("Firing onDidChangeLanguageModelChatInformation (from BackendRegistry.onDidChange)");
            this._onDidChangeLanguageModelChatInformationEmitter.fire();
        });

        const requestBuilderDeps: RequestBuilderDeps = {
            configManager: this._configManager,
            getReasoningEffort: this.getReasoningEffort.bind(this),
            detectQuotaToolRedaction: this.detectQuotaToolRedaction.bind(this),
            stripUnsupportedParametersFromRequest: this.stripUnsupportedParametersFromRequest.bind(this),
            isParameterSupported: this.isParameterSupported.bind(this),
            getTelemetryOptions: this.getTelemetryOptions.bind(this),
            usageOptOutModels: this._usageOptOutModels,
            extractRawModelName: (modelId: string) => this.getRawModelName(modelId),
        };
        this._requestBuilder = new RequestBuilder(requestBuilderDeps);

        const transportDeps: TransportDeps = {
            configManager: this._configManager,
            userAgent: this.userAgent,
            logger: Logger,
            liteLLMClientFactory: (backend) =>
                new LiteLLMClient(
                    { url: backend.url, key: backend.key, disableCaching: backend.disableCaching },
                    this.userAgent
                ),
        };
        this._transport = new Transport(transportDeps);
    }

    public setTelemetryService(service: TelemetryService): void {
        this._telemetryService = service;
    }

    /**
     * Supplies the activation-owned review prompt service. The base class only stores this
     * optional dependency; chat protocol code decides which request outcomes count as turns.
     */
    public setReviewPromptService(service: ReviewPromptService): void {
        this._reviewPromptService = service;
    }

    /**
     * Registers a callback fired when VS Code per-group provider configuration is
     * present and passes syntactic validation. Extension activation uses this to
     * persist a one-time "modern config seen" session flag and suppress legacy prompts.
     */
    public setModernConfigurationDetectedHandler(handler: () => void): void {
        this._onModernConfigurationDetected = handler;
    }

    /** Exposes the ConfigManager for external access (e.g., commands that need configuration). */
    public getConfigManager(): ConfigManager {
        return this._configManager;
    }

    /** Signals VS Code to refresh the Language Models view for this provider. */
    public refreshModelInformation(): void {
        Logger.info("Firing onDidChangeLanguageModelChatInformation");
        this._onDidChangeLanguageModelChatInformationEmitter.fire();
    }

    /**
     * Clears the registry's routing table and capability caches, then
     * refreshes the VS Code picker. There is no other model-info cache on
     * the base provider — capability lookups always go through the
     * registry, which is the single source of truth.
     */
    public clearModelCache(): void {
        Logger.info("Clearing model discovery cache");
        this._registry.clear();
        this._registry.clearCaches();
        this.refreshModelInformation();
        Logger.info("Cleared cache");
    }

    /**
     * Clears all session-scoped caches to free memory on extension deactivation.
     * Called from extension.ts in the deactivate hook.
     *
     * Clears:
     * - Token count cache (LRU, but still freed for clean shutdown)
     * - Pending token count requests
     * - Effort fallback cache (reasoning effort fallback state)
     * - Audit trail events (all request history)
     */
    public clearSessionCaches(): void {
        Logger.info("Clearing session-scoped caches");
        // Note: Token count cache and pending requests maps are module-level static collections
        // They are cleared implicitly when the provider instance is destroyed and garbage collected.
        // Explicit clearing here is for documentation and future refactoring.

        // Clear the effort fallback cache
        this._effortFallbackCache.clear();
        Logger.debug("clearSessionCaches", "Effort fallback cache cleared");

        // Clear audit trail
        AuditTrail.clear();
        Logger.debug("clearSessionCaches", "Audit trail cleared");

        Logger.info("Session caches cleared");
    }

    /**
     * Returns a defensive copy of the latest successful discovery view for
     * display-only commands such as "LiteLLM: Show Available Models".
     *
     * This is not a request-routing cache. Response-time routing continues to
     * resolve the backend through per-call configuration and registry.lookup().
     */
    public getLastKnownModels(): LanguageModelChatInformation[] {
        return this._registry.getDisplayedModels();
    }

    /**
     * Public access to model info from the registry's capability cache.
     */
    public getModelInfo(modelId: string): LiteLLMModelInfo | undefined {
        return this._registry.getModelInfo(modelId);
    }

    /**
     * Resolves the active backend session for a request by honoring the
     * per-group configuration passed on the call. The completion and commit
     * paths (which don't receive `options.configuration` from VS Code) MUST
     * pass `undefined` and we return `undefined` — those paths surface a
     * configuration-required error to the user instead of silently
     * mis-routing to a stale global state.
     *
     * `groupName` is the user-entered label from VS Code's 1.120 group picker.
     * It is optional and is used only for the picker's display label; routing
     * is URL-driven.
     */
    protected resolveBackendForCall(
        configuration: Record<string, unknown> | undefined,
        groupName?: string
    ): BackendSession | undefined {
        if (!configuration) {
            return undefined;
        }
        return this._configManager.convertProviderConfiguration(groupName ?? "", configuration);
    }

    /**
     * Provides a best-effort token count for small inputs and optionally refines large inputs
     * in the background using the LiteLLM remote counter.
     */
    public async provideTokenCount(
        model: LanguageModelChatInformation,
        text: string | LanguageModelChatRequestMessage,
        token: vscode.CancellationToken,
        configuration?: Record<string, unknown>
    ): Promise<number> {
        // `model.id` is the namespaced `<routing>/<raw>` form. The capability
        // cache, the tokenizer heuristics, and the LiteLLM request body all
        // need the raw model name. The modelInfoCache is keyed by namespaced
        // id, so we look it up with the namespaced id; everything else uses
        // the raw name.
        const modelInfo = this._registry.getModelInfo(model.id);
        const rawModelId = this.getRawModelName(model.id);
        const localCount = countTokens(text, rawModelId, modelInfo);

        if (token.isCancellationRequested) {
            return localCount;
        }

        const cacheKey = `${model.id}:${typeof text === "string" ? text.length : JSON.stringify(text)}`;
        const cached = tokenCountCache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }

        if (typeof text === "string" && text.length < 500) {
            return localCount;
        }

        if (pendingRequests.has(cacheKey)) {
            return localCount;
        }

        const request =
            typeof text === "string"
                ? { model: rawModelId, prompt: text }
                : { model: rawModelId, messages: convertMessages([text]) };

        const countPromise = (async (): Promise<number> => {
            // Timeout guard: if the promise takes longer than 5 seconds, force cleanup
            // This prevents accumulation of orphaned promises in long-running sessions
            const orphanTimeoutMs = 5000;
            let timeoutHandle: NodeJS.Timeout | undefined;

            try {
                if (token.isCancellationRequested) {
                    return localCount;
                }

                const backend = this.resolveBackendForCall(configuration);
                if (!backend) {
                    return localCount;
                }

                // Thread disableCaching for cache-bypass consistency on the
                // countTokens path. Fetch the workspace config once; the cost
                // is negligible next to the HTTP round-trip. Without this the
                // token-counting requests bypass the cache-bypass that the
                // request hot path now applies (Step 2 of the original plan).
                const countCfg = await this._configManager.getConfig();
                const singleClient = new LiteLLMClient(
                    { url: backend.baseUrl, key: backend.apiKey, disableCaching: countCfg.disableCaching },
                    this.userAgent
                );

                // Set up orphan cleanup timeout (will delete from pendingRequests if exceeded)
                timeoutHandle = setTimeout(() => {
                    if (pendingRequests.has(cacheKey)) {
                        Logger.debug(
                            "countTokens",
                            `Cleaning up orphaned token count request after ${orphanTimeoutMs}ms`,
                            {
                                cacheKey,
                            }
                        );
                        pendingRequests.delete(cacheKey);
                    }
                }, orphanTimeoutMs);

                const result = await singleClient.countTokens({ ...request, model: rawModelId }, token);
                if (
                    result?.token_count !== undefined &&
                    result.token_count !== null &&
                    !token.isCancellationRequested
                ) {
                    tokenCountCache.set(cacheKey, result.token_count);
                    return result.token_count;
                }
                return localCount;
            } catch {
                return localCount;
            } finally {
                // Always clear the timeout and the pending entry
                if (timeoutHandle !== undefined) {
                    clearTimeout(timeoutHandle);
                }
                pendingRequests.delete(cacheKey);
            }
        })();

        pendingRequests.set(cacheKey, countPromise);
        void countPromise;
        return localCount;
    }

    /**
     * Fetches the model list from the LiteLLM proxy for a specific group.
     *
     * Thin pass-through to the `BackendRegistry.discoverModels` ingress.
     * The registry owns the HTTP fetch, the per-group namespacing, and the
     * change detection; this method just refreshes the per-model
     * capability cache for downstream consumers (request builder, token
     * utilities) and returns the model list.
     *
     * Vendor-level calls (no `options.configuration`) return `[]`
     * immediately, matching the single-provider architecture: only
     * per-group calls have anything to discover.
     */
    public async discoverModels(
        options: {
            silent?: boolean;
            configuration?: Record<string, unknown>;
            groupName?: string;
        },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        // Vendor-level calls (no options.configuration) must return [] immediately
        // without firing onDidChangeLanguageModelChatInformation.
        if (!options.configuration) {
            return [];
        }

        // The registry is the single source of truth: it owns discovery,
        // namespacing, change detection, AND the per-model capability cache.
        // It also fires its `onDidChange` event when the model set for a
        // given baseUrl actually changes; we subscribed in the constructor
        // and forward that to VS Code. There is no mirror cache on the base
        // provider — every `getModelInfo` call goes straight to the registry.
        return await this._registry.discoverModels(options, token);
    }

    /**
     * Extended options including internal telemetry fields.
     */
    protected getTelemetryOptions(options: vscode.ProvideLanguageModelChatResponseOptions): {
        caller?: string;
        justification?: string;
        modelConfiguration?: Record<string, unknown>;
    } {
        const opt = options as vscode.ProvideLanguageModelChatResponseOptions & {
            caller?: string;
            justification?: string;
            // VS Code 1.120 per-group provider config (baseUrl, apiKey, providerName).
            configuration?: Record<string, unknown>;
            // Per-model picker selections (reasoningEffort, etc.) from configurationSchema.
            modelConfiguration?: Record<string, unknown>;
        };

        // The two configuration objects serve different purposes:
        //   opt.configuration      — provider group config (baseUrl, apiKey) — always present when using 1.120 BYOK
        //   opt.modelConfiguration — per-model picker selections (reasoningEffort) — present when user changes effort
        const modelConfig: Record<string, unknown> = {
            ...(opt.configuration ?? {}),
            ...(opt.modelConfiguration ?? {}),
        };

        return {
            caller: opt.caller,
            justification: opt.justification,
            modelConfiguration: modelConfig,
        };
    }

    /**
     * Extracts reasoning effort from the modelConfiguration (preferred) or from
     * modelOptions. Returns the effort string ONLY when the user (or caller) has
     * explicitly selected one.
     */
    protected getReasoningEffort(
        options: ProvideLanguageModelChatResponseOptions,
        model: LanguageModelChatInformation,
        modelInfoOverride?: LiteLLMModelInfo
    ): string | undefined {
        const telemetry = this.getTelemetryOptions(options);
        const modelInfo = modelInfoOverride ?? this._registry.getModelInfo(model.id);

        Logger.debug(`[getReasoningEffort] modelId: ${model.id}`);
        Logger.debug(`[getReasoningEffort] modelInfo from cache: ${JSON.stringify(modelInfo)}`);
        Logger.debug(`[getReasoningEffort] modelInfoOverride: ${JSON.stringify(modelInfoOverride)}`);

        const pickerEffort = telemetry.modelConfiguration?.reasoningEffort;
        Logger.debug(`[getReasoningEffort] pickerEffort (from modelConfiguration): ${pickerEffort}`);
        if (typeof pickerEffort === "string") {
            Logger.debug(`[getReasoningEffort] Returning pickerEffort without validation: ${pickerEffort}`);
            return pickerEffort;
        }

        const modelOptions = (options.modelOptions as Record<string, unknown> | undefined) ?? {};
        const overrideEffort = modelOptions.reasoning_effort ?? modelOptions.reasoningEffort;
        if (typeof overrideEffort === "string") {
            if (this.isReasoningEffortSupported(overrideEffort, modelInfo, model.id)) {
                return overrideEffort;
            }
            Logger.warn(
                `[reasoning] modelOptions effort "${overrideEffort}" not supported by ${model.id}; suppressing field.`
            );
            return undefined;
        }

        Logger.debug(`[reasoning] getReasoningEffort for ${model.id}: returning undefined (no explicit choice)`);
        return undefined;
    }

    /**
     * Validates that a reasoning effort string is supported by the model.
     */
    protected isReasoningEffortSupported(effort: string, modelInfo?: LiteLLMModelInfo, modelId?: string): boolean {
        Logger.debug(
            `[isReasoningEffortSupported] effort: ${effort}, modelInfo: ${JSON.stringify(modelInfo)}, modelId: ${modelId}`
        );
        if (!modelInfo && !modelId) {
            Logger.debug("[isReasoningEffortSupported] No modelInfo and no modelId -> returning false");
            return false;
        }

        const supportedEfforts = getSupportedReasoningEfforts(modelInfo, modelId);
        Logger.debug(`[isReasoningEffortSupported] supportedEfforts: ${supportedEfforts}`);
        const result = supportedEfforts.includes(effort as (typeof supportedEfforts)[number]);
        Logger.debug(`[isReasoningEffortSupported] result: ${result}`);
        return result;
    }

    /**
     * Shared request builder used by all providers.
     */
    protected async buildOpenAIChatRequest(
        messages: readonly LanguageModelChatRequestMessage[],
        model: LanguageModelChatInformation,
        options: ProvideLanguageModelChatResponseOptions,
        modelInfo?: LiteLLMModelInfo,
        caller?: string
    ): Promise<OpenAIChatCompletionRequest> {
        return this._requestBuilder.buildOpenAIChatRequest(messages, model, options, modelInfo, caller);
    }

    protected async buildV2ChatRequest(
        messages: readonly V2ChatMessage[],
        model: LanguageModelChatInformation,
        options: ProvideLanguageModelChatResponseOptions,
        modelInfo?: LiteLLMModelInfo,
        caller?: string
    ): Promise<OpenAIChatCompletionRequest> {
        return this._requestBuilder.buildV2ChatRequest(messages, model, options, modelInfo, caller);
    }

    protected normalizeMessagesForV2Pipeline(
        messages: readonly (
            vscode.LanguageModelChatRequestMessage | vscode.LanguageModelChatMessage2 | vscode.LanguageModelChatMessage
        )[]
    ): V2ChatMessage[] {
        return normalizeMessagesForV2Pipeline(messages);
    }

    protected countTokensForV2Messages(
        input: string | V2ChatMessage | readonly V2ChatMessage[],
        modelId?: string,
        modelInfo?: LiteLLMModelInfo
    ): number {
        return countTokensForV2Messages(input, modelId, modelInfo);
    }

    /**
     * Sends a request to LiteLLM. Honors the per-group `options.configuration`
     * passed by VS Code — baseUrl/apiKey are read from there, NEVER from
     * global state. If `configuration` is missing, the request fails with a
     * configuration-required error rather than silently mis-routing.
     */
    protected async sendRequestToLiteLLM(
        request: OpenAIChatCompletionRequest,
        _progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        modelInfo?: LiteLLMModelInfo,
        configuration?: Record<string, unknown>
    ): Promise<ReadableStream<Uint8Array>> {
        return this._transport.sendRequestToLiteLLM(request, _progress, token, caller, modelInfo, configuration);
    }

    /**
     * Sends a LiteLLM request with a single retry on context overflow. The first attempt uses the
     * standard buffered budget. On overflow, we re-trim messages with a hard cap equal to the raw
     * model max input (minus tool tokens) and retry once.
     */
    protected async sendRequestWithRetry(
        request: OpenAIChatCompletionRequest,
        messages: readonly LanguageModelChatRequestMessage[],
        model: LanguageModelChatInformation,
        options: ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        modelInfo?: LiteLLMModelInfo
    ): Promise<ReadableStream<Uint8Array>> {
        const modelId = request.model;
        Logger.debug(`[sendRequestWithRetry] modelId: ${modelId}, reasoning_effort: ${request.reasoning_effort}`);
        const originalEffort = (request as { reasoning_effort?: SupportedReasoningEffort }).reasoning_effort;
        let effectiveEffort = this._effortFallbackCache.getEffectiveEffort(modelId, originalEffort);
        Logger.debug(`[sendRequestWithRetry] originalEffort: ${originalEffort}, effectiveEffort: ${effectiveEffort}`);
        this.applyReasoningEffort(request, effectiveEffort);

        const notificationKeyEffort = originalEffort ?? effectiveEffort;
        let attempts = 0;
        let lastError: unknown;
        let usageRetryAttempted = false;

        const clearUsageFlag = () => {
            delete (request as { stream_options?: { include_usage?: boolean } }).stream_options;
        };

        while (attempts < 6) {
            try {
                return await this.sendOnceWithOverflow(
                    request,
                    messages,
                    model,
                    options,
                    progress,
                    token,
                    caller,
                    modelInfo
                );
            } catch (err) {
                this.logRequestPayloadOnFailure(request, err, {
                    stage: "sendRequestWithRetry",
                    modelId: model.id,
                    caller,
                    modelInfoMode: modelInfo?.mode,
                });

                const errorMessage = err instanceof Error ? err.message : String(err);
                if (this.isUsageIncludeUsageParameterError(errorMessage)) {
                    this._usageOptOutModels.add(model.id);
                    clearUsageFlag();

                    if (!usageRetryAttempted) {
                        usageRetryAttempted = true;
                        Logger.warn(
                            `[sendRequestWithRetry] Retrying once without stream_options.include_usage after upstream rejection for model ${model.id}`
                        );
                        continue;
                    }
                }

                Logger.debug(`[sendRequestWithRetry] Caught error, checking isReasoningError...`);
                const isReasoning = isReasoningError(err);
                Logger.debug(`[sendRequestWithRetry] isReasoningError result: ${isReasoning}`);
                if (!isReasoning) {
                    Logger.debug("[sendRequestWithRetry] Not a reasoning error, throwing immediately");
                    throw err;
                }

                lastError = err;
                const nextEffort = this._effortFallbackCache.recordFailure(modelId, effectiveEffort);
                attempts += 1;
                Logger.debug(
                    `[sendRequestWithRetry] After recordFailure: nextEffort: ${nextEffort}, attempts: ${attempts}`
                );

                if (nextEffort === effectiveEffort || attempts >= 5) {
                    Logger.debug("[sendRequestWithRetry] Condition met - throwing toMeaningfulError");
                    throw this.toMeaningfulError(err, "Reasoning effort fallback exhausted");
                }

                const previous = effectiveEffort;
                effectiveEffort = nextEffort;
                this.applyReasoningEffort(request, effectiveEffort);

                if (notificationKeyEffort && previous && previous !== effectiveEffort) {
                    this.notifyReasoningFallback(modelId, notificationKeyEffort, effectiveEffort);
                }

                Logger.info(
                    `[reasoning] ${modelId}: retrying with downgraded effort ${effectiveEffort ?? "(omitted)"} after failure`
                );
            }
        }

        throw this.toMeaningfulError(lastError, "Reasoning effort fallback exhausted");
    }

    private isUsageIncludeUsageParameterError(errorMessage: string): boolean {
        const lower = errorMessage.toLowerCase();
        return (
            (lower.includes("stream_options") || lower.includes("include_usage")) &&
            (lower.includes("unsupported parameter") ||
                lower.includes("not supported") ||
                lower.includes("unknown parameter") ||
                lower.includes("unexpected keyword argument"))
        );
    }

    private toMeaningfulError(error: unknown, fallbackMessage: string): Error {
        if (error instanceof Error) {
            return error;
        }

        if (typeof error === "string") {
            return new Error(error);
        }

        if (typeof error === "object" && error !== null && "message" in error) {
            const message = (error as { message?: unknown }).message;
            if (typeof message === "string" && message.trim().length > 0) {
                return new Error(message);
            }
        }

        return new Error(fallbackMessage);
    }

    private applyReasoningEffort(
        request: OpenAIChatCompletionRequest,
        effort: SupportedReasoningEffort | undefined,
        summary?: "auto" | "concise" | "detailed"
    ): void {
        if (!effort) {
            const requestRecord = request as unknown as Record<string, unknown>;
            delete requestRecord.reasoning_effort;
            return;
        }
        // Object form is used by `gpt-5.4+` callers (and the OpenAI Responses API
        // in general) to control whether summary text is returned alongside the
        // reasoning text. The OpenAI Chat Completions spec still accepts the
        // legacy string form; both are forwarded to LiteLLM unchanged.
        request.reasoning_effort = summary ? { effort, summary } : effort;
    }

    private notifyReasoningFallback(
        modelId: string,
        originalEffort: SupportedReasoningEffort,
        fallbackEffort: SupportedReasoningEffort | undefined
    ): void {
        if (hasShownReasoningFallbackNotification(modelId, originalEffort)) {
            return;
        }

        const fallbackLabel = fallbackEffort ?? "omitted";
        void vscode.window.showInformationMessage(
            `Effort '${originalEffort}' is not supported by ${modelId}; using '${fallbackLabel}' for this session.`
        );
        markReasoningFallbackNotified(modelId, originalEffort);
    }

    private async sendOnceWithOverflow(
        request: OpenAIChatCompletionRequest,
        messages: readonly LanguageModelChatRequestMessage[],
        model: LanguageModelChatInformation,
        options: ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        modelInfo?: LiteLLMModelInfo
    ): Promise<ReadableStream<Uint8Array>> {
        try {
            return await this.sendRequestToLiteLLM(
                request,
                progress,
                token,
                caller,
                modelInfo,
                await this.getCallTimeConfiguration(options, model)
            );
        } catch (err) {
            if (!isContextOverflowError(err)) {
                throw err;
            }

            Logger.warn("[sendRequestWithRetry] Context overflow detected, retrying with aggressive trim", err);

            const toolConfig = convertTools(options);
            const hardBudget = Math.max(1, model.maxInputTokens - estimateToolTokens(toolConfig.tools));
            const trimmedMessages = trimMessagesToFitBudget(messages, toolConfig.tools, model, modelInfo, hardBudget);
            const retrimmedRequest = await this.buildOpenAIChatRequest(
                trimmedMessages,
                model,
                options,
                modelInfo,
                caller
            );

            try {
                return await this.sendRequestToLiteLLM(
                    retrimmedRequest,
                    progress,
                    token,
                    caller,
                    modelInfo,
                    await this.getCallTimeConfiguration(options, model)
                );
            } catch (retryErr) {
                if (isContextOverflowError(retryErr)) {
                    const contextError = new vscode.LanguageModelError(
                        "Context window exceeded. The conversation is too long for this model."
                    );
                    (contextError as { code?: string }).code = "ContextExceeded";
                    throw contextError;
                }
                throw retryErr;
            }
        }
    }

    /**
     * Resolves the per-group configuration for a response-time call.
     *
     * Delegates to the pure {@link ../base/callConfig callConfig} module, which
     * owns the `options.configuration` trust heuristic and the registry
     * fallback. Kept as a private method (rather than called inline) so tests
     * can exercise the resolution via the test-access seam.
     *
     * See `resolveCallTimeConfiguration` for the full invariant documentation,
     * including why an empty `options.configuration` object must NOT be
     * trusted and how the workspace ergonomic toggles are merged onto both
     * resolution paths.
     */
    private async getCallTimeConfiguration(
        options: vscode.ProvideLanguageModelChatResponseOptions,
        model: vscode.LanguageModelChatInformation
    ): Promise<Record<string, unknown> | undefined> {
        return resolveCallTimeConfiguration(options, model, {
            configManager: this._configManager,
            registry: this._registry,
        });
    }

    /**
     * Returns the raw LiteLLM model name (the part after the routing prefix)
     * for a given model id. Strips the `<routing>/` prefix if present,
     * otherwise returns the id unchanged.
     *
     * Used by the request building and transport paths so that
     * `request.model` in the OpenAI-compatible body is always the raw name
     * — LiteLLM does NOT understand the namespaced id format that VS Code
     * sees in the picker.
     */
    protected getRawModelName(modelId: string): string {
        const entry = this._registry.lookup(modelId);
        if (entry) {
            return entry.rawModelName;
        }
        // No entry in the registry: assume the id is already raw. This
        // covers the workspace-level `modelIdOverride` path (the override
        // is a user-typed raw name, not a namespaced id).
        return this._registry.extractRawName(modelId);
    }

    /**
     * Decides whether a given OpenAI parameter can be sent to a model.
     *
     * Delegates to the pure {@link ../base/parameterFiltering parameterFiltering}
     * module. Source of truth: the `supported_openai_params` array on the
     * model's `LiteLLMModelInfo` (delivered by the registry), with a static
     * `KNOWN_PARAMETER_LIMITATIONS` fallback for known model families. There
     * is no probe cache here — the registry's per-model capability data is
     * authoritative and re-validated on every discovery call.
     */
    protected isParameterSupported(param: string, modelInfo: LiteLLMModelInfo | undefined, modelId?: string): boolean {
        return isParameterSupportedImpl(param, modelInfo, modelId);
    }

    protected stripUnsupportedParametersFromRequest(
        requestBody: Record<string, unknown>,
        modelInfo: LiteLLMModelInfo | undefined,
        modelId?: string
    ): void {
        stripUnsupportedParametersFromRequestImpl(requestBody, modelInfo, modelId);
    }

    protected detectQuotaToolRedaction(
        messages: readonly LanguageModelChatRequestMessage[],
        tools: readonly vscode.LanguageModelChatTool[],
        requestId: string,
        modelId: string,
        disableRedaction: boolean,
        caller?: string
    ): {
        tools: readonly vscode.LanguageModelChatTool[];
        confidence: "none" | "low" | "high";
    } {
        // Delegates to the pure quota-redaction module. The module owns the
        // detector, the regex/constants, the message-text projections, and the
        // Copilot-wrapper stripping; this thin wrapper preserves the protected
        // method name the request builder binds against and tests cast to.
        return detectQuotaToolRedactionImpl(messages, tools, requestId, modelId, disableRedaction, caller);
    }

    protected sanitizeErrorTextForLogs(text: string): string {
        return sanitizeErrorTextForLogsImpl(text);
    }

    protected collectMessageText(message: LanguageModelChatRequestMessage): string {
        return collectMessageTextImpl(message);
    }

    protected logRequestPayloadOnFailure(
        request: OpenAIChatCompletionRequest,
        error: unknown,
        context: {
            stage: "sendRequestWithRetry" | "provideLanguageModelChatResponse";
            modelId: string;
            caller?: string;
            modelInfoMode?: string;
        }
    ): void {
        logRequestPayloadOnFailureImpl(request, error, context);
    }

    protected buildCapabilities(modelInfo: LiteLLMModelInfo | undefined): vscode.LanguageModelChatCapabilities {
        if (!modelInfo) {
            return {
                toolCalling: true,
                imageInput: false,
            };
        }

        return {
            toolCalling: modelInfo.supports_function_calling !== false,
            imageInput: modelInfo.supports_vision === true,
        };
    }

    protected parseApiError(statusCode: number, errorText: string): string {
        try {
            const parsed: unknown = JSON.parse(errorText);
            if (parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)) {
                const errorObj = (parsed as Record<string, unknown>).error as unknown;
                if (errorObj && typeof errorObj === "object" && "message" in errorObj) {
                    const message = (errorObj as Record<string, unknown>).message;
                    if (typeof message === "string") {
                        return message;
                    }
                }
            }
        } catch {
            // ignore
        }
        if (errorText) {
            return errorText.slice(0, 200);
        }
        return `API request failed with status ${statusCode}`;
    }
}

/**
 * LRU cache for token counts to avoid redundant network calls.
 * Capped at 100 entries to prevent unbounded memory growth in long-running sessions.
 * When the cache exceeds capacity, the least recently used entry is evicted.
 *
 * Rationale: Token count requests can be expensive HTTP calls. Caching responses
 * avoids redundant network traffic. LRU eviction ensures memory usage is bounded
 * even for extended sessions (100+ turns).
 */
const tokenCountCache = new LRUCache<string, number>(100);
// CACHE_TTL_MS retained for potential future use or if cache implementation changes back to timestamp-based TTL
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const CACHE_TTL_MS = 60000;

/**
 * Tracks pending background token count requests to avoid redundant network calls.
 *
 * Protected by timeout guards in countPromise: if a request exceeds 5 seconds,
 * it is automatically removed from this map to prevent accumulation of orphaned
 * promises in long-running agentic sessions.
 */
const pendingRequests = new Map<string, Promise<number>>();
