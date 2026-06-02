import * as vscode from "vscode";
import { MultiBackendClient } from "../../adapters/multiBackendClient";
import { Logger } from "../../utils/logger";
import {
    deriveCapabilitiesFromModelInfo,
    capabilitiesToVSCode,
    getModelTags as getDerivedModelTags,
    buildReasoningEffortConfigurationSchema,
    getSupportedReasoningEfforts,
} from "../../utils/modelCapabilities";
import { deriveGroupNameFromUrl } from "../../utils";
import type { LiteLLMConfig, LiteLLMModelInfo, LiteLLMModelInfoResponse } from "../../types";
import type { BackendSession } from "../backendSession";
import { sharedDiscoveryBackoff } from "./discoveryBackoff";
import type { DiscoverArgs, DiscoveryDeps } from "./types";

// 5-minute TTL.  Model lists change rarely (deployments, backend restarts).
// A short TTL (previously 30 s) caused a full /model/info HTTP fetch before
// every chat turn — each fetch returned new JS object instances, which VS Code
// treated as a model-list change and reset the reasoning-effort picker.
const TTL_MS = 5 * 60 * 1_000;

export class ModelDiscovery {
    private readonly configManager: DiscoveryDeps["configManager"];
    private readonly userAgent: string;
    private readonly onModernConfigurationDetected?: () => void;
    private readonly modelInfoCache = new Map<string, LiteLLMModelInfo | undefined>();
    private readonly derivedCapabilitiesCache = new Map<string, ReturnType<typeof deriveCapabilitiesFromModelInfo>>();
    private readonly perConfigCache = new Map<
        string,
        { models: vscode.LanguageModelChatInformation[]; fetchedAtMs: number }
    >();
    private lastModelList: vscode.LanguageModelChatInformation[] = [];
    private modelListFetchedAtMs = 0;
    private inFlightDiscovery: Promise<vscode.LanguageModelChatInformation[]> | undefined;
    private multiBackendClient: MultiBackendClient | undefined;
    private activeBackendNames: string[] = [];

    constructor(deps: DiscoveryDeps) {
        this.configManager = deps.configManager;
        this.userAgent = deps.userAgent;
        this.onModernConfigurationDetected = deps.onModernConfigurationDetected;
    }

    public clearCaches(): void {
        this.modelInfoCache.clear();
        this.derivedCapabilitiesCache.clear();
        this.perConfigCache.clear();
        this.lastModelList = [];
        this.modelListFetchedAtMs = 0;
        sharedDiscoveryBackoff.reset();
    }

    public getModelInfo(id: string): LiteLLMModelInfo | undefined {
        return this.modelInfoCache.get(id);
    }

    public getDerivedCapabilities(id: string): ReturnType<typeof deriveCapabilitiesFromModelInfo> | undefined {
        return this.derivedCapabilitiesCache.get(id);
    }

    public getLastModels(): vscode.LanguageModelChatInformation[] {
        return this.lastModelList;
    }

    public getDiscoveredModelBackend(
        modelId: string
    ): { backendName: string; url: string; apiKey?: string } | undefined {
        // First, search lastModelList (populated by legacy multi-backend discovery or accumulated per-group discovery)
        const entry = this.lastModelList.find((m) => m.id === modelId) as
            | (vscode.LanguageModelChatInformation & {
                  _backendName?: string;
                  _backendUrl?: string;
                  _apiKey?: string;
              })
            | undefined;
        if (entry?._backendName && entry._backendUrl) {
            return {
                backendName: entry._backendName,
                url: entry._backendUrl,
                apiKey: entry._apiKey,
            };
        }

        // Fallback: search per-config cache entries for models from other backends
        // This handles the case where VS Code has multiple provider groups configured
        // and we need to route to a backend that wasn't the most recent discovery target
        for (const cachedEntry of this.perConfigCache.values()) {
            const cachedModel = cachedEntry.models.find((m) => m.id === modelId) as
                | (vscode.LanguageModelChatInformation & {
                      _backendName?: string;
                      _backendUrl?: string;
                      _apiKey?: string;
                  })
                | undefined;
            if (cachedModel?._backendName && cachedModel?._backendUrl) {
                return {
                    backendName: cachedModel._backendName,
                    url: cachedModel._backendUrl,
                    apiKey: cachedModel._apiKey,
                };
            }
        }

        return undefined;
    }

    public getActiveBackends(): string[] {
        return this.activeBackendNames;
    }

    private getConfigCacheKey(configuration: Record<string, unknown>): string {
        const providerName = typeof configuration.providerName === "string" ? configuration.providerName : "";
        const baseUrl = typeof configuration.baseUrl === "string" ? configuration.baseUrl : "";
        return `${providerName}::${baseUrl}`;
    }

    private hasModelListDrift(
        cached: vscode.LanguageModelChatInformation[],
        fresh: vscode.LanguageModelChatInformation[]
    ): boolean {
        if (cached.length !== fresh.length) {
            return true;
        }
        for (let i = 0; i < cached.length; i++) {
            const cachedModel = cached[i] as vscode.LanguageModelChatInformation & { _backendName?: string };
            const freshModel = fresh[i] as vscode.LanguageModelChatInformation & { _backendName?: string };
            if (cachedModel.id !== freshModel.id) {
                return true;
            }
            if (cachedModel.name !== freshModel.name) {
                return true;
            }
            if ((cachedModel as { vendor?: unknown }).vendor !== (freshModel as { vendor?: unknown }).vendor) {
                return true;
            }
            if (cachedModel.isUserSelectable !== freshModel.isUserSelectable) {
                return true;
            }
            if (
                JSON.stringify((cachedModel as { category?: unknown }).category) !==
                JSON.stringify((freshModel as { category?: unknown }).category)
            ) {
                return true;
            }
            if (JSON.stringify(cachedModel.configurationSchema) !== JSON.stringify(freshModel.configurationSchema)) {
                return true;
            }
        }
        return false;
    }

    public async discover(args: DiscoverArgs): Promise<vscode.LanguageModelChatInformation[]> {
        const { options, token } = args;
        if (this.inFlightDiscovery) {
            return this.inFlightDiscovery;
        }

        // Honour the TTL for ALL calls — not just silent ones.
        //
        // VS Code calls provideLanguageModelChatInformation with silent=false before every
        // chat turn (to confirm the selected model is still valid).  Previously we only
        // checked the cache when silent=true, so every turn fired a live /model/info HTTP
        // request.  Each live fetch creates new JS object instances; VS Code compares model
        // objects by reference/identity and treats new instances as "model changed", which
        // resets the reasoning-effort picker back to its default.
        //
        // The only legitimate reason to bypass the TTL is an explicit user-triggered cache
        // clear (clearModelCache / reload command), which sets modelListFetchedAtMs = 0 and
        // perConfigCache entries to stale, so those calls naturally fall through to doDiscover.
        const now = Date.now();
        if (options.configuration) {
            const key = this.getConfigCacheKey(options.configuration);
            const cached = this.perConfigCache.get(key);
            if (cached && now - cached.fetchedAtMs < TTL_MS) {
                return cached.models;
            }
        } else if (this.lastModelList.length > 0 && now - this.modelListFetchedAtMs < TTL_MS) {
            return this.lastModelList;
        }

        this.inFlightDiscovery = this.doDiscover(options, token);
        try {
            return await this.inFlightDiscovery;
        } finally {
            this.inFlightDiscovery = undefined;
        }
    }

    private async doDiscover(
        options: { silent?: boolean; configuration?: Record<string, unknown>; groupName?: string },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        try {
            if (options.configuration) {
                const configuredProviderName =
                    typeof options.configuration.providerName === "string"
                        ? options.configuration.providerName.trim()
                        : "";
                const configuredBaseUrl =
                    typeof options.configuration.baseUrl === "string" ? options.configuration.baseUrl.trim() : "";
                const derivedGroupName = deriveGroupNameFromUrl(configuredBaseUrl).trim();
                const groupName =
                    options.groupName ??
                    (configuredProviderName.length > 0 ? configuredProviderName : undefined) ??
                    (derivedGroupName.length > 0 ? derivedGroupName : undefined) ??
                    "default";
                const session = this.configManager.convertProviderConfiguration(groupName, options.configuration);
                if (session) {
                    this.onModernConfigurationDetected?.();
                    const models = await this.discoverFromSession(session, token);
                    const key = this.getConfigCacheKey(options.configuration);
                    const cached = this.perConfigCache.get(key);
                    if (cached && !this.hasModelListDrift(cached.models, models)) {
                        return cached.models;
                    }
                    this.perConfigCache.set(key, { models, fetchedAtMs: Date.now() });
                    return models;
                }
            }

            const backends = await this.configManager.resolveBackends();
            if (!backends || backends.length === 0) {
                return [];
            }
            return this.discoverFromBackends(backends, token);
        } catch (err) {
            // Apply backoff policy on discovery failures.
            // After 9 failures, we start delaying and eventually block.
            // After the 10th failure, we throw a Blocked error to signal that VS Code should back off.
            const decision = sharedDiscoveryBackoff.recordFailure(Date.now());

            // Extract error message for logging
            const errorMessage = (err instanceof Error ? err.message : String(err)) || "Unknown discovery error";

            // Delay briefly on failure attempts to avoid rapid polling
            if (decision.delayMs > 0) {
                await this.sleep(decision.delayMs, token);
            }

            // On the 10th consecutive failure, block further attempts for a cooldown period
            if (decision.shouldBlock) {
                throw vscode.LanguageModelError.Blocked(
                    `Discovery blocked after ${decision.attempt} consecutive failures. ` +
                        `The LiteLLM endpoint appears to be unhealthy. ` +
                        `Please check your configuration and retry later.`
                );
            }

            // Return empty array for non-blocked failures (continue operation)
            return [];
        }
    }

    private async discoverFromBackends(
        backends: { name: string; url: string; apiKey?: string; enabled: boolean }[],
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const config = await this.configManager.getConfig();
        const multiClient = new MultiBackendClient(backends, this.userAgent);
        const models = await multiClient.getModelInfoAll(token);
        if (!models?.data?.length) {
            return [];
        }

        const backendByName = new Map(backends.map((b) => [b.name, b]));
        const infos = models.data
            .map((entry) =>
                this.toVSCodeInfo(
                    entry,
                    entry.backendName,
                    backendByName.get(entry.backendName),
                    config.forceResponsesEndpoint,
                    config.modelCapabilitiesOverrides
                )
            )
            .filter((info) => info.isUserSelectable !== false);

        this.multiBackendClient = multiClient;
        this.activeBackendNames = backends.map((b) => b.name);
        this.lastModelList = infos;
        this.modelListFetchedAtMs = Date.now();
        return infos;
    }

    private async discoverFromSession(
        session: BackendSession,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const config = await this.configManager.getConfig();
        const models = await session.client.getModelInfo(token);
        if (!models?.data?.length) {
            return [];
        }

        const infos = models.data
            .map((entry) =>
                this.toVSCodeInfo(
                    entry,
                    session.backendName,
                    { url: session.baseUrl, apiKey: session.apiKey },
                    config.forceResponsesEndpoint,
                    config.modelCapabilitiesOverrides
                )
            )
            .filter((info) => info.isUserSelectable !== false);

        // Update per-backend multi-client for this session
        // Note: This client is only used for legacy paths; per-session routing
        // uses the backend info stored on the model objects themselves
        this.multiBackendClient = new MultiBackendClient(
            [{ name: session.backendName, url: session.baseUrl, apiKey: session.apiKey, enabled: true }],
            this.userAgent
        );

        // Track this backend as active (for legacy discovery path compatibility)
        if (!this.activeBackendNames.includes(session.backendName)) {
            this.activeBackendNames.push(session.backendName);
        }

        // Merge new models into lastModelList (accumulate across multiple backends)
        // This prevents the infinite loop where each backend's discovery overwrites
        // the previous list, causing VS Code to see "model list changed" and re-query
        const existingModelIds = new Set(this.lastModelList.map((m) => m.id));
        const newModels = infos.filter((m) => !existingModelIds.has(m.id));
        this.lastModelList = [...this.lastModelList, ...newModels];
        this.modelListFetchedAtMs = Date.now();
        return infos;
    }

    private toVSCodeInfo(
        entry: LiteLLMModelInfoResponse["data"][number],
        backendName: string,
        backend: { url?: string; apiKey?: string } | undefined,
        forceResponsesEndpoint?: boolean,
        modelCapabilitiesOverrides?: LiteLLMConfig["modelCapabilitiesOverrides"]
    ): vscode.LanguageModelChatInformation & {
        vendor?: string;
        backendName?: string;
        detail?: string;
        tooltip?: string;
        description?: string;
        tags?: string[];
        category?: { label: string; order: number };
        _backendName?: string;
        _backendUrl?: string;
        _apiKey?: string;
    } {
        if (!entry.model_name) {
            Logger.warn(
                `Skipping model entry without model_name from backend "${backendName}". Entry keys: ${Object.keys(
                    entry
                ).join(",")}`
            );
            // Return a non-user-selectable placeholder; caller filters these out
            return {
                id: `${backendName}/unknown`,
                name: "unknown",
                vendor: entry.model_info?.litellm_provider ?? "litellm",
                backendName,
                detail: backendName,
                description: entry.model_info?.litellm_provider ?? "",
                family: entry.model_info?.litellm_provider ?? "litellm",
                version: "1.0",
                maxInputTokens: 0,
                maxOutputTokens: 0,
                capabilities: { canGenerate: false },
                isUserSelectable: false,
                category: { label: backendName, order: 0 },
                configurationSchema: undefined,
                _backendName: backendName,
                _backendUrl: backend?.url ?? "",
                _apiKey: backend?.apiKey,
            } as vscode.LanguageModelChatInformation & { isUserSelectable: boolean };
        }

        const modelName = entry.model_name;
        const namespacedId = `${backendName}/${modelName}`;
        let modelInfo = entry.model_info;
        if (forceResponsesEndpoint && modelInfo?.mode === "chat") {
            modelInfo = { ...modelInfo, mode: "responses" as const };
        }

        this.modelInfoCache.set(namespacedId, modelInfo);
        const derived = deriveCapabilitiesFromModelInfo(namespacedId, modelInfo);
        this.derivedCapabilitiesCache.set(namespacedId, derived);

        const capabilityOverrides =
            modelCapabilitiesOverrides?.[namespacedId] ?? modelCapabilitiesOverrides?.[modelName];
        const capabilities = capabilitiesToVSCode(derived, capabilityOverrides);
        const tags = getDerivedModelTags(namespacedId, derived, {}, capabilityOverrides);
        const supportedEfforts = getSupportedReasoningEfforts(modelInfo, namespacedId);
        const reasoningSchema = buildReasoningEffortConfigurationSchema(supportedEfforts, namespacedId, modelInfo);

        const cacheIndicator = modelInfo?.supports_prompt_caching ? "⚡ " : "";
        const detailBase = backendName ?? "LiteLLM";
        const detail = cacheIndicator + detailBase;

        return {
            id: namespacedId,
            name: modelName,
            vendor: modelInfo?.litellm_provider ?? "litellm",
            backendName: detailBase,
            tooltip: `Provider: ${modelInfo?.litellm_provider ?? "litellm"}, Model: ${modelName} via ${detailBase}`,
            detail,
            description: modelInfo?.litellm_provider ?? "",
            family: modelInfo?.litellm_provider ?? "litellm",
            version: "1.0",
            maxInputTokens: derived.maxInputTokens,
            maxOutputTokens: derived.maxOutputTokens,
            capabilities,
            tags,
            isUserSelectable: true,
            category: backendName ? { label: backendName, order: 0 } : undefined,
            configurationSchema: reasoningSchema,
            _backendName: backendName,
            _backendUrl: backend?.url ?? "",
            _apiKey: backend?.apiKey,
        };
    }

    private sleep(ms: number, _token?: vscode.CancellationToken): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
