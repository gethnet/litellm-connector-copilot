import * as vscode from "vscode";
import { LiteLLMClient } from "../adapters/litellmClient";
import type {
    LanguageModelChatInformation,
    LanguageModelChatRequestMessage,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";

import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../types";
import { deriveGroupNameFromUrl, convertMessages, convertTools } from "../utils";
import { normalizeMessagesForV2Pipeline } from "../utils";
import { MultiBackendClient, parseNamespacedModelId } from "../adapters/multiBackendClient";
import {
    trimMessagesToFitBudget,
    estimateToolTokens,
    isContextOverflowError,
    countTokens,
} from "../adapters/tokenUtils";
import { countTokensForV2Messages, trimV2MessagesForBudget } from "../adapters/tokenUtils";
import { ConfigManager } from "../config/configManager";
import { Logger } from "../utils/logger";
import { LiteLLMTelemetry } from "../utils/telemetry";
import type { TelemetryService } from "../telemetry/telemetryService";
import {
    deriveCapabilitiesFromModelInfo,
    capabilitiesToVSCode,
    getModelTags as getDerivedModelTags,
    buildReasoningEffortConfigurationSchema,
    getSupportedReasoningEfforts,
} from "../utils/modelCapabilities";
import type { DerivedModelCapabilities } from "../utils/modelCapabilities";
import type { SupportedReasoningEffort } from "../types";
import {
    EffortFallbackCache,
    hasShownReasoningFallbackNotification,
    isReasoningError,
    markReasoningFallbackNotified,
} from "../utils/reasoningEffortFallback";
import type { V2ChatMessage } from "./v2Types";
import type { BackendSession } from "./backendSession";
import { ModelDiscovery } from "./base/modelDiscovery";
import { RequestBuilder } from "./base/requestBuilder";
import { Transport } from "./base/transport";
import type { DiscoverArgs, DiscoveryDeps, RequestBuilderDeps, TransportDeps } from "./base/types";

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

type LiteLLMDiscoveredModel = vscode.LanguageModelChatInformation & {
    readonly vendor?: string;
    readonly backendName?: string;
    readonly detail?: string;
    readonly tooltip?: string;
    readonly description?: string;
    readonly tags?: string[];
    readonly category?: { label: string; order: number };
    readonly _backendName?: string;
    readonly _backendUrl?: string;
    readonly _apiKey?: string;
};

/**
 *
 * Shared orchestration base for all LiteLLM-backed VS Code language model providers.
 *
 * Responsibilities:
 * - Model discovery + caching
 * - Shared request ingress pipeline (normalize, validate, filter, trim)
 * - Endpoint routing + transport (chat/completions vs responses)
 * - Shared error parsing and capability mapping
 * - Shared quota/tool-redaction heuristics
 *
 * Non-responsibilities:
 * - VS Code protocol specifics (stream parsing, response part emission)
 */
export abstract class LiteLLMProviderBase {
    protected readonly _configManager: ConfigManager;
    protected readonly _onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformationEmitter.event;

    private readonly _modelDiscovery: ModelDiscovery;
    private readonly _requestBuilder: RequestBuilder;
    private readonly _transport: Transport;
    protected readonly _effortFallbackCache: EffortFallbackCache;
    private _usageOptOutModels = new Set<string>();
    private readonly _parameterProbeCache = new Map<string, Set<string>>();

    protected _lastModelList: vscode.LanguageModelChatInformation[] = [];
    protected _modelInfoCache = new Map<string, LiteLLMModelInfo | undefined>();
    protected _multiBackendClient: MultiBackendClient | undefined;
    protected _activeBackendNames: string[] = [];

    protected _telemetryService?: TelemetryService;

    private _onModernConfigurationDetected?: () => void;

    constructor(
        protected readonly secrets: vscode.SecretStorage,
        protected readonly userAgent: string,
        effortFallbackCache?: EffortFallbackCache
    ) {
        this._configManager = new ConfigManager(secrets);
        this._effortFallbackCache = effortFallbackCache ?? new EffortFallbackCache();

        const discoveryDeps: DiscoveryDeps = {
            configManager: this._configManager,
            userAgent: this.userAgent,
            onModernConfigurationDetected: () => {
                this._onModernConfigurationDetected?.();
            },
        };
        this._modelDiscovery = new ModelDiscovery(discoveryDeps);

        const requestBuilderDeps: RequestBuilderDeps = {
            configManager: this._configManager,
            getReasoningEffort: this.getReasoningEffort.bind(this),
            detectQuotaToolRedaction: this.detectQuotaToolRedaction.bind(this),
            stripUnsupportedParametersFromRequest: this.stripUnsupportedParametersFromRequest.bind(this),
            isParameterSupported: this.isParameterSupported.bind(this),
            getTelemetryOptions: this.getTelemetryOptions.bind(this),
            usageOptOutModels: this._usageOptOutModels,
        };
        this._requestBuilder = new RequestBuilder(requestBuilderDeps);

        const transportDeps: TransportDeps = {
            configManager: this._configManager,
            userAgent: this.userAgent,
            getDiscoveredModelBackend: (modelId) => this._modelDiscovery.getDiscoveredModelBackend(modelId),
            getTransportModelId: this.getTransportModelId.bind(this),
            logger: Logger,
            liteLLMClientFactory: (backend) =>
                new LiteLLMClient({ url: backend.url, key: backend.key }, this.userAgent),
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

    /** Clears all model-related caches (model list, model info, parameter probe). */
    public clearModelCache(): void {
        Logger.info("Clearing model discovery cache");
        this._modelDiscovery.clearCaches();
        this._lastModelList = [];
        this._modelInfoCache.clear();
        this.refreshModelInformation();
        Logger.info("Cleared cache");
    }

    /** Returns the last discovered model list (may be empty if never fetched). */
    public getLastKnownModels(): LanguageModelChatInformation[] {
        return this._modelDiscovery.getLastModels();
    }

    /**
     * Public access to model info from cache.
     */
    public getModelInfo(modelId: string): LiteLLMModelInfo | undefined {
        return this._modelDiscovery.getModelInfo(modelId);
    }

    /**
     * Provides a best-effort token count for small inputs and optionally refines large inputs
     * in the background using the LiteLLM remote counter.
     */
    public async provideTokenCount(
        model: LanguageModelChatInformation,
        text: string | LanguageModelChatRequestMessage,
        token: vscode.CancellationToken
    ): Promise<number> {
        const modelInfo = this._modelDiscovery.getModelInfo(model.id);
        const localCount = countTokens(text, model.id, modelInfo);

        if (token.isCancellationRequested) {
            return localCount;
        }

        const cacheKey = `${model.id}:${typeof text === "string" ? text.length : JSON.stringify(text)}`;
        const cached = tokenCountCache.get(cacheKey);
        const now = Date.now();
        if (cached && now - cached.timestamp < CACHE_TTL_MS) {
            return cached.count;
        }

        if (typeof text === "string" && text.length < 500) {
            return localCount;
        }

        if (pendingRequests.has(cacheKey)) {
            return localCount;
        }

        const request =
            typeof text === "string"
                ? { model: model.id, prompt: text }
                : { model: model.id, messages: convertMessages([text]) };

        const countPromise = (async (): Promise<number> => {
            try {
                if (token.isCancellationRequested) {
                    return localCount;
                }

                const backends = await this._configManager.resolveBackends();
                if (backends.length === 0) {
                    return localCount;
                }

                const multiClient = new MultiBackendClient(backends, this.userAgent);
                const result = await multiClient.countTokens(model.id, request, token);
                if (result?.token_count != null && !token.isCancellationRequested) {
                    tokenCountCache.set(cacheKey, { count: result.token_count, timestamp: Date.now() });
                    return result.token_count;
                }
                return localCount;
            } catch {
                return localCount;
            } finally {
                pendingRequests.delete(cacheKey);
            }
        })();

        pendingRequests.set(cacheKey, countPromise);
        void countPromise;
        return localCount;
    }

    /**
     * Builds the reasoning-effort configuration schema for a model and emits a single
     * trace line describing the outcome. Logging here is critical for self-diagnosis:
     * when the picker fails to surface an effort selector, the user (or a maintainer)
     * can inspect the output channel to see exactly which models had a schema attached
     * and which did not — and the reason why.
     *
     * Returning `undefined` (no schema) means VS Code will not render any inline
     * configuration UI for this model, which is the correct behaviour for non-reasoning
     * models. We only attach a schema when the LiteLLM `/model/info` payload claims the
     * model supports reasoning, otherwise users would see an effort picker that has no
     * effect on requests.
     */
    private _buildReasoningSchemaWithDiagnostics(
        modelId: string,
        modelInfo: LiteLLMModelInfo | undefined,
        supportedEfforts: readonly string[]
    ): vscode.LanguageModelChatInformation["configurationSchema"] {
        if (supportedEfforts.length === 0) {
            const reason = !modelInfo
                ? "no /model/info entry"
                : modelInfo.supports_reasoning === undefined
                  ? "model_info does not declare supports_reasoning"
                  : "model_info reports supports_reasoning=false";
            Logger.trace(
                `[reasoning] ${modelId}: omitting configurationSchema (reason: ${reason}). ` +
                    "If this model should expose a reasoning effort picker, ensure the LiteLLM " +
                    "proxy returns supports_reasoning=true (or a supports_*_reasoning_effort flag) " +
                    "in /model/info."
            );
            return undefined;
        }
        Logger.debug(
            `[reasoning] ${modelId}: attaching configurationSchema with efforts [${supportedEfforts.join(", ")}].`
        );
        return buildReasoningEffortConfigurationSchema(
            supportedEfforts as ReturnType<typeof getSupportedReasoningEfforts>,
            undefined,
            modelInfo
        );
    }

    /**
     * Fetches and caches models from the LiteLLM proxy.
     *
     * This is shared between chat and completions providers so that both can reuse
     * the same discovery + tag logic.
     */
    public async discoverModels(
        options: {
            silent?: boolean;
            configuration?: Record<string, unknown>;
            groupName?: string;
        },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const args: DiscoverArgs = {
            options,
            token,
            onModelsDiscovered: () => this._onDidChangeLanguageModelChatInformationEmitter.fire(),
            onModernConfigurationDetected: () => this.setModernConfigurationDetectedHandler(() => {}),
        };

        const models = await this._modelDiscovery.discover(args);
        this._lastModelList = models;
        this._modelInfoCache.clear();
        for (const model of models) {
            const info = this._modelDiscovery.getModelInfo(model.id);
            if (info !== undefined) {
                this._modelInfoCache.set(model.id, info);
            }
        }
        return models;
    }

    /**
     * Returns the MultiBackendClient if available, or undefined if not yet initialized.
     */
    protected getMultiBackendClient(): MultiBackendClient | undefined {
        return this._multiBackendClient;
    }

    /**
     * Resolves which backend a model ID belongs to.
     * Returns the backend name and original (un-namespaced) model ID.
     */
    protected resolveModelBackend(modelId: string): { backendName: string; originalModelId: string } | undefined {
        if (!this._multiBackendClient) {
            return undefined;
        }
        return parseNamespacedModelId(modelId, this._activeBackendNames);
    }

    private getDiscoveredModelBackend(
        modelId: string
    ): { backendName: string; url: string; apiKey: string } | undefined {
        const entry = this._modelDiscovery.getLastModels().find((m) => m.id === modelId) as
            | LiteLLMDiscoveredModel
            | undefined;
        if (!entry?._backendName || !entry._backendUrl || !entry._apiKey) {
            return undefined;
        }
        return {
            backendName: entry._backendName,
            url: entry._backendUrl,
            apiKey: entry._apiKey,
        };
    }

    /**
     * Resolves the transport model ID to send upstream to LiteLLM.
     *
     * VS Code-facing model IDs are backend-namespaced (`backend/model`) so we can
     * route requests across multiple backends. LiteLLM expects the original model
     * ID (`model`) at transport time.
     *
     * In some mixed discovery flows, backend prefix metadata can be temporarily
     * stale (for example, model list cache from one config path while the active
     * backend client is initialized from another). When that happens,
     * `parseNamespacedModelId` may not match even though the discovered model list contains
     * the model entry. To avoid intermittent "Invalid model name"
     * failures, we fall back to the discovered entry's `name` (raw model id).
     */
    private getTransportModelId(modelId: string): string {
        const parsed = this.resolveModelBackend(modelId);
        if (parsed) {
            return parsed.originalModelId;
        }

        const discovered = this._modelDiscovery.getLastModels().find((m) => m.id === modelId) as
            | LiteLLMDiscoveredModel
            | undefined;
        if (discovered?.name) {
            return discovered.name;
        }

        return modelId;
    }

    /**
     * Resolves a BackendSession for the given model using multi-backend routing.
     * Creates/uses a backend-specific client when the model is namespaced.
     * Falls back to the multi-client when no backend-specific client is available.
     */
    protected async resolveBackendSession(model: LanguageModelChatInformation): Promise<BackendSession | undefined> {
        const backend = this.getDiscoveredModelBackend(model.id);
        if (!backend) {
            return undefined;
        }

        Logger.debug(`Using discovered backend session: `);
        return {
            backendName: backend.backendName,
            baseUrl: backend.url,
            apiKey: backend.apiKey,
            client: new LiteLLMClient({ url: backend.url, key: backend.apiKey }, this.userAgent),
        };
    }

    /**
     * Extended options including internal telemetry fields.
     */
    protected getTelemetryOptions(options: vscode.ProvideLanguageModelChatResponseOptions): {
        caller?: string;
        justification?: string;
        modelConfiguration?: Record<string, unknown>;
    } {
        // IMPORTANT: VS Code provides per-model configuration via `options.configuration`,
        // NOT `options.modelConfiguration`. The latter is only available in ChatRequest (message context).
        // This was a bug - we were reading from the wrong property!
        const opt = options as vscode.ProvideLanguageModelChatResponseOptions & {
            caller?: string;
            justification?: string;
            // modelConfiguration is NOT in ProvideLanguageModelChatResponseOptions - it's in ChatRequest
            // The correct property is `configuration`
            configuration?: Record<string, unknown>;
        };
        // Read from options.configuration (the correct VS Code API), not modelConfiguration
        // Also check modelConfiguration for backward compatibility with ChatRequest context
        const modelConfig = opt.configuration ?? opt.modelConfiguration ?? {};
        return {
            caller: opt.caller,
            justification: opt.justification,
            modelConfiguration: modelConfig,
        };
    }

    /**
     * Extracts reasoning effort from the modelConfiguration (preferred) or from
     * modelOptions. Returns the effort string ONLY when the user (or caller) has
     * explicitly selected one. We deliberately do NOT fall back to a "default"
     * effort here — letting LiteLLM and the upstream model decide the natural
     * default avoids two failure modes that surfaced in production:
     *
     *   1. LiteLLM rejected the request with a "reasoning" error for models whose
     *      `/model/info` advertises `supports_reasoning` but whose upstream provider
     *      does not actually accept the `reasoning_effort` field.
     *   2. Sending a default effort silently overrode the user's explicit
     *      "no reasoning" preference whenever they re-loaded the picker.
     *
     * The `"none"` value is treated as an explicit user opt-out: we still return
     * undefined so no field is sent, which is what LiteLLM expects for "do not
     * apply reasoning effort to this request".
     *
     * Priority: picker selection > explicit modelOptions override > undefined.
     */
    protected getReasoningEffort(
        options: ProvideLanguageModelChatResponseOptions,
        model: LanguageModelChatInformation,
        modelInfoOverride?: LiteLLMModelInfo
    ): string | undefined {
        const telemetry = this.getTelemetryOptions(options);
        const modelInfo = modelInfoOverride ?? this._modelDiscovery.getModelInfo(model.id);

        Logger.debug(`[getReasoningEffort] modelId: ${model.id}`);
        Logger.debug(`[getReasoningEffort] modelInfo from cache: ${JSON.stringify(modelInfo)}`);
        Logger.debug(`[getReasoningEffort] modelInfoOverride: ${JSON.stringify(modelInfoOverride)}`);

        // Priority 1: Picker selection (modelConfiguration.reasoningEffort)
        const pickerEffort = telemetry.modelConfiguration?.reasoningEffort;
        Logger.debug(`[getReasoningEffort] pickerEffort (from modelConfiguration): ${pickerEffort}`);
        if (typeof pickerEffort === "string") {
            if (pickerEffort === "none") {
                Logger.trace(`[reasoning] Picker selected "none" for ${model.id}; suppressing reasoning_effort field.`);
                return undefined;
            }
            Logger.debug(`[getReasoningEffort] Returning pickerEffort without validation: ${pickerEffort}`);
            return pickerEffort;
        }

        // Priority 2: API override (prefer OpenAI snake_case, keep camelCase for compatibility)
        const modelOptions = (options.modelOptions as Record<string, unknown> | undefined) ?? {};
        const overrideEffort = modelOptions.reasoning_effort ?? modelOptions.reasoningEffort;
        if (typeof overrideEffort === "string") {
            if (overrideEffort === "none") {
                return undefined;
            }
            if (this.isReasoningEffortSupported(overrideEffort, modelInfo, model.id)) {
                return overrideEffort;
            }
            Logger.warn(
                `[reasoning] modelOptions effort "${overrideEffort}" not supported by ${model.id}; suppressing field.`
            );
            return undefined;
        }

        // No explicit user choice — let LiteLLM / the upstream model use its own default.
        Logger.debug(`[reasoning] getReasoningEffort for ${model.id}: returning undefined (no explicit choice)`);
        return undefined;
    }

    /**
     * Validates that a reasoning effort string is supported by the model.
     *
     * @param effort The effort string to validate (e.g., "none", "medium", "xhigh")
     * @param modelInfo LiteLLM model information
     * @returns true if the effort is in the model's supported efforts list
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
     *
     * Applies:
     * - tool redaction (quota heuristic)
     * - message trimming to budget
     * - parameter filtering
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
            | vscode.LanguageModelChatRequestMessage
            | vscode.LanguageModelChatMessage2
            | vscode.LanguageModelChatMessage
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

    /** Sends a request to LiteLLM, with /responses fallback when applicable. */
    protected async sendRequestToLiteLLM(
        request: OpenAIChatCompletionRequest,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        modelInfo?: LiteLLMModelInfo
    ): Promise<ReadableStream<Uint8Array>> {
        let multiClient = this.getMultiBackendClient();
        if (!multiClient) {
            const backend = this.getDiscoveredModelBackend(request.model);
            let backends: { name: string; url: string; apiKey?: string; enabled: boolean }[];

            if (backend) {
                backends = [
                    {
                        name: backend.backendName,
                        url: backend.url,
                        apiKey: backend.apiKey,
                        enabled: true,
                    },
                ];
            } else {
                backends = await this._configManager.resolveBackends();
            }

            if (backends.length === 0) {
                throw new Error("LiteLLM configuration not found. Please configure the model provider group.");
            }

            multiClient = new MultiBackendClient(backends, this.userAgent);
            this._multiBackendClient = multiClient;
            this._activeBackendNames = backends.map((b) => b.name);
        }

        const backend = this.resolveModelBackend(request.model);
        const transportModelId = this.getTransportModelId(request.model);

        if (modelInfo?.mode === "responses") {
            try {
                const targetBackend = this.getDiscoveredModelBackend(request.model);

                if (targetBackend) {
                    const responsesRequest = { ...request, model: transportModelId };
                    return this._transport.sendRequestToLiteLLM(responsesRequest, progress, token, caller, modelInfo);
                }
            } catch (err) {
                // Only fall back to /chat/completions if forceResponsesEndpoint allows it
                const config = await this._configManager.getConfig();
                if (config.forceResponsesEndpoint && config.allowChatCompletionsFallback) {
                    Logger.warn(`/responses failed, falling back to /chat/completions: ${err}`);
                } else if (config.forceResponsesEndpoint) {
                    Logger.error(`/responses failed and fallback is disabled: ${err}`);
                    throw err;
                } else {
                    Logger.warn(`/responses failed, falling back to /chat/completions: ${err}`);
                }
            }
        }

        const modelIdForRouting = backend ? request.model : transportModelId;
        return multiClient.chat(modelIdForRouting, request, modelInfo?.mode, token, modelInfo);
    }

    /**
     * Sends a LiteLLM request with a single retry on context overflow. The first attempt uses the
     * standard buffered budget. On overflow, we re-trim messages with a hard cap equal to the raw
     * model max input (minus tool tokens) and retry once. If the retry also overflows, surface a
     * LanguageModelError so VS Code can trigger compaction and re-send.
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
                    Logger.debug(`[sendRequestWithRetry]   nextEffort: ${nextEffort}`);
                    Logger.debug(`[sendRequestWithRetry]   effectiveEffort: ${effectiveEffort}`);
                    Logger.debug(`[sendRequestWithRetry]   attempts: ${attempts}`);
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
        effort: SupportedReasoningEffort | undefined
    ): void {
        if (effort) {
            request.reasoning_effort = effort;
        } else {
            delete (request as { reasoning_effort?: SupportedReasoningEffort }).reasoning_effort;
        }
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
            return await this.sendRequestToLiteLLM(request, progress, token, caller, modelInfo);
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
                return await this.sendRequestToLiteLLM(retrimmedRequest, progress, token, caller, modelInfo);
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

    protected isParameterSupported(param: string, modelInfo: LiteLLMModelInfo | undefined, modelId?: string): boolean {
        // Priority 1: Static known limitations
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

        // Priority 2: Cached probe results
        if (modelId && this._parameterProbeCache.has(modelId)) {
            if (this._parameterProbeCache.get(modelId)?.has(param)) {
                return false;
            }
        }

        // Priority 3: Dynamic detection from model info
        // Any null values in supported_openai_params array should be treated as undefined
        if (modelInfo?.supported_openai_params) {
            const supportedParams = modelInfo.supported_openai_params;
            const normalizedParam = param.toLowerCase();
            const isSupported = supportedParams.some((p) => p.toLowerCase() === normalizedParam);

            if (supportedParams.length === 0) {
                return false;
            }

            if (!isSupported) {
                // Param not in supported list - return false for restrictable params
                return !this.isRestrictableParam(param);
            }
            return true;
        }

        // Priority 4: Default to true if no model info available
        return true;
    }

    /**
     * Check if a parameter is typically restrictable (should be filtered for certain models).
     * These are parameters that cause errors on models like o1/o3 or have known restrictions.
     */
    private isRestrictableParam(param: string): boolean {
        const restrictableParams = new Set(["temperature", "top_p", "presence_penalty", "frequency_penalty", "stop"]);
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
            "cache",
            "no_cache",
            "no-cache",
            "extra_body",
        ];
        for (const p of paramsToCheck) {
            if (!this.isParameterSupported(p, modelInfo, modelId) && p in requestBody) {
                delete requestBody[p];
            }
        }

        if ("cache" in requestBody) {
            delete requestBody.cache;
        }

        if (requestBody.extra_body && typeof requestBody.extra_body === "object") {
            const eb = requestBody.extra_body as Record<string, unknown>;
            if (eb.cache && typeof eb.cache === "object") {
                const cache = eb.cache as Record<string, unknown>;
                delete cache["no-cache"];
                delete cache.no_cache;
                if (Object.keys(cache).length === 0) {
                    delete eb.cache;
                }
            }
            if (Object.keys(eb).length === 0) {
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
    ): { tools: readonly vscode.LanguageModelChatTool[] } {
        if (disableRedaction || !tools.length || !messages.length) {
            return { tools };
        }

        const quotaMatch = this.findQuotaErrorInMessages(messages);
        if (!quotaMatch) {
            return { tools };
        }

        const { toolName, errorText, turnIndex } = quotaMatch;
        const toolNames = new Set(tools.map((tool) => tool.name));
        if (!toolNames.has(toolName)) {
            Logger.debug("Quota error detected, but tool not present", { toolName, requestId, modelId, turnIndex });
            return { tools };
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

        return { tools: filteredTools };
    }

    private findQuotaErrorInMessages(
        messages: readonly LanguageModelChatRequestMessage[]
    ): { toolName: string; errorText: string; turnIndex: number } | undefined {
        // Be strict: only redact tools when we have strong evidence of a real rate/quota failure.
        // Some providers echo the entire prompt/context into error text; avoid matching generic
        // phrases that can appear in unrelated failures.
        const quotaRegex =
            /(\b429\b|rate\s*limit\s*exceeded|rate\s*limited|too\s*many\s*requests|insufficient\s*quota|quota\s*exceeded|exceeded\s*your\s*current\s*quota)/i;
        const toolRegex = /(insert_edit_into_file|replace_string_in_file)/i;

        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            const text = this.collectMessageText(message);
            if (!text) {
                continue;
            }
            if (!quotaRegex.test(text)) {
                continue;
            }
            const toolMatch = text.match(toolRegex);
            if (!toolMatch) {
                continue;
            }

            return {
                toolName: toolMatch[1],
                // Keep logs usable and avoid dumping prompt/context.
                errorText: this.sanitizeErrorTextForLogs(text),
                turnIndex: i,
            };
        }

        return undefined;
    }

    private sanitizeErrorTextForLogs(text: string): string {
        const trimmed = (text || "").trim();
        if (!trimmed) {
            return "";
        }

        // Remove common Copilot prompt wrappers if providers echo them back.
        const withoutCopilotContext = trimmed
            .replace(/<context>[\s\S]*?<\/context>/gi, "<context>…</context>")
            .replace(/<editorContext>[\s\S]*?<\/editorContext>/gi, "<editorContext>…</editorContext>")
            .replace(
                /<reminderInstructions>[\s\S]*?<\/reminderInstructions>/gi,
                "<reminderInstructions>…</reminderInstructions>"
            );

        // Cap size.
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
            // Type guard: check parsed is an object with error property
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
 * Simple in-memory cache for token counts to avoid redundant network calls.
 */
const tokenCountCache = new Map<string, { count: number; timestamp: number }>();
const CACHE_TTL_MS = 60000; // Increase to 1 minute for better stability
const DEBOUNCE_MS = 300;

/**
 * Tracks pending background token count requests to avoid redundant network calls.
 */
const pendingRequests = new Map<string, Promise<number>>();
