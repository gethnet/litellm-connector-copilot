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
        const baseUrl = typeof configuration.baseUrl === "string" ? configuration.baseUrl.trim() : "";
        // Normalize URL to prevent cache misses from variations
        // - Remove trailing slashes
        // - Normalize protocol to lowercase
        let normalized = baseUrl.replace(/\/+$/, "").trim();
        if (normalized.toLowerCase().startsWith("https://")) {
            normalized = "https://" + normalized.slice(8).replace(/^\/+/, "");
        } else if (normalized.toLowerCase().startsWith("http://")) {
            normalized = "http://" + normalized.slice(7).replace(/^\/+/, "");
        }
        return normalized;
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
        }
        // NOTE: Vendor-level calls (no options.configuration) MUST NOT return cached models
        // from lastModelList. VS Code's _resolveAllLanguageModels makes BOTH vendor-level
        // AND group-specific discovery calls, then COMBINES all results into a single array.
        // Returning lastModelList here would cause duplicate models when VS Code combines
        // vendor-level results with group-specific results. Instead, we let the call fall
        // through to doDiscover() which correctly returns [] for vendor-level calls.

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
                const configuredBaseUrl =
                    typeof options.configuration.baseUrl === "string" ? options.configuration.baseUrl.trim() : "";

                // Clean hostname (e.g. "llmapi.wolfram.com") — drives model-ID/routing.
                const urlHostname = deriveGroupNameFromUrl(configuredBaseUrl).trim();

                // User-facing group name (e.g. "LiteLLM: Wolfram") — drives the picker category label.
                const displayLabel =
                    options.groupName ?? (urlHostname.length > 0 ? urlHostname : undefined) ?? "LiteLLM";

                // backendName (routing identity) must be the clean hostname so model IDs match
                // what user settings reference. Fall back to displayLabel only if no hostname.
                const backendIdentity = urlHostname.length > 0 ? urlHostname : displayLabel;

                const session = this.configManager.convertProviderConfiguration(backendIdentity, options.configuration);
                if (session) {
                    this.onModernConfigurationDetected?.();

                    // Check cache BEFORE fetching to prevent discovery loops
                    const key = this.getConfigCacheKey(options.configuration);
                    const cached = this.perConfigCache.get(key);
                    const cacheTtlMs = 300000; // 5 minutes
                    if (cached && Date.now() - cached.fetchedAtMs < cacheTtlMs) {
                        return cached.models;
                    }

                    // Cache miss or expired - fetch fresh models
                    const models = await this.discoverFromSession(session, token, displayLabel);

                    // Update cache with fresh results
                    this.perConfigCache.set(key, { models, fetchedAtMs: Date.now() });
                    return models;
                }
            }

            // OBSOLETE (remove in 1.125): Legacy workspace-settings discovery path
            //
            // CRITICAL: When a provider has a configuration schema, VS Code makes TWO types of calls:
            // 1. Vendor-level discovery (no options.configuration) - to check if vendor has any models
            // 2. Group-specific discovery (with options.configuration) - to get models for a configured group
            //
            // For providers with configuration schemas, we must return EMPTY ARRAY for vendor-level calls.
            // Otherwise, models returned here become "orphans" without group context, and VS Code assigns
            // them to the provider's displayName ("LiteLLM"), causing a spurious "LiteLLM" group to appear
            // alongside the user's actual configured group(s).
            //
            // The legacy path below is now only executed during the deprecation window for users upgrading
            // from pre-1.119 VS Code versions. When the minimum supported VS Code is raised to >= 1.125,
            // this entire path will be removed.
            return [];
        } catch {
            // Apply backoff policy on discovery failures.
            // After 9 failures, we start delaying and eventually block.
            // After the 10th failure, we throw a Blocked error to signal that VS Code should back off.
            const decision = sharedDiscoveryBackoff.recordFailure(Date.now());

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

    private async discoverFromSession(
        session: BackendSession,
        token: vscode.CancellationToken,
        displayLabel?: string
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
                    displayLabel ?? session.backendName,
                    config.forceResponsesEndpoint,
                    config.modelCapabilitiesOverrides
                )
            )
            .filter((info) => info.isUserSelectable !== false);

        // Update per-backend multi-client for this session. The provider base uses this
        // client to route request streams via `resolveModelBackend()`.
        this.multiBackendClient = new MultiBackendClient(
            [{ name: session.backendName, url: session.baseUrl, apiKey: session.apiKey, enabled: true }],
            this.userAgent
        );

        // Track this backend as active for namespaced model-id parsing.
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
        displayLabel: string,
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
                category: { label: displayLabel, order: 0 },
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
            category: { label: displayLabel, order: 0 },
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
