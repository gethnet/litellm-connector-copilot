import * as vscode from "vscode";
import type {
    LanguageModelChatInformation,
    LanguageModelChatRequestMessage,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";

import type {
    LiteLLMModelInfo,
    OpenAIChatCompletionRequest,
    OpenAIFunctionToolDef,
    LiteLLMTokenCounterRequest,
} from "../types";
import { convertMessages, convertTools, validateRequest } from "../utils";
import {
    convertV2MessagesToOpenAI,
    convertV2MessagesToProviderMessages,
    normalizeMessagesForV2Pipeline,
    validateV2Messages,
} from "../utils";
import { MultiBackendClient, parseNamespacedModelId } from "../adapters/multiBackendClient";
import { ResponsesClient } from "../adapters/responsesClient";
import { transformToResponsesFormat } from "../adapters/responsesAdapter";
import { countTokens, trimMessagesToFitBudget } from "../adapters/tokenUtils";
import { countTokensForV2Messages, trimV2MessagesForBudget } from "../adapters/tokenUtils";
import { ConfigManager } from "../config/configManager";
import { Logger } from "../utils/logger";
import { LiteLLMTelemetry } from "../utils/telemetry";
import type { TelemetryService } from "../telemetry/telemetryService";
import {
    deriveCapabilitiesFromModelInfo,
    capabilitiesToVSCode,
    getModelTags as getDerivedModelTags,
} from "../utils/modelCapabilities";
import type { DerivedModelCapabilities } from "../utils/modelCapabilities";
import type { V2ChatMessage } from "./v2Types";

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

    protected readonly _modelInfoCache = new Map<string, LiteLLMModelInfo | undefined>();
    protected readonly _derivedCapabilitiesCache = new Map<string, DerivedModelCapabilities>();
    protected readonly _parameterProbeCache = new Map<string, Set<string>>();
    protected _lastModelList: LanguageModelChatInformation[] = [];
    protected _modelListFetchedAtMs = 0;
    private _inFlightDiscovery: Promise<vscode.LanguageModelChatInformation[]> | undefined;

    protected _multiBackendClient: MultiBackendClient | undefined;
    protected _activeBackendNames: string[] = [];

    protected _telemetryService?: TelemetryService;

    constructor(
        protected readonly secrets: vscode.SecretStorage,
        protected readonly userAgent: string
    ) {
        this._configManager = new ConfigManager(secrets);
    }

    public setTelemetryService(service: TelemetryService): void {
        this._telemetryService = service;
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
        this._modelInfoCache.clear();
        this._derivedCapabilitiesCache.clear();
        this._parameterProbeCache.clear();
        this._lastModelList = [];
        this._modelListFetchedAtMs = 0;
        this.refreshModelInformation();
        Logger.info("Cleared cache");
    }

    /** Returns the last discovered model list (may be empty if never fetched). */
    public getLastKnownModels(): LanguageModelChatInformation[] {
        return this._lastModelList;
    }

    /**
     * Public access to model info from cache.
     */
    public getModelInfo(modelId: string): LiteLLMModelInfo | undefined {
        return this._modelInfoCache.get(modelId);
    }

    /**
     * Fetches and caches models from the LiteLLM proxy.
     *
     * This is shared between chat and completions providers so that both can reuse
     * the same discovery + tag logic.
     */
    public async discoverModels(
        options: { silent: boolean },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        if (this._inFlightDiscovery) {
            Logger.trace("Returning in-flight discovery promise");
            return this._inFlightDiscovery;
        }

        const TTL_MS = 30000; // 30 seconds
        const now = Date.now();
        if (options.silent && this._lastModelList.length > 0 && now - this._modelListFetchedAtMs < TTL_MS) {
            Logger.trace("Returning cached models (within TTL)");
            if (this._telemetryService) {
                this._telemetryService.captureModelsCacheHit(this._lastModelList.length);
            }
            return this._lastModelList;
        }

        this._inFlightDiscovery = (async () => {
            try {
                return await this._doDiscoverModels(options, token);
            } finally {
                this._inFlightDiscovery = undefined;
            }
        })();

        return this._inFlightDiscovery;
    }

    private async _doDiscoverModels(
        options: { silent: boolean },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        Logger.trace("discoverModels called");
        try {
            const config = await this._configManager.getConfig();
            const backends = await this._configManager.resolveBackends();

            if (backends.length === 0) {
                // When invoked from the Language Models view with silent=false, VS Code is allowed to prompt.
                // Use the classic configuration workflow to capture baseUrl/apiKey into canonical storage.
                if (!options.silent) {
                    Logger.info("No backends configured; prompting for configuration (silent=false)");
                    await vscode.commands.executeCommand("litellm-connector.manage");

                    const refreshedBackends = await this._configManager.resolveBackends();
                    if (refreshedBackends.length === 0) {
                        Logger.info("Configuration was not completed; returning empty model list.");
                        return [];
                    }
                    Logger.debug("Configuration completed; continuing model discovery.");
                } else {
                    Logger.info("No backends configured, returning empty model list.");
                    return [];
                }
            }

            // Re-read after potential prompt.
            const effectiveBackends = await this._configManager.resolveBackends();
            if (effectiveBackends.length === 0) {
                Logger.info("No backends configured after prompt, returning empty model list.");
                return [];
            }

            // Create multi-backend client
            this._multiBackendClient = new MultiBackendClient(effectiveBackends, this.userAgent);
            if (this._telemetryService) {
                this._multiBackendClient.setTelemetryService(this._telemetryService);
            }
            this._activeBackendNames = effectiveBackends.map((b) => b.name);

            Logger.trace(`Fetching model info from ${effectiveBackends.length} backend(s)...`);
            const aggregated = await this._multiBackendClient.getModelInfoAll(token);

            Logger.info(`Found ${aggregated.data.length} models across ${effectiveBackends.length} backend(s)`);
            if (this._telemetryService) {
                this._telemetryService.captureModelsDiscovered(aggregated.data.length, effectiveBackends.length);
            }
            const infos: LanguageModelChatInformation[] = aggregated.data.map((entry) => {
                const modelId = entry.namespacedId;
                const modelInfo = entry.model_info;
                this._modelInfoCache.set(modelId, modelInfo);

                const derived = deriveCapabilitiesFromModelInfo(modelId, modelInfo);
                this._derivedCapabilitiesCache.set(modelId, derived);

                const capabilities = capabilitiesToVSCode(derived);
                const tags = getDerivedModelTags(modelId, derived, config.modelOverrides);

                const formatTokens = (num: number): string => {
                    if (num >= 1000000) {
                        return `${(num / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
                    }
                    if (num >= 1000) {
                        return `${Math.floor(num / 1000)}K`;
                    }
                    return num.toString();
                };

                const inputDesc = formatTokens(derived.rawContextWindow);
                const outputDesc = formatTokens(derived.maxOutputTokens);
                const tooltip = `${entry.backendName} · ${modelInfo?.litellm_provider ?? "LiteLLM"} (${modelInfo?.mode ?? "responses"}) — Context: ${inputDesc} in / ${outputDesc} out`;

                // User-facing model label for multi-backend environments.
                // VS Code expects `id` to be stable and routable, so we keep `id` as the namespaced id.
                // The human-facing label is exposed via `name`.
                const displayId = `${entry.backendName}:${entry.model_name ?? modelId}`;

                // Derive family from provider to help Copilot shape requests correctly
                const provider = modelInfo?.litellm_provider?.toLowerCase();
                let family = "litellm";
                if (provider === "openai") {
                    family = "gpt4";
                } else if (provider === "anthropic") {
                    family = "claude";
                }

                const info = {
                    id: modelId,
                    name: displayId,
                    tooltip,
                    detail: `Backend: ${entry.backendName} | Context: ${inputDesc} | Output: ${outputDesc}`,
                    family: family,
                    version: "1.0.0",
                    maxInputTokens: derived.rawContextWindow,
                    maxOutputTokens: derived.maxOutputTokens,
                    capabilities,
                    tags,
                };

                return info as vscode.LanguageModelChatInformation;
            });

            const hasChanged = JSON.stringify(this._lastModelList) !== JSON.stringify(infos);
            this._lastModelList = infos;
            this._modelListFetchedAtMs = Date.now();

            if (hasChanged) {
                this.refreshModelInformation();
            }

            return infos;
        } catch (err) {
            Logger.error("Failed to fetch models", err);
            return [];
        }
    }

    /**
     * Shared token counting logic.
     */
    async provideTokenCount(
        model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        token: vscode.CancellationToken
    ): Promise<number> {
        const modelInfo = this._modelInfoCache.get(model.id);

        // Always calculate local count first for immediate response
        const localCount = countTokens(text, model.id, modelInfo);

        // For very small strings, local count is sufficient and avoids any overhead
        if (typeof text === "string" && text.length < 200) {
            return localCount;
        }

        const contentKey = typeof text === "string" ? text : JSON.stringify(text);
        const cacheKey = `${model.id}:${contentKey}`;

        const cached = tokenCountCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
            return cached.count;
        }

        // Check if there's already a pending background request for this content
        if (pendingRequests.has(cacheKey)) {
            // We return the local count immediately but don't block.
            // The NEXT call will likely get the cached value once the pending one resolves.
            return localCount;
        }

        // Kick off background refinement without awaiting it
        this.refineTokenCountInBackground(model, text, cacheKey, token).catch((err) => {
            Logger.trace(`Background token refinement failed (expected during rapid updates): ${err.message}`);
        });

        // Return local count immediately to keep UI responsive
        return localCount;
    }

    /**
     * Refines the token count in the background using LiteLLM and updates the cache.
     */
    private async refineTokenCountInBackground(
        model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        cacheKey: string,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Debounce: Wait a bit to see if more requests for the same content come in
        await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS));
        if (token.isCancellationRequested) {
            return;
        }

        const promise = (async () => {
            try {
                if (!this._multiBackendClient) {
                    return 0;
                }

                const request: LiteLLMTokenCounterRequest = { model: model.id };

                if (typeof text === "string") {
                    request.prompt = text;
                } else {
                    request.messages = convertMessages([text]);
                }

                const response = await this._multiBackendClient.countTokens(model.id, request, token);
                tokenCountCache.set(cacheKey, { count: response.token_count, timestamp: Date.now() });

                // Cleanup cache if it grows too large
                if (tokenCountCache.size > 200) {
                    const keys = Array.from(tokenCountCache.keys());
                    tokenCountCache.delete(keys[0]);
                }

                return response.token_count;
            } finally {
                pendingRequests.delete(cacheKey);
            }
        })();

        pendingRequests.set(cacheKey, promise);
        await promise;
    }

    /**
     * Returns the tags for a model based on its info and user overrides.
     *
     * Tags are used by VS Code to decide which models to surface for specific features
     * (e.g. inline completions).
     */
    protected getModelTags(
        modelId: string,
        modelInfo?: LiteLLMModelInfo,
        overrides?: Record<string, string[]>
    ): string[] {
        const tags = new Set<string>();

        const modelName = modelId.toLowerCase();
        if (modelName.includes("coder") || modelName.includes("code")) {
            tags.add("inline-edit");
        }

        if (
            modelInfo?.supports_function_calling ||
            modelInfo?.supports_vision ||
            modelInfo?.supports_native_streaming ||
            modelInfo?.supported_openai_params?.includes("tools") ||
            modelInfo?.supported_openai_params?.includes("tool_choice")
        ) {
            tags.add("tools");
        }

        if (
            modelInfo?.supports_vision ||
            (Array.isArray(modelInfo?.modalities) && (modelInfo.modalities as string[]).includes("vision"))
        ) {
            tags.add("vision");
        }

        if (modelInfo?.mode === "chat") {
            const supportsStreaming =
                modelInfo.supports_native_streaming === true || modelInfo.supported_openai_params?.includes("stream");

            if (supportsStreaming) {
                tags.add("inline-completions");
                tags.add("terminal-chat");
            }
        }

        if (overrides && overrides[modelId]) {
            for (const tag of overrides[modelId]) {
                tags.add(tag);
            }
        }

        return Array.from(tags);
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

    /**
     * Extended options including internal telemetry fields.
     */
    protected getTelemetryOptions(options: vscode.ProvideLanguageModelChatResponseOptions): {
        caller?: string;
        justification?: string;
    } {
        const opt = options as vscode.ProvideLanguageModelChatResponseOptions & {
            caller?: string;
            justification?: string;
        };
        return {
            caller: opt.caller,
            justification: opt.justification,
        };
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
        // Log caller and justification for telemetry/debugging
        const telemetry = this.getTelemetryOptions(options);
        const justification = telemetry.justification;
        const effectiveCaller = caller || telemetry.caller;
        Logger.info(
            `Building request for model: ${model.id} | Caller: ${effectiveCaller || "unknown"} | Justification: ${
                justification || "none"
            }`
        );

        const config = await this._configManager.getConfig();

        const toolRedaction = this.detectQuotaToolRedaction(
            messages,
            options.tools ?? [],
            `build-${Math.random().toString(36).slice(2, 10)}`,
            model.id,
            config.disableQuotaToolRedaction === true,
            caller
        );
        const toolConfig = convertTools({ ...options, tools: toolRedaction.tools });
        const messagesToUse = trimMessagesToFitBudget(messages, toolConfig.tools, model, modelInfo);

        const openaiMessages = convertMessages(messagesToUse);
        validateRequest(messagesToUse);

        Logger.debug(
            `[buildOpenAIChatRequest] Final message count: ${openaiMessages.length}, Tool count: ${options.tools?.length ?? 0}`
        );
        if (openaiMessages.some((m) => m.tool_calls?.length || m.role === "tool")) {
            const ids = openaiMessages.flatMap(
                (m) => m.tool_calls?.map((tc) => tc.id) || (m.tool_call_id ? [m.tool_call_id] : [])
            );
            Logger.trace(`[buildOpenAIChatRequest] Tool IDs in request: ${ids.join(", ")}`);
        }

        const requestBody: OpenAIChatCompletionRequest = {
            model: model.id,
            messages: openaiMessages,
            stream: true,
            max_tokens:
                typeof options.modelOptions?.max_tokens === "number"
                    ? Math.min(options.modelOptions.max_tokens, model.maxOutputTokens)
                    : model.maxOutputTokens,
        };

        const mo = (options.modelOptions as Record<string, unknown>) ?? {};

        if (this.isParameterSupported("temperature", modelInfo, model.id)) {
            const temp = mo.temperature as number | undefined;
            requestBody.temperature = temp ?? (config.sendDefaultParameters ? 0.7 : undefined);
        }
        if (this.isParameterSupported("frequency_penalty", modelInfo, model.id)) {
            const fp = mo.frequency_penalty as number | undefined;
            requestBody.frequency_penalty = fp ?? (config.sendDefaultParameters ? 0.2 : undefined);
        }
        if (this.isParameterSupported("presence_penalty", modelInfo, model.id)) {
            const pp = mo.presence_penalty as number | undefined;
            requestBody.presence_penalty = pp ?? (config.sendDefaultParameters ? 0.1 : undefined);
        }

        if (this.isParameterSupported("stop", modelInfo, model.id) && mo.stop) {
            requestBody.stop = mo.stop as string | string[];
        }
        if (this.isParameterSupported("top_p", modelInfo, model.id) && typeof mo.top_p === "number") {
            requestBody.top_p = mo.top_p;
        }

        if (toolConfig.tools) {
            requestBody.tools = toolConfig.tools as unknown as OpenAIFunctionToolDef[];
        }
        if (toolConfig.tool_choice) {
            requestBody.tool_choice = toolConfig.tool_choice;
        }

        this.stripUnsupportedParametersFromRequest(
            requestBody as unknown as Record<string, unknown>,
            modelInfo,
            model.id
        );
        return requestBody;
    }

    protected async buildV2ChatRequest(
        messages: readonly V2ChatMessage[],
        model: LanguageModelChatInformation,
        options: ProvideLanguageModelChatResponseOptions,
        modelInfo?: LiteLLMModelInfo,
        caller?: string
    ): Promise<OpenAIChatCompletionRequest> {
        const telemetry = this.getTelemetryOptions(options);
        const justification = telemetry.justification;
        const effectiveCaller = caller || telemetry.caller;
        Logger.info(
            `Building V2 request for model: ${model.id} | Caller: ${effectiveCaller || "unknown"} | Justification: ${
                justification || "none"
            }`
        );

        const config = await this._configManager.getConfig();

        const toolConfig = convertTools(options);
        const trimmedMessages = trimV2MessagesForBudget(messages, toolConfig.tools, model, modelInfo);
        validateV2Messages(trimmedMessages);

        if (model.id === "gemini-3.1-flash-lite-preview") {
            for (const message of trimmedMessages) {
                if ((message.role as number) === 3) {
                    message.role = vscode.LanguageModelChatMessageRole.User;
                }
            }
        }

        const transportMessages = convertV2MessagesToProviderMessages(trimmedMessages);

        const requestBody: OpenAIChatCompletionRequest = {
            model: model.id,
            messages: convertV2MessagesToOpenAI(trimmedMessages),
            stream: true,
            max_tokens:
                typeof options.modelOptions?.max_tokens === "number"
                    ? Math.min(options.modelOptions.max_tokens, model.maxOutputTokens)
                    : model.maxOutputTokens,
        };

        const mo = (options.modelOptions as Record<string, unknown>) ?? {};

        if (this.isParameterSupported("temperature", modelInfo, model.id)) {
            const temp = mo.temperature as number | undefined;
            requestBody.temperature = temp ?? (config.sendDefaultParameters ? 0.7 : undefined);
        }
        if (this.isParameterSupported("frequency_penalty", modelInfo, model.id)) {
            const fp = mo.frequency_penalty as number | undefined;
            requestBody.frequency_penalty = fp ?? (config.sendDefaultParameters ? 0.2 : undefined);
        }
        if (this.isParameterSupported("presence_penalty", modelInfo, model.id)) {
            const pp = mo.presence_penalty as number | undefined;
            requestBody.presence_penalty = pp ?? (config.sendDefaultParameters ? 0.1 : undefined);
        }

        if (this.isParameterSupported("stop", modelInfo, model.id) && mo.stop) {
            requestBody.stop = mo.stop as string | string[];
        }
        if (this.isParameterSupported("top_p", modelInfo, model.id) && typeof mo.top_p === "number") {
            requestBody.top_p = mo.top_p;
        }

        if (toolConfig.tools) {
            requestBody.tools = toolConfig.tools as unknown as OpenAIFunctionToolDef[];
        }
        if (toolConfig.tool_choice) {
            requestBody.tool_choice = toolConfig.tool_choice;
        }

        this.stripUnsupportedParametersFromRequest(
            requestBody as unknown as Record<string, unknown>,
            modelInfo,
            model.id
        );

        void transportMessages;

        return requestBody;
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
            const backends = await this._configManager.resolveBackends();
            if (backends.length === 0) {
                throw new Error("LiteLLM configuration not found. Please configure at least one backend.");
            }
            multiClient = new MultiBackendClient(backends, this.userAgent);
            this._multiBackendClient = multiClient;
            this._activeBackendNames = backends.map((b) => b.name);
        }

        const backend = this.resolveModelBackend(request.model);

        if (modelInfo?.mode === "responses") {
            try {
                // To support /responses with multiple backends, we need the specific backend's URL/Key
                const backends = await this._configManager.resolveBackends();
                const targetBackend = backends.find((b) => b.name === (backend?.backendName ?? "default"));

                if (targetBackend) {
                    const responsesClient = new ResponsesClient(
                        { url: targetBackend.url, key: targetBackend.apiKey },
                        this.userAgent
                    );
                    const responsesRequest = transformToResponsesFormat(request);
                    // Strip prefix for /responses request if needed
                    if (backend) {
                        responsesRequest.model = backend.originalModelId;
                    }
                    await responsesClient.sendResponsesRequest(responsesRequest, progress, token, modelInfo);
                    LiteLLMTelemetry.reportMetric({
                        requestId: `resp-${Math.random().toString(36).slice(2, 10)}`,
                        model: request.model,
                        status: "success",
                        ...(caller && { caller }),
                    });
                    return new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.close();
                        },
                    });
                }
            } catch (err) {
                Logger.warn(`/responses failed, falling back to /chat/completions: ${err}`);
            }
        }

        return multiClient.chat(request.model, request, modelInfo?.mode, token, modelInfo);
    }

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

        if (!modelInfo) {
            return true;
        }

        if (modelId && this._parameterProbeCache.has(modelId)) {
            if (this._parameterProbeCache.get(modelId)?.has(param)) {
                return false;
            }
        }

        if (modelInfo.supported_openai_params) {
            return modelInfo.supported_openai_params.includes(param);
        }

        return true;
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
            const parsed = JSON.parse(errorText);
            if (parsed.error?.message) {
                return parsed.error.message;
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
