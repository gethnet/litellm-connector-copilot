import * as vscode from "vscode";
import { LiteLLMClient } from "../adapters/litellmClient";
import type {
    LanguageModelChatInformation,
    LanguageModelChatRequestMessage,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";

import type {
    LiteLLMModelInfo,
    LiteLLMModelInfoResponse,
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
import {
    countTokens,
    trimMessagesToFitBudget,
    estimateToolTokens,
    isContextOverflowError,
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

    protected readonly _modelInfoCache = new Map<string, LiteLLMModelInfo | undefined>();
    protected readonly _derivedCapabilitiesCache = new Map<string, DerivedModelCapabilities>();
    protected readonly _parameterProbeCache = new Map<string, Set<string>>();
    protected readonly _effortFallbackCache: EffortFallbackCache;
    protected _lastModelList: LanguageModelChatInformation[] = [];
    protected _modelListFetchedAtMs = 0;
    private _inFlightDiscovery: Promise<vscode.LanguageModelChatInformation[]> | undefined;

    protected _multiBackendClient: MultiBackendClient | undefined;
    protected _activeBackendNames: string[] = [];

    protected _telemetryService?: TelemetryService;

    /**
     * Tracks whether we've already logged the legacy-path deprecation warning this session.
     * The legacy multi-backend / single-backend workspace-settings path is preserved as a
     * compatibility shim for users upgrading from pre-1.119 VS Code, and is scheduled for
     * removal in VS Code 1.125. We emit the warning once per process to avoid log spam while
     * still nudging users toward the 1.120 per-group configuration system.
     */
    private _legacyDeprecationWarningEmitted = false;

    constructor(
        protected readonly secrets: vscode.SecretStorage,
        protected readonly userAgent: string,
        effortFallbackCache?: EffortFallbackCache
    ) {
        this._configManager = new ConfigManager(secrets);
        this._effortFallbackCache = effortFallbackCache ?? new EffortFallbackCache();
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
     * Emits a one-time-per-session warning when the legacy (non-1.120) discovery path is
     * activated. We intentionally rate-limit to one log entry per process to avoid spamming
     * the output channel on every refresh while still surfacing the deprecation to anyone
     * inspecting logs.
     *
     * @deprecated Remove together with the legacy path in VS Code 1.125.
     */
    private _emitLegacyDeprecationWarningOnce(): void {
        if (this._legacyDeprecationWarningEmitted) {
            return;
        }
        this._legacyDeprecationWarningEmitted = true;
        Logger.warn(
            "[deprecation] The legacy LiteLLM workspace-settings discovery path " +
                "(`litellm-connector.backends` / `litellm-connector.url`) is OBSOLETE and " +
                "will be removed in VS Code 1.125. Please configure your LiteLLM backends " +
                "via the VS Code Language Model provider configuration UI (settings → " +
                "Language Models → LiteLLM) so each backend becomes its own per-group " +
                "configuration. See AGENTS.md and the VS Code 1.120 update plan for details."
        );
        if (this._telemetryService) {
            this._telemetryService.captureFeatureUsed("legacy-discovery-path", "deprecation");
        }
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
        const silent = options.silent === true;

        if (this._inFlightDiscovery) {
            Logger.trace("Returning in-flight discovery promise");
            return this._inFlightDiscovery;
        }

        const TTL_MS = 30000; // 30 seconds
        const now = Date.now();
        // Only use cache for legacy path (no configuration provided)
        const useCache = silent && this._lastModelList.length > 0 && now - this._modelListFetchedAtMs < TTL_MS;
        if (useCache && !options.configuration) {
            Logger.trace("Returning cached models (within TTL)");
            if (this._telemetryService) {
                this._telemetryService.captureModelsCacheHit(this._lastModelList.length);
            }
            return this._lastModelList;
        }

        this._inFlightDiscovery = (async () => {
            try {
                return await this._doDiscoverModels(
                    { silent, configuration: options.configuration, groupName: options.groupName },
                    token
                );
            } finally {
                this._inFlightDiscovery = undefined;
            }
        })();

        return this._inFlightDiscovery;
    }

    private async _doDiscoverModels(
        options: { silent: boolean; configuration?: Record<string, unknown>; groupName?: string },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        Logger.trace("discoverModels called");
        try {
            // VS Code 1.119+ path: configuration-based single-backend discovery
            if (options.configuration?.baseUrl) {
                const groupName = options.groupName ?? "default";
                Logger.info(`Using configuration-based discovery for group: ${groupName}`);
                const session = this._configManager.convertProviderConfiguration(groupName, options.configuration);
                if (!session) {
                    Logger.warn("Configuration provided but convertProviderConfiguration returned undefined");
                    return [];
                }
                return this._discoverModelsFromSession(session, options.silent, token);
            }

            // ------------------------------------------------------------------------------------
            // OBSOLETE LEGACY PATH — scheduled for removal in VS Code 1.125
            // ------------------------------------------------------------------------------------
            // Everything below this point exists solely to keep users upgrading from pre-1.119
            // VS Code working without manual reconfiguration. In 1.120+, models should be
            // discovered exclusively via the per-group `options.configuration` system handled
            // above. The legacy multi-backend / single-backend workspace-settings path
            // (`litellm-connector.backends`, `litellm-connector.url`, `litellm-connector.key`)
            // is a compatibility shim only.
            //
            // When we drop support for VS Code <= 1.124, this entire block — along with
            // `ConfigManager.resolveBackends`, the legacy single-backend migration in
            // `getConfig`, and the `manageConfig` legacy single-backend prompt — must be
            // deleted. The 1.120 group system supersedes all of it.
            // ------------------------------------------------------------------------------------
            this._emitLegacyDeprecationWarningOnce();
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
            const backendsByName = new Map(effectiveBackends.map((backend) => [backend.name, backend]));
            // Pre-compute a stable order map for backend categories so picker ordering is
            // deterministic across discovery refreshes (uses the user's configured backend order).
            const backendOrder = new Map(effectiveBackends.map((backend, idx) => [backend.name, idx]));
            const infos: LanguageModelChatInformation[] = aggregated.data.map((entry) => {
                const modelId = entry.namespacedId;
                const modelInfo = entry.model_info;
                this._modelInfoCache.set(modelId, modelInfo);

                if (this._telemetryService) {
                    this._telemetryService.captureModelUsed(modelId, "discovery");
                }

                const derived = deriveCapabilitiesFromModelInfo(modelId, modelInfo);
                this._derivedCapabilitiesCache.set(modelId, derived);

                const capOverride = config.modelCapabilitiesOverrides?.[modelId];
                const capabilities = capabilitiesToVSCode(derived, capOverride);
                const tags = getDerivedModelTags(modelId, derived, undefined, capOverride);

                const rawProvider = modelInfo?.litellm_provider ?? "litellm";
                const rawModelName = entry.model_name ?? modelId;

                const backendDisplay = entry.backendName ? `LiteLLM: ${entry.backendName}` : "LiteLLM";
                const extensionName = "LiteLLM Connector for Copilot";
                const tooltip = `Provider: ${rawProvider}, Model: ${rawModelName} contributed by ${backendDisplay} via ${extensionName}`;

                // Derive family from provider to help Copilot shape requests correctly
                const providerLower = rawProvider.toLowerCase();
                let family = "litellm";
                if (providerLower === "openai") {
                    family = "gpt4";
                } else if (providerLower === "anthropic") {
                    family = "claude";
                }

                // Add cache indicator if model supports prompt caching
                const cacheIndicator = modelInfo?.supports_prompt_caching ? "⚡ " : "";
                const detailBase = entry.backendName ?? "LiteLLM";
                const detail = `${cacheIndicator}${detailBase}`;
                const backend = backendsByName.get(entry.backendName);
                const supportedEfforts = getSupportedReasoningEfforts(modelInfo, modelId);
                const reasoningSchema = this._buildReasoningSchemaWithDiagnostics(modelId, modelInfo, supportedEfforts);
                const info: LiteLLMDiscoveredModel = {
                    id: modelId,
                    name: rawModelName,
                    vendor: rawProvider,
                    backendName: detailBase,
                    tooltip,
                    detail,
                    family: family,
                    version: "1.0.0",
                    maxInputTokens: derived.maxInputTokens,
                    maxOutputTokens: derived.maxOutputTokens,
                    capabilities,
                    tags,
                    // VS Code 1.120+ requires `isUserSelectable: true` for models to appear in the
                    // model picker dropdown. Without this, models only show in the "Manage Language
                    // Models" view but cannot be selected for chat.
                    isUserSelectable: true,
                    // Group models from each backend under its own category heading in the picker.
                    // The label uses the user's backend name; order follows the configured backend
                    // order so categories are presented consistently across refreshes. This is
                    // required for users running multiple LiteLLM proxies side-by-side via the
                    // legacy multi-backend workspace settings path.
                    category: entry.backendName
                        ? { label: entry.backendName, order: backendOrder.get(entry.backendName) ?? 0 }
                        : undefined,
                    configurationSchema: reasoningSchema,
                    _backendName: entry.backendName,
                    _backendUrl: backend?.url,
                    _apiKey: backend?.apiKey,
                };

                return info;
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
     * Discovers models from a single backend session (VS Code 1.119+ configuration path).
     * Used when VS Code passes configuration directly via options.configuration.
     */
    private async _discoverModelsFromSession(
        session: BackendSession,
        silent: boolean,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        Logger.info(`Discovering models from session: ${session.backendName} (${session.baseUrl})`);

        try {
            const client = session.client;
            const models = await client.getModelInfo(token);

            if (!models?.data?.length) {
                Logger.warn(`No models returned from ${session.baseUrl}`);
                return [];
            }

            Logger.info(`Found ${models.data.length} models from ${session.backendName}`);

            // Transform to LanguageModelChatInformation
            const infos = models.data.map((entry: LiteLLMModelInfoResponse["data"][number]) => {
                // Add namespaced ID for single-backend case
                const modelName = entry.model_name;
                const namespacedId = session.backendName
                    ? `${session.backendName}/${modelName}`
                    : (modelName ?? "unknown");
                const modelInfo = entry.model_info;

                // Cache the model info
                this._modelInfoCache.set(namespacedId, modelInfo);

                // Use the same derivation logic as the legacy path
                const derived = deriveCapabilitiesFromModelInfo(namespacedId, modelInfo);
                this._derivedCapabilitiesCache.set(namespacedId, derived);

                const capabilities = capabilitiesToVSCode(derived, undefined);
                const tags = getDerivedModelTags(namespacedId, derived, {}, undefined);

                const maxInputTokens = derived.maxInputTokens;
                const maxOutputTokens = derived.maxOutputTokens;

                const supportedEfforts = getSupportedReasoningEfforts(modelInfo, namespacedId);
                const reasoningSchema = this._buildReasoningSchemaWithDiagnostics(
                    namespacedId,
                    modelInfo,
                    supportedEfforts
                );
                const info: LiteLLMDiscoveredModel = {
                    id: namespacedId,
                    name: modelInfo?.id ?? namespacedId,
                    description: modelInfo?.litellm_provider ?? "",
                    family: modelInfo?.litellm_provider ?? "litellm",
                    version: "1.0",
                    maxInputTokens,
                    maxOutputTokens,
                    capabilities,
                    tags,
                    // VS Code 1.120+ requires `isUserSelectable: true` for models to appear in the
                    // model picker dropdown. Without this, models only show in the "Manage Language
                    // Models" view but cannot be selected for chat.
                    isUserSelectable: true,
                    // In the configuration-driven (per-group) path each session represents a
                    // single backend group. Surfacing it as its own category keeps the picker
                    // organised when the user has configured several groups, and matches the
                    // grouping behaviour of the legacy multi-backend path for visual consistency.
                    category: session.backendName ? { label: session.backendName, order: 0 } : undefined,
                    configurationSchema: reasoningSchema,
                    _backendName: session.backendName,
                    _backendUrl: session.baseUrl,
                    _apiKey: session.apiKey,
                };
                return info;
            });

            // Create a single-backend client for this session
            this._multiBackendClient = new MultiBackendClient(
                [{ name: session.backendName, url: session.baseUrl, apiKey: session.apiKey, enabled: true }],
                this.userAgent
            );
            this._activeBackendNames = [session.backendName];

            // Store in cache for this session only
            this._lastModelList = infos;
            this._modelListFetchedAtMs = Date.now();

            return infos;
        } catch (err) {
            Logger.error(`Failed to fetch models from session ${session.backendName}`, err);
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
            const errorMessage = err instanceof Error ? err.message : String(err);
            Logger.trace(`Background token refinement failed (expected during rapid updates): ${errorMessage}`);
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
     * Resolves a BackendSession for the given model using multi-backend routing.
     * Creates/uses a backend-specific client when the model is namespaced.
     * Falls back to the multi-client when no backend-specific client is available.
     */
    protected async resolveBackendSession(model: LanguageModelChatInformation): Promise<BackendSession | undefined> {
        // Legacy per-backend discovery with namespaced model IDs
        const resolvedBackend = this.resolveModelBackend(model.id);
        if (resolvedBackend && this._multiBackendClient) {
            const fullBackendName = resolvedBackend.backendName;

            // Find the backend in multi client
            const backends = await this._configManager.resolveBackends();
            const targetBackend = backends.find((b) => b.name === fullBackendName);

            if (targetBackend) {
                Logger.debug(`Using namespaced backend session: ${fullBackendName}`);
                return {
                    backendName: fullBackendName,
                    baseUrl: targetBackend.url,
                    apiKey: targetBackend.apiKey,
                    client: new LiteLLMClient({ url: targetBackend.url, key: targetBackend.apiKey }, this.userAgent),
                };
            }
        }

        return undefined;
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
            modelConfiguration?: Record<string, unknown>;
        };
        return {
            caller: opt.caller,
            justification: opt.justification,
            modelConfiguration: opt.modelConfiguration,
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
        const modelInfo = modelInfoOverride ?? this._modelInfoCache.get(model.id);

        // Priority 1: Picker selection (modelConfiguration.reasoningEffort)
        const pickerEffort = telemetry.modelConfiguration?.reasoningEffort;
        if (typeof pickerEffort === "string") {
            if (pickerEffort === "none") {
                Logger.trace(`[reasoning] Picker selected "none" for ${model.id}; suppressing reasoning_effort field.`);
                return undefined;
            }
            if (this.isReasoningEffortSupported(pickerEffort, modelInfo, model.id)) {
                return pickerEffort;
            }
            Logger.warn(
                `[reasoning] Picker selected unsupported effort "${pickerEffort}" for ${model.id}; suppressing field.`
            );
            return undefined;
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
        if (!modelInfo && !modelId) {
            return false;
        }

        const supportedEfforts = getSupportedReasoningEfforts(modelInfo, modelId);
        return supportedEfforts.includes(effort as (typeof supportedEfforts)[number]);
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

        const reasoningEffort = this.getReasoningEffort(options, model, modelInfo);

        const requestBody: OpenAIChatCompletionRequest = {
            model: model.id,
            messages: openaiMessages,
            stream: true,
            max_tokens:
                typeof options.modelOptions?.max_tokens === "number"
                    ? Math.min(options.modelOptions.max_tokens, model.maxOutputTokens)
                    : model.maxOutputTokens,
            // LiteLLM expects the OpenAI-compatible flat `reasoning_effort` key on
            // /chat/completions and /responses alike. Sending the previous nested
            // `reasoning: { effort }` shape caused 400 errors from upstream providers
            // because LiteLLM did not translate it. We send a single canonical format
            // and let LiteLLM route to the appropriate provider-specific shape.
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
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
        const reasoningEffort = this.getReasoningEffort(options, model, modelInfo);

        const requestBody: OpenAIChatCompletionRequest = {
            model: model.id,
            messages: convertV2MessagesToOpenAI(trimmedMessages),
            stream: true,
            max_tokens:
                typeof options.modelOptions?.max_tokens === "number"
                    ? Math.min(options.modelOptions.max_tokens, model.maxOutputTokens)
                    : model.maxOutputTokens,
            // See sibling note in `buildOpenAIChatRequest` — single canonical format.
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
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
        const originalEffort = (request as { reasoning_effort?: SupportedReasoningEffort }).reasoning_effort;
        let effectiveEffort = this._effortFallbackCache.getEffectiveEffort(modelId, originalEffort);
        this.applyReasoningEffort(request, effectiveEffort);

        const notificationKeyEffort = originalEffort ?? effectiveEffort;
        let attempts = 0;
        let lastError: unknown;

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
                if (!isReasoningError(err)) {
                    throw err;
                }

                lastError = err;
                const nextEffort = this._effortFallbackCache.recordFailure(modelId, effectiveEffort);
                attempts += 1;

                if (nextEffort === effectiveEffort || attempts >= 5) {
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
