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
import { LiteLLMTelemetry } from "../utils/telemetry";
import type { TelemetryService } from "../telemetry/telemetryService";
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
import { LRUCache } from "../utils/lruCache";
import { AuditTrail } from "../observability/auditTrail";

/**
 * Static fallback parameter limitations for known model families.
 * Used as fallback when model info (supported_openai_params) is unavailable.
 * These are prefix matches - if modelId includes the key, the limitation applies.
 */
const KNOWN_PARAMETER_LIMITATIONS: Record<string, Set<string>> = {
    "claude-3-5-sonnet": new Set(["temperature"]),
    "claude-3-5-haiku": new Set(["temperature"]),
    "claude-3-opus": new Set(["temperature"]),
    "claude-3-sonnet": new Set(["temperature"]),
    "claude-3-haiku": new Set(["temperature"]),
    "claude-haiku-4-5": new Set(["temperature"]),
    "gpt-5.1-codex": new Set(["temperature", "frequency_penalty", "presence_penalty"]),
    "gpt-5.1-codex-mini": new Set(["temperature", "frequency_penalty", "presence_penalty"]),
    "gpt-5.1-codex-max": new Set(["temperature", "frequency_penalty", "presence_penalty"]),
    "codex-mini-latest": new Set(["temperature", "frequency_penalty", "presence_penalty"]),
    "o1-": new Set(["temperature", "top_p", "presence_penalty", "frequency_penalty"]),
    "gpt-5": new Set(["temperature", "top_p", "presence_penalty", "frequency_penalty"]),
};

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
     * Returns an empty array.
     *
     * Stateless design: there is no model-list cache. The last-known-models
     * view is gone because there is no list to be "last known" — every
     * discovery call is a fresh fetch. This method is retained for
     * backward compatibility with the public API surface; callers that
     * need a model list should trigger a discovery and use the result.
     */
    public getLastKnownModels(): LanguageModelChatInformation[] {
        return [];
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
     * Discovery-time call paths and the per-group config come from
     * `options.configuration` (set by VS Code 1.120 at discovery time).
     * Response-time paths in VS Code 1.120 do NOT pass the per-group config
     * on `options.configuration` — the proposed-type definition for
     * `ProvideLanguageModelChatResponseOptions` does not declare that field.
     *
     * As a fallback we consult the in-memory `LiteLLMProviderRegistry` keyed
     * by the model id. The registry is populated by every successful
     * discovery call, so a model that's been discovered in this session is
     * routable. If neither channel has the model, the call is a
     * configuration problem and the transport surfaces a visible error.
     */
    private async getCallTimeConfiguration(
        options: vscode.ProvideLanguageModelChatResponseOptions,
        model: vscode.LanguageModelChatInformation
    ): Promise<Record<string, unknown> | undefined> {
        const opt = options as vscode.ProvideLanguageModelChatResponseOptions & {
            configuration?: Record<string, unknown>;
        };
        // The `options.configuration` field on the proposed-type
        // `ProvideLanguageModelChatResponseOptions` is unreliable in VS Code
        // 1.120+. Empirically: VS Code may pass an EMPTY configuration
        // object (truthy, but no `baseUrl` or `apiKey`) for some calls,
        // particularly for models that were picked from a group other
        // than the one currently being routed. The wolfram group tends to
        // not include `configuration` at all (so we fall back to the
        // registry); the geth group tends to include an empty object
        // (which previously short-circuited the registry fallback and
        // produced a "No baseUrl provided" runtime error).
        //
        // We trust `options.configuration` ONLY when it has both a usable
        // `baseUrl` (string, non-empty) and a usable `apiKey` (string,
        // non-empty). Anything else falls through to the registry.
        const optBaseUrl = typeof opt.configuration?.baseUrl === "string" ? opt.configuration.baseUrl.trim() : "";
        const optApiKey = typeof opt.configuration?.apiKey === "string" ? opt.configuration.apiKey.trim() : "";

        // Fetch workspace-config toggles once so both paths can merge them.
        const cfg = await this._configManager.getConfig();

        if (opt.configuration && optBaseUrl.length > 0 && optApiKey.length > 0) {
            Logger.trace(
                `getCallTimeConfiguration: HIT via options.configuration modelId="${model.id}" baseUrl="${optBaseUrl}"`
            );
            // Merge workspace-config ergonomic toggles onto the per-group
            // configuration so the transport can read allowChatCompletionsFallback
            // and disableCaching without a separate config fetch on the hot path.
            return {
                ...opt.configuration,
                allowChatCompletionsFallback: cfg.allowChatCompletionsFallback,
                disableCaching: cfg.disableCaching,
            };
        }
        if (opt.configuration) {
            // Object is present but malformed (empty / missing fields).
            // This is the case we need to escape from — VS Code passed an
            // empty object and we must not trust it.
            Logger.trace(
                `getCallTimeConfiguration: options.configuration present but invalid (empty baseUrl or apiKey) modelId="${model.id}"; falling back to registry`
            );
        } else {
            Logger.trace(
                `getCallTimeConfiguration: options.configuration missing; falling back to registry lookup for modelId="${model.id}" modelName="${model.name}"`
            );
        }
        // No options.configuration at response time (the common case in VS
        // Code 1.120+). Fall back to the in-memory registry. The model id
        // VS Code hands back is the namespaced `<routing>/<raw>` form
        // produced by `LiteLLMProviderRegistry.toVSCodeInfo`; the registry
        // maps that id back to the {baseUrl, apiKey} of the backend that
        // produced it. The request builder extracts the raw model name
        // from `model.id` for `request.model`; the transport only needs
        // baseUrl + apiKey.
        const entry = this._registry.lookup(model.id);
        if (entry) {
            Logger.trace(`getCallTimeConfiguration: registry HIT modelId="${model.id}" -> baseUrl="${entry.baseUrl}"`);
            // Same ergonomic-toggle merge as the options.configuration path above,
            // so /responses fallback + disableCaching work regardless of which
            // path resolved baseUrl/apiKey.
            return {
                baseUrl: entry.baseUrl,
                apiKey: entry.apiKey,
                allowChatCompletionsFallback: cfg.allowChatCompletionsFallback,
                disableCaching: cfg.disableCaching,
            };
        }
        Logger.warn(
            `getCallTimeConfiguration: registry MISS modelId="${model.id}" modelName="${model.name}" — request will fail with configuration error`
        );
        return undefined;
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
     * Source of truth: the `supported_openai_params` array on the model's
     * `LiteLLMModelInfo` (delivered by the registry). There is no probe
     * cache here — the registry's per-model capability data is authoritative
     * and re-validated on every discovery call, so a stale cache layer
     * would only ever shadow correct information and (as observed in
     * production) cause a model to silently drop parameters it actually
     * supports.
     */
    protected isParameterSupported(param: string, modelInfo: LiteLLMModelInfo | undefined, modelId?: string): boolean {
        if (modelId) {
            if (KNOWN_PARAMETER_LIMITATIONS[modelId]?.has(param)) {
                return false;
            }
            for (const [knownModel, limitations] of Object.entries(KNOWN_PARAMETER_LIMITATIONS)) {
                if (modelId.includes(knownModel) && limitations.has(param)) {
                    return false;
                }
            }
        }

        if (modelInfo?.supported_openai_params) {
            const supportedParams = modelInfo.supported_openai_params;
            const normalizedParam = param.toLowerCase();
            const isSupported = supportedParams.some((p) => p.toLowerCase() === normalizedParam);

            if (supportedParams.length === 0) {
                return false;
            }

            if (!isSupported) {
                return !this.isRestrictableParam(param);
            }
            return true;
        }

        return true;
    }

    private isRestrictableParam(param: string): boolean {
        const restrictableParams = new Set([
            "temperature",
            "top_p",
            "presence_penalty",
            "frequency_penalty",
            "stop",
            "reasoning_effort",
            "tool_choice",
            "cache",
        ]);
        return restrictableParams.has(param.toLowerCase());
    }

    protected stripUnsupportedParametersFromRequest(
        requestBody: Record<string, unknown>,
        modelInfo: LiteLLMModelInfo | undefined,
        modelId?: string
    ): void {
        const paramsToCheck = [
            "temperature",
            "stop",
            "frequency_penalty",
            "presence_penalty",
            "top_p",
            "no_cache",
            "no-cache",
            "tool_choice", // Added for GPT-5.6 Azure and similar models that don't support tool_choice
        ];
        for (const p of paramsToCheck) {
            if (!this.isParameterSupported(p, modelInfo, modelId) && p in requestBody) {
                delete requestBody[p];
            }
        }

        // LiteLLM's cache bypass is carried only by extra_body.cache. It is
        // retained when the model explicitly supports the cache parameter.
        delete requestBody.cache;
        if (requestBody.extra_body && typeof requestBody.extra_body === "object") {
            const extraBody = requestBody.extra_body as Record<string, unknown>;
            if (!this.isParameterSupported("cache", modelInfo, modelId)) {
                delete extraBody.cache;
            }
            if (Object.keys(extraBody).length === 0) {
                delete requestBody.extra_body;
            }
        }
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
        if (disableRedaction || !tools.length || !messages.length) {
            return { tools, confidence: "none" };
        }

        const quotaMatch = this.findQuotaErrorInMessages(messages);
        if (!quotaMatch) {
            return { tools, confidence: "none" };
        }

        const { toolName, errorText, turnIndex, confidence } = quotaMatch;

        // Low-confidence matches (e.g. a quota phrase mentioned in
        // <reminderInstructions> or a user prompt about quotas) are logged
        // at DEBUG and do NOT trigger redaction or telemetry. High-confidence
        // matches (a real provider 429 in a tool result) keep the existing
        // WARN + telemetry behavior.
        if (confidence !== "high") {
            // For low-confidence matches, only report as "low" if there's a
            // redactable tool in the tools list. Otherwise, treat as "none"
            // since there's nothing actionable.
            const hasRedactableTool = tools.some((t) => LiteLLMProviderBase.REDACTABLE_TOOL_NAMES.includes(t.name));
            const reportedConfidence = hasRedactableTool ? confidence : "none";
            Logger.debug("Quota phrase detected in non-tool-result text; not redacting", {
                toolName,
                modelId,
                requestId,
                turnIndex,
                confidence: reportedConfidence,
            });
            return { tools, confidence: reportedConfidence };
        }

        const toolNames = new Set(tools.map((tool) => tool.name));
        if (!toolNames.has(toolName)) {
            Logger.debug("Quota error detected, but tool not present", { toolName, requestId, modelId, turnIndex });
            return { tools, confidence };
        }

        const filteredTools = tools.filter((tool) => tool.name !== toolName);
        Logger.warn("Quota error detected; redacting tool for current turn", {
            toolName,
            errorText,
            modelId,
            requestId,
            turnIndex,
        });
        LiteLLMTelemetry.reportMetric({
            requestId,
            model: modelId,
            status: "failure",
            error: `quota_exceeded:${toolName}`,
            ...(caller && { caller }),
        });

        return { tools: filteredTools, confidence };
    }

    /**
     * Tools the detector knows how to redact. Kept narrow on purpose — the
     * legacy detector only knew `insert_edit_into_file` and
     * `replace_string_in_file`. Adding more here is a deliberate code change
     * and must come with a test that exercises a real tool result for the new
     * tool name (not just a substring match in prompt scaffolding).
     */
    private static readonly REDACTABLE_TOOL_NAMES: readonly string[] = [
        "insert_edit_into_file",
        "replace_string_in_file",
    ] as const;

    private static readonly QUOTA_PHRASE_REGEX =
        /(\b429\b|rate\s*limit\s*exceeded|rate\s*limited|too\s*many\s*requests|insufficient\s*quota|quota\s*exceeded|exceeded\s*your\s*current\s*quota)/i;

    /**
     * Detects whether the conversation history contains a real provider-side
     * quota error attached to a tool call we know how to redact.
     *
     * High-confidence match: a `LanguageModelToolResultPart` whose text
     * contains a quota phrase AND whose `callId` resolves to one of the
     * `REDACTABLE_TOOL_NAMES` tools (verified by walking the messages in
     * reverse to find the matching `LanguageModelToolCallPart`).
     *
     * Low-confidence match: a quota phrase appearing in any other text
     * content. This is returned for observability (DEBUG log, telemetry
     * counter) but does NOT trigger redaction.
     *
     * None: no quota phrase anywhere in the message text.
     */
    private findQuotaErrorInMessages(messages: readonly LanguageModelChatRequestMessage[]):
        | {
              toolName: string;
              errorText: string;
              turnIndex: number;
              confidence: "none" | "low" | "high";
          }
        | undefined {
        // 1. Walk messages in reverse to find a tool result that contains a
        //    quota phrase. The result's `callId` anchors the match.
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            const toolResultHit = this.findQuotaInToolResults(message);
            if (toolResultHit) {
                const owningToolName = this.lookupToolNameForCallId(messages, toolResultHit.callId);
                if (owningToolName && LiteLLMProviderBase.REDACTABLE_TOOL_NAMES.includes(owningToolName)) {
                    return {
                        toolName: owningToolName,
                        errorText: this.sanitizeErrorTextForLogs(toolResultHit.text),
                        turnIndex: i,
                        confidence: "high",
                    };
                }
                // Tool result is for a tool we don't redact. Treat as
                // low-confidence (observability only) and keep walking.
                return {
                    toolName: owningToolName ?? toolResultHit.callId,
                    errorText: this.sanitizeErrorTextForLogs(toolResultHit.text),
                    turnIndex: i,
                    confidence: "low",
                };
            }
        }

        // 2. No qualifying tool result. Look for a quota phrase in any
        //    OTHER text content. Strip Copilot wrappers first so we never
        //    match the scaffolding. Only report as "low" if we find BOTH
        //    a quota phrase AND a tool name in the text (mimicking original
        //    behavior). If only quota is found without a tool name, treat
        //    as "none" since there's nothing to redact.
        const toolRegex = /(insert_edit_into_file|replace_string_in_file)/i;
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            const text = this.collectMessageText(message);
            if (!text) {
                continue;
            }
            const stripped = this.stripCopilotWrappers(text);
            if (!stripped) {
                continue;
            }
            if (!LiteLLMProviderBase.QUOTA_PHRASE_REGEX.test(stripped)) {
                continue;
            }
            // Check if there's also a tool name in the text
            const toolMatch = stripped.match(toolRegex);
            if (!toolMatch) {
                // Quota phrase found but no tool name - not actionable
                continue;
            }
            return {
                toolName: "",
                errorText: this.sanitizeErrorTextForLogs(text),
                turnIndex: i,
                confidence: "low",
            };
        }

        return undefined;
    }

    /**
     * Returns the first quota phrase match that lives inside a
     * `LanguageModelToolResultPart` on this message, plus the `callId` of
     * that tool result. Returns `undefined` if no tool result part contains
     * a quota phrase.
     */
    private findQuotaInToolResults(
        message: LanguageModelChatRequestMessage
    ): { callId: string; text: string } | undefined {
        const parts = message.content ?? [];
        for (const part of parts) {
            if (!(part instanceof vscode.LanguageModelToolResultPart)) {
                continue;
            }
            const text = this.collectPartText(part.content);
            if (!text) {
                continue;
            }
            if (!LiteLLMProviderBase.QUOTA_PHRASE_REGEX.test(text)) {
                continue;
            }
            return { callId: part.callId, text };
        }
        return undefined;
    }

    /**
     * Walks messages in reverse to find the assistant turn that produced
     * `callId` via a `LanguageModelToolCallPart` and returns the tool name
     * declared there. Returns `undefined` if no matching tool call is found.
     */
    private lookupToolNameForCallId(
        messages: readonly LanguageModelChatRequestMessage[],
        callId: string
    ): string | undefined {
        for (let i = messages.length - 1; i >= 0; i--) {
            const parts = messages[i].content ?? [];
            for (const part of parts) {
                if (part instanceof vscode.LanguageModelToolCallPart && part.callId === callId) {
                    return part.name;
                }
            }
        }
        return undefined;
    }

    /**
     * Text-only projection of a tool result's content array. Mirrors
     * `collectMessageText` but operates on a single part's `content` field
     * (which is itself an array of `LanguageModelTextPart`-shaped objects).
     */
    private collectPartText(content: readonly unknown[]): string {
        let text = "";
        for (const part of content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                text += part.value;
            } else if (typeof part === "string") {
                text += part;
            }
        }
        return text.trim();
    }

    private sanitizeErrorTextForLogs(text: string): string {
        const trimmed = (text || "").trim();
        if (!trimmed) {
            return "";
        }

        const withoutCopilotContext = trimmed
            .replace(/<context>[\s\S]*?<\/context>/gi, "<context>…</context>")
            .replace(/<editorContext>[\s\S]*?<\/editorContext>/gi, "<editorContext>…</editorContext>")
            .replace(
                /<reminderInstructions>[\s\S]*?<\/reminderInstructions>/gi,
                "<reminderInstructions>…</reminderInstructions>"
            );

        return withoutCopilotContext.length > 500 ? `${withoutCopilotContext.slice(0, 500)}…` : withoutCopilotContext;
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        const sanitizedError = this.sanitizeErrorTextForLogs(errorMessage);
        const payloadSummary = this.summarizeRequestPayloadForLogs(request);

        Logger.trace(
            `[request-failure] stage=${context.stage} model=${context.modelId} caller=${context.caller ?? "unknown"} mode=${context.modelInfoMode ?? "unknown"} error=${sanitizedError}`,
            payloadSummary
        );
    }

    private summarizeRequestPayloadForLogs(request: OpenAIChatCompletionRequest): Record<string, unknown> {
        const summarizeMessages = (request.messages ?? []).map(
            (message: { role?: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }) => {
                const content = message.content;
                const contentSummary =
                    typeof content === "string"
                        ? `text(${content.length})`
                        : Array.isArray(content)
                          ? `parts(${content.length})`
                          : typeof content;

                return {
                    role: message.role,
                    content: contentSummary,
                    hasToolCalls: Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
                    toolCallId: message.tool_call_id,
                };
            }
        );

        const summarizeTools = (request.tools ?? []).map((tool) => ({
            type: tool.type,
            name: tool.function?.name,
            hasDescription: typeof tool.function?.description === "string" && tool.function.description.length > 0,
        }));

        return {
            model: request.model,
            stream: request.stream,
            max_tokens: request.max_tokens,
            temperature: request.temperature,
            top_p: request.top_p,
            frequency_penalty: request.frequency_penalty,
            presence_penalty: request.presence_penalty,
            stop: request.stop,
            reasoning_effort: request.reasoning_effort,
            stream_options: request.stream_options,
            tool_choice: request.tool_choice,
            messageCount: request.messages?.length ?? 0,
            messages: summarizeMessages,
            toolCount: request.tools?.length ?? 0,
            tools: summarizeTools,
            hasExtraBody: typeof request.extra_body === "object" && request.extra_body !== null,
        };
    }

    private collectMessageText(message: LanguageModelChatRequestMessage): string {
        const parts = message.content ?? [];
        let text = "";
        for (const part of parts) {
            if (part instanceof vscode.LanguageModelTextPart) {
                text += part.value;
            } else if (typeof part === "string") {
                text += part;
            }
        }
        return text.trim();
    }

    /**
     * Strips Copilot-injected prompt scaffolding wrappers from `text` and
     * returns the cleaned, trimmed result. This is the SAME list of wrappers
     * the log sanitizer collapses, but applied *before* the quota regex runs
     * so the detector never matches on prompt scaffolding.
     *
     * Why this lives here: Copilot Chat injects `<context>`, `<editorContext>`,
     * `<reminderInstructions>`, and `<userRequest>` blocks into every user
     * message. The `<reminderInstructions>` block routinely documents the
     * exact tool-error handling rules that contain both the quota phrase
     * and the `insert_edit_into_file` / `replace_string_in_file` tool names
     * — a structural false positive for the legacy regex-pair detector.
     *
     * Invariant: this function is pure (no I/O, no side effects). The
     * original `text` is not mutated.
     */
    private stripCopilotWrappers(text: string): string {
        const trimmed = (text || "").trim();
        if (!trimmed) {
            return "";
        }
        return trimmed
            .replace(/<context>[\s\S]*?<\/context>/gi, "")
            .replace(/<editorContext>[\s\S]*?<\/editorContext>/gi, "")
            .replace(/<reminderInstructions>[\s\S]*?<\/reminderInstructions>/gi, "")
            .replace(/<userRequest>[\s\S]*?<\/userRequest>/gi, "")
            .trim();
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
