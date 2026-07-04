/**
 * BackendRegistry — the single source of truth for backends and their
 * associated models.
 *
 * This class owns:
 *  1. **Discovery**: a stateless per-group `/model/info` fetch that runs on
 *     every `discoverModels` call. There is no model-list cache: each call
 *     is a fresh HTTP request, and the response is namespaced into
 *     `<routingIdentity>/<rawModelName>` ids.
 *  2. **Storage**: an in-memory map of (namespaced id) → {baseUrl, apiKey,
 *     rawModelName, routingIdentity}, plus a per-backend view of the last
 *     delivered model list (used solely for change detection).
 *  3. **Change detection**: emits `onDidChange` when a backend's model set
 *     actually differs from the prior delivery, so VS Code only refreshes
 *     the picker when the set has really changed.
 *  4. **Capability caches**: per-model `LiteLLMModelInfo` and derived
 *     capabilities. These are populated as a side effect of discovery and
 *     feed the request hot path. They are NOT a model-list cache — they
 *     cache the capability info for known models.
 *
 * Public surface (read + ingress)
 * --------------------------------
 *  - `discoverModels(options, token)` — the only way for VS Code (or any
 *    consumer) to fetch a model list and populate the registry.
 *  - `lookup(id)` — resolve a namespaced id to its routing entry.
 *  - `findBackendForRawName(name)` — workspace-override routing lookup.
 *  - `extractRawName(id)` — strip the routing prefix from a namespaced id.
 *  - `getModelInfo(id)` / `getDerivedCapabilities(id)` — read the
 *    capability caches populated during discovery.
 *  - `size()` — number of distinct backends currently registered.
 *  - `clear()` — wipe the routing table (call on user-initiated reload).
 *  - `clearCaches()` — wipe the capability caches + backoff controller.
 *  - `onDidChange` — fires when a backend's model set changes.
 *
 * Internal surface (write)
 * ------------------------
 *  - `setModelsForBackend(...)` — internal write, called only by
 *    `discoverInternal`. Not part of the public contract.
 *  - `getModelsForBackend(baseUrl)` / `getModelIdsForBackend(baseUrl)` —
 *    internal read, used only by `discoverInternal` for change detection.
 *
 * Why merge discovery into the registry?
 * --------------------------------------
 * The previous design kept `ModelDiscovery` as a separate class and the
 * registry as a pure data structure. That meant the base provider had to
 * call `modelDiscovery.discover(...)`, then `registry.setModelsForBackend`,
 * then check `registry.getModelIdsForBackend` for change detection — a
 * three-step orchestration that was easy to get wrong (write-before-compare
 * silently broke change detection). With the merge, `discoverModels` is
 * the only call site that needs to know the write protocol exists, and
 * consumers see a single ingress that returns the model list, updates the
 * registry, and fires the change event as a unit.
 *
 * Per-group namespacing
 * ---------------------
 * The namespaced id format `<routingIdentity>/<rawModelName>` is the
 * keystone of multi-backend support: it lets the response path look up
 * routing in O(1) by id, with no per-backend scan and no ambiguity when
 * two backends advertise the same raw model name. The routing identity is
 * the URL hostname (with the user-entered group name as fallback); the
 * raw model name is the part after the first `/` in the id, preserved
 * unchanged from what the backend returned.
 */
import * as vscode from "vscode";
import type { LanguageModelChatInformation } from "vscode";
import { Logger } from "../utils/logger";
import { StructuredLogger } from "../observability/structuredLogger";
import {
    deriveCapabilitiesFromModelInfo,
    capabilitiesToVSCode,
    getModelTags as getDerivedModelTags,
    buildReasoningEffortConfigurationSchema,
    getSupportedReasoningEfforts,
    derivePickerCategory,
} from "../utils/modelCapabilities";
import { deriveGroupNameFromUrl } from "../utils";
import { sha256HexAsync } from "../utils/discoveryHash";
import type { LiteLLMConfig, LiteLLMModelInfo, LiteLLMModelInfoResponse } from "../types";
import type { ConfigManager } from "../config/configManager";
import type { BackendSession } from "./backendSession";
import { sharedDiscoveryBackoff } from "./base/discoveryBackoff";
import { DebouncedEmitter } from "./base/debouncedEmitter";
import {
    derivePriceCategory,
    extractPricing,
    formatPricingForDetail,
    formatPricingForTooltip,
} from "../utils/pricingCalculator";

/**
 * Cached result from a /model/info discovery call.
 */
interface CachedDiscoveryResult {
    readonly bodyHash: string;
    readonly models: readonly vscode.LanguageModelChatInformation[];
    readonly fetchedAtMs: number;
    readonly ttlMs: number;
}

/**
 * Computes a deterministic cache key for discovery responses.
 * Key format: normalizedBaseUrl#apiKeyHashSuffix
 * apiKey is hashed with SHA-256 and only the first 8 chars are used internally.
 * The raw API key is never logged or persisted.
 */
async function hashApiKeySuffixAsync(apiKey: string | undefined): Promise<string> {
    return apiKey ? (await sha256HexAsync(apiKey)).slice(0, 8) : "anonymous";
}

function normalizeBaseUrl(baseUrl: string): string {
    // Remove trailing slashes and normalize https:// prefix
    return baseUrl.replace(/\/+$/, "").replace(/^http:\/\//i, "https://");
}

async function toDiscoveryCacheKey(baseUrl: string, apiKey: string | undefined): Promise<string> {
    return `${normalizeBaseUrl(baseUrl)}#${await hashApiKeySuffixAsync(apiKey)}`;
}

/**
 * The shape returned by `lookup(id)`. The response path needs the
 * baseUrl/apiKey to construct the transport, and the rawModelName to
 * populate `request.model` in the OpenAI-compatible body (LiteLLM does
 * NOT understand the namespaced id).
 */
export interface RegistryEntry {
    readonly baseUrl: string;
    readonly apiKey: string;
    /** The raw LiteLLM model_name (the part after the first `/` in the id). */
    readonly rawModelName: string;
    /** The routing identity (the part before the first `/` in the id). */
    readonly routingIdentity: string;
}

/**
 * The dependency bundle required to construct a registry. Bundled so
 * the constructor signature stays stable and the registry can be
 * unit-tested with a stub ConfigManager.
 */
export interface RegistryDeps {
    readonly configManager: ConfigManager;
    readonly userAgent: string;
    readonly onModernConfigurationDetected?: () => void;
}

/**
 * Return value of `discoverInternal` for a single per-group call.
 * The `changed` flag tells callers whether the change event should fire.
 */
export interface DiscoveryOutcome {
    readonly models: LanguageModelChatInformation[];
    readonly changed: boolean;
    readonly session?: BackendSession;
    readonly routingIdentity: string;
}

/**
 * Returns true if two sets contain the same elements. Order-independent.
 * Used by `discoverInternal` to decide whether firing the change event
 * would be a no-op signal.
 */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) {
        return false;
    }
    for (const value of a) {
        if (!b.has(value)) {
            return false;
        }
    }
    return true;
}

export class LiteLLMProviderRegistry implements vscode.Disposable {
    private readonly configManager: RegistryDeps["configManager"];
    private readonly _userAgent: string;
    private readonly _onModernConfigurationDetected?: () => void;

    private readonly entries = new Map<string, RegistryEntry>();
    private readonly modelsByBackend = new Map<string, LanguageModelChatInformation[]>();

    /**
     * Tracks parameters that were auto-stripped after a failed request so callers
     * can proactively omit them on subsequent calls. Single source of truth for
     * dynamically-learned parameter limits.
     */
    private readonly unsupportedParamsByModel = new Map<string, Set<string>>();

    /**
     * Per-model capability caches. These are populated as a side effect of
     * discovery and feed the request hot path (`buildOpenAIChatRequest`,
     * token utilities, capability derivation). They are NOT a model list
     * cache — they cache the capability info for known models.
     */
    private readonly modelInfoCache = new Map<string, LiteLLMModelInfo | undefined>();
    private readonly derivedCapabilitiesCache = new Map<string, ReturnType<typeof deriveCapabilitiesFromModelInfo>>();

    private readonly _onDidChangeEmitter = new vscode.EventEmitter<void>();

    // Discovery response cache for /model/info responses
    private readonly discoveryResponseCache = new Map<string, CachedDiscoveryResult>();

    // Debounced change event emitter (initialized lazily on first use)
    private _debouncedOnDidChange: DebouncedEmitter | undefined;

    // Discovery debounce defaults
    private static readonly DEFAULT_DISCOVERY_FIRE_DEBOUNCE_MS = 250;
    private static readonly DEFAULT_DISCOVERY_FIRE_MIN_INTERVAL_MS = 2_000;

    /**
     * Emits when a backend's discovered model set has actually changed
     * since the prior delivery. The base provider subscribes once and
     * wires it to VS Code's `onDidChangeLanguageModelChatInformation`.
     */
    public readonly onDidChange: vscode.Event<void> = this._onDidChangeEmitter.event;

    constructor(deps: RegistryDeps) {
        this.configManager = deps.configManager;
        this._userAgent = deps.userAgent;
        this._onModernConfigurationDetected = deps.onModernConfigurationDetected;
    }

    /**
     * Gets or creates the debounced change emitter. Uses workspace config if available,
     * otherwise falls back to defaults. This is called lazily to avoid async config
     * reads during construction.
     */
    private async getDebouncedEmitter(): Promise<DebouncedEmitter> {
        if (!this._debouncedOnDidChange) {
            const config = await this.configManager.getConfig();
            const debounceMs =
                config.discoveryFireDebounceMs ?? LiteLLMProviderRegistry.DEFAULT_DISCOVERY_FIRE_DEBOUNCE_MS;
            const minIntervalMs =
                config.discoveryFireMinIntervalMs ?? LiteLLMProviderRegistry.DEFAULT_DISCOVERY_FIRE_MIN_INTERVAL_MS;

            this._debouncedOnDidChange = new DebouncedEmitter(
                () => this._onDidChangeEmitter.fire(),
                debounceMs,
                minIntervalMs,
                (reasons) => {
                    if (reasons.length > 1) {
                        StructuredLogger.debug("discovery.fire_debounced", {
                            baseUrl: reasons[0] ?? "unknown",
                            coalescedFires: reasons.length,
                            windowMs: debounceMs,
                        });
                    }
                }
            );
        }
        return this._debouncedOnDidChange;
    }

    // -------------------------------------------------------------------------
    // Public ingress
    // -------------------------------------------------------------------------

    /**
     * The single public entry point for discovery.
     *
     * - Vendor-level calls (no `options.configuration`) return `[]` and do
     *   not fire `onDidChange`.
     * - Per-group calls perform a fresh `/model/info` fetch, namespace the
     *   ids, record the per-backend view, and fire `onDidChange` if and
     *   only if the model set for that baseUrl actually differs from the
     *   prior delivery.
     *
     * Stateless by design: there is no model-list cache, no in-flight
     * de-duplication, and no TTL. Every call is a single HTTP round-trip.
     * The "ghost cache" is gone, and the picker always reflects the live
     * state of the backend.
     */
    public async discoverModels(
        options: {
            silent?: boolean;
            configuration?: Record<string, unknown>;
            groupName?: string;
        },
        token: vscode.CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        const outcome = await this.discoverInternal(options, token);
        if (outcome.changed) {
            // Use debounced emitter to rate-limit rapid changes
            const debouncedEmitter = await this.getDebouncedEmitter();
            const baseUrl = outcome.session?.baseUrl ?? "unknown";
            debouncedEmitter.fire(baseUrl);
            StructuredLogger.debug("discovery.fire", { baseUrl, reason: "model_change" });
        }
        return outcome.models;
    }

    // -------------------------------------------------------------------------
    // Public read
    // -------------------------------------------------------------------------

    /**
     * Direct lookup of the routing entry for a given id. The id is the
     * namespaced id VS Code hands back at response time. Returns undefined
     * if the id is not in the registry.
     *
     * This is the response path's fallback for when VS Code does not pass
     * the per-group BYOK config on the chat call.
     */
    public lookup(id: string): RegistryEntry | undefined {
        const entry = this.entries.get(id);
        if (entry) {
            Logger.trace(
                `LiteLLMProviderRegistry.lookup HIT: id="${id}" -> baseUrl="${entry.baseUrl}" rawModelName="${entry.rawModelName}" routingIdentity="${entry.routingIdentity}"`
            );
        } else {
            const keys = [...this.entries.keys()];
            const sample = keys.slice(0, 3);
            Logger.trace(
                `LiteLLMProviderRegistry.lookup MISS: id="${id}" entryCount=${this.entries.size} sampleKeys=[${sample.join(", ")}]`
            );
        }
        return entry;
    }

    /**
     * Aggregated, deduplicated model list across all registered backends. Intended
     * for read-only access (e.g., commit provider) without introducing secondary
     * caches.
     */
    public getAllModels(): LanguageModelChatInformation[] {
        const seen = new Set<string>();
        const out: LanguageModelChatInformation[] = [];
        for (const models of this.modelsByBackend.values()) {
            for (const model of models) {
                if (seen.has(model.id)) {
                    continue;
                }
                seen.add(model.id);
                out.push(model);
            }
        }
        return out;
    }

    /**
     * Splits a namespaced id into its routing identity and raw model name
     * parts. The split is on the FIRST `/` because raw model names from
     * LiteLLM commonly contain slashes (e.g. `azure_ai/gpt-5.4-mini`).
     *
     * - `<routing>/<raw>` → `{routingIdentity: "<routing>", rawModelName: "<raw>"}`
     * - `<raw>` (no `/`) → `{routingIdentity: "", rawModelName: "<raw>"}`
     */
    public extractRawName(id: string): string {
        const slash = id.indexOf("/");
        if (slash < 0) {
            return id;
        }
        return id.slice(slash + 1);
    }

    /**
     * Scans every registered entry's `rawModelName` for a match and returns
     * the routing entry. Used by workspace-level `modelIdOverride` resolution,
     * where the user enters a raw model name (e.g. `azure_ai/gpt-5.4-mini`)
     * and we need to find the backend that can serve it.
     */
    public findBackendForRawName(rawName: string): RegistryEntry | undefined {
        for (const entry of this.entries.values()) {
            if (entry.rawModelName === rawName) {
                return entry;
            }
        }
        return undefined;
    }

    /**
     * Returns the per-model `LiteLLMModelInfo` cached during the most
     * recent discovery for this id, or `undefined` if the id has not
     * been seen (or has been cleared).
     */
    public getModelInfo(id: string): LiteLLMModelInfo | undefined {
        return this.modelInfoCache.get(id);
    }

    /**
     * Returns the derived capabilities cached during the most recent
     * discovery for this id, or `undefined` if the id has not been seen.
     */
    public getDerivedCapabilities(id: string): ReturnType<typeof deriveCapabilitiesFromModelInfo> | undefined {
        return this.derivedCapabilitiesCache.get(id);
    }

    /**
     * Number of distinct backends currently registered. Used by tests and
     * by telemetry; not a routing primitive.
     */
    public size(): number {
        return this.modelsByBackend.size;
    }

    /**
     * Wipes every routing entry and every per-backend model list. Call on
     * user-initiated model reload so the next discovery pass starts from a
     * clean slate. Does NOT touch the per-model capability caches; call
     * `clearCaches()` for that.
     */
    public clear(): void {
        this.entries.clear();
        this.modelsByBackend.clear();
        this.discoveryResponseCache.clear();
    }

    /**
     * Wipes the per-model capability caches and the shared backoff
     * controller. Does NOT touch the routing table.
     */
    public clearCaches(): void {
        this.modelInfoCache.clear();
        this.derivedCapabilitiesCache.clear();
        this.unsupportedParamsByModel.clear();
        this.discoveryResponseCache.clear();
        sharedDiscoveryBackoff.reset();
    }

    /**
     * Records an auto-stripped parameter for a model so future requests can
     * proactively omit it. Only to be called when the transport detected a failed
     * request and removed the parameter before retrying.
     */
    public recordUnsupportedParameter(modelId: string, param: string): void {
        const trimmed = param.trim();
        if (!trimmed) {
            return;
        }
        const set = this.unsupportedParamsByModel.get(modelId) ?? new Set<string>();
        set.add(trimmed);
        this.unsupportedParamsByModel.set(modelId, set);
    }

    /**
     * Returns the set of dynamically-learned unsupported parameters for a model.
     */
    public getUnsupportedParameters(modelId: string): ReadonlySet<string> {
        return this.unsupportedParamsByModel.get(modelId) ?? new Set<string>();
    }

    public dispose(): void {
        this._debouncedOnDidChange?.dispose();
        this._onDidChangeEmitter.dispose();
    }

    // -------------------------------------------------------------------------
    // Internal write (NOT part of the public contract)
    // -------------------------------------------------------------------------

    /**
     * Records the full model list returned by a single backend's discovery
     * call. Updates both the id-keyed map (source of truth for response-time
     * routing) and the per-backend model-list view (source of truth for
     * change detection) atomically.
     *
     * INTERNAL: only `discoverInternal` calls this. Do not call from
     * outside the class.
     */
    private setModelsForBackend(
        baseUrl: string,
        apiKey: string,
        routingIdentity: string,
        models: LanguageModelChatInformation[]
    ): void {
        const sample = models.slice(0, 3).map((m) => m.id);
        Logger.trace(
            `LiteLLMProviderRegistry.setModelsForBackend: baseUrl="${baseUrl}" routingIdentity="${routingIdentity}" ` +
                `modelCount=${models.length} sampleIds=[${sample.join(", ")}] priorBackendCount=${this.modelsByBackend.size} priorEntryCount=${this.entries.size}`
        );
        this.modelsByBackend.set(baseUrl, models);
        for (const model of models) {
            this.entries.set(model.id, {
                baseUrl,
                apiKey,
                rawModelName: this.extractRawName(model.id),
                routingIdentity,
            });
        }
        Logger.trace(
            `LiteLLMProviderRegistry.setModelsForBackend: post-write backendCount=${this.modelsByBackend.size} entryCount=${this.entries.size}`
        );
    }

    private getModelsForBackend(baseUrl: string): LanguageModelChatInformation[] | undefined {
        return this.modelsByBackend.get(baseUrl);
    }

    private getModelIdsForBackend(baseUrl: string): Set<string> | undefined {
        const models = this.modelsByBackend.get(baseUrl);
        if (!models) {
            return undefined;
        }
        return new Set(models.map((m) => m.id));
    }

    // -------------------------------------------------------------------------
    // Discovery implementation
    // -------------------------------------------------------------------------

    private async discoverInternal(
        options: { silent?: boolean; configuration?: Record<string, unknown>; groupName?: string },
        token: vscode.CancellationToken
    ): Promise<DiscoveryOutcome> {
        try {
            if (!options.configuration) {
                // Vendor-level call: nothing to discover. Return an empty list
                // without firing `onDidChange`. Each per-group call is what
                // populates the picker.
                return { models: [], changed: false, routingIdentity: "" };
            }

            const configuredBaseUrl =
                typeof options.configuration.baseUrl === "string" ? options.configuration.baseUrl.trim() : "";
            const urlHostname = deriveGroupNameFromUrl(configuredBaseUrl).trim();
            const displayLabel = options.groupName ?? (urlHostname.length > 0 ? urlHostname : undefined) ?? "LiteLLM";

            const session = this.resolveBackendForCall(options.configuration, urlHostname || displayLabel);
            if (!session) {
                const baseUrlMissing =
                    typeof options.configuration.baseUrl !== "string" || options.configuration.baseUrl.trim() === "";
                const apiKeyMissing =
                    typeof options.configuration.apiKey !== "string" || options.configuration.apiKey.trim() === "";
                const reason = baseUrlMissing
                    ? "Server URL is empty"
                    : apiKeyMissing
                      ? "API key is empty"
                      : "Configuration is invalid or incomplete";
                Logger.warn(
                    `LiteLLMProviderRegistry.discoverModels: ${reason} — surfacing LanguageModelError to the picker`
                );
                throw vscode.LanguageModelError.Blocked(
                    `Cannot list models: ${reason}. ` +
                        `Open the LiteLLM provider settings and confirm both Server URL and API key are set.`
                );
            }
            this._onModernConfigurationDetected?.();

            const routingIdentity = (urlHostname.length > 0 ? urlHostname : displayLabel).replace(/\//g, "_");
            const models = await this.discoverFromSession(session, token, displayLabel, routingIdentity);
            Logger.trace(
                `LiteLLMProviderRegistry.discoverModels: fetched ${models.length} models for baseUrl="${session.baseUrl}"`
            );

            // Change detection: read the PRIOR id set for this baseUrl, compare
            // to the NEW one, then write. Writing first would make the
            // comparison read "now" against "now" and never fire.
            const baseUrl = session.baseUrl;
            const newIds = new Set(models.map((m) => m.id));
            const previousIds = this.getModelIdsForBackend(baseUrl);
            const changed = !previousIds || !setsEqual(previousIds, newIds);
            Logger.trace(
                `LiteLLMProviderRegistry.discoverModels: baseUrl="${baseUrl}" routingIdentity="${routingIdentity}" ` +
                    `modelCount=${models.length} sampleIds=[${[...newIds].slice(0, 3).join(", ")}] changed=${changed}`
            );
            if (session.apiKey) {
                this.setModelsForBackend(baseUrl, session.apiKey, routingIdentity, models);
            } else {
                Logger.trace(
                    `LiteLLMProviderRegistry.discoverModels: skipping registry write (no session/apiKey) baseUrl="${baseUrl}" modelCount=${models.length}`
                );
            }
            return { models, changed, session, routingIdentity };
        } catch (err) {
            // Actionable configuration errors (thrown above) must reach the
            // picker unchanged so the user can see the reason. Only network /
            // server-side failures get retried-with-backoff or converted to
            // a "Blocked" error after the failure threshold.
            if (err instanceof vscode.LanguageModelError) {
                throw err;
            }
            const decision = sharedDiscoveryBackoff.recordFailure(Date.now());
            if (decision.delayMs > 0) {
                await this.sleep(decision.delayMs, token);
            }
            if (decision.shouldBlock) {
                throw vscode.LanguageModelError.Blocked(
                    `Discovery blocked after ${decision.attempt} consecutive failures. ` +
                        `The LiteLLM endpoint appears to be unhealthy. ` +
                        `Please check your configuration and retry later.`
                );
            }
            return { models: [], changed: false, routingIdentity: "" };
        }
    }

    /**
     * Resolves the active backend session for a request by honoring the
     * per-group configuration passed on the call.
     */
    private resolveBackendForCall(
        configuration: Record<string, unknown> | undefined,
        groupName?: string
    ): BackendSession | undefined {
        if (!configuration) {
            return undefined;
        }
        Logger.trace(`LiteLLMProviderRegistry.resolveBackendForCall: groupName="${groupName ?? ""}"`);
        return this.configManager.convertProviderConfiguration(groupName ?? "", configuration);
    }

    private async discoverFromSession(
        session: BackendSession,
        token: vscode.CancellationToken,
        displayLabel: string,
        routingIdentity: string
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const config = await this.configManager.getConfig();
        const ttlMs = config.discoveryCacheTtlMs ?? 60_000;

        // Check cache first
        const cacheKey = await toDiscoveryCacheKey(session.baseUrl, session.apiKey);
        if (ttlMs > 0) {
            const cached = this.discoveryResponseCache.get(cacheKey);
            if (cached && Date.now() - cached.fetchedAtMs < ttlMs) {
                StructuredLogger.debug("discovery.cache_hit", {
                    baseUrl: session.baseUrl,
                    ageMs: Date.now() - cached.fetchedAtMs,
                    ttlMs,
                    modelCount: cached.models.length,
                    bodyHash: cached.bodyHash.slice(0, 8),
                });
                return [...cached.models];
            }
            StructuredLogger.debug("discovery.cache_miss", {
                baseUrl: session.baseUrl,
                reason: !cached ? "missing" : "expired",
            });
        }

        // Fetch fresh data
        StructuredLogger.trace("discovery.request_start", {
            baseUrl: session.baseUrl,
            url: "/model/info",
            timeoutMs: config.discoveryTimeoutMs ?? 5_000,
        });
        const startTime = Date.now();
        const models = await session.client.getModelInfo(token);
        const durationMs = Date.now() - startTime;
        StructuredLogger.debug("discovery.request_success", {
            baseUrl: session.baseUrl,
            durationMs,
            modelCount: models.data?.length ?? 0,
        });
        if (!models?.data?.length) {
            return [];
        }

        const infos = models.data
            .map((entry) =>
                this.toVSCodeInfo(
                    entry,
                    session.backendName,
                    { url: session.baseUrl, apiKey: session.apiKey },
                    displayLabel,
                    routingIdentity,
                    config.forceResponsesEndpoint,
                    config.modelCapabilitiesOverrides,
                    config.displayPricingInPicker !== false
                )
            )
            .filter((info) => info.isUserSelectable !== false);

        // Cache the response if TTL > 0
        if (ttlMs > 0) {
            // Create a deterministic hash of the response body
            const bodyHash = await sha256HexAsync(JSON.stringify(models.data ?? []));
            this.discoveryResponseCache.set(cacheKey, {
                bodyHash,
                models: infos,
                fetchedAtMs: Date.now(),
                ttlMs,
            });
            StructuredLogger.debug("discovery.cached", {
                baseUrl: session.baseUrl,
                bodyHash: bodyHash.slice(0, 8),
                modelCount: infos.length,
                ttlMs,
            });
        }

        return infos;
    }

    private toVSCodeInfo(
        entry: LiteLLMModelInfoResponse["data"][number],
        backendName: string,
        backend: { url?: string; apiKey?: string } | undefined,
        displayLabel: string,
        routingIdentity: string,
        forceResponsesEndpoint?: boolean,
        modelCapabilitiesOverrides?: LiteLLMConfig["modelCapabilitiesOverrides"],
        displayPricingInPicker = true
    ): vscode.LanguageModelChatInformation {
        if (!entry.model_name) {
            Logger.warn(
                `Skipping model entry without model_name from backend "${backendName}". Entry keys: ${Object.keys(
                    entry
                ).join(",")}`
            );
            return {
                id: "unknown",
                name: "unknown",
                vendor: entry.model_info?.litellm_provider ?? "litellm",
                family: entry.model_info?.litellm_provider ?? "litellm",
                version: "1.0",
                maxInputTokens: 0,
                maxOutputTokens: 0,
                capabilities: { canGenerate: false },
                isUserSelectable: false,
                category: displayLabel,
                configurationSchema: undefined,
            } as unknown as vscode.LanguageModelChatInformation & { isUserSelectable: boolean };
        }

        const modelName = entry.model_name;
        // The id is the namespaced form `<routingIdentity>/<rawModelName>` so
        // the response path can recover both pieces by splitting on the first
        // `/`. Two backends on different hostnames can advertise the same raw
        // model name (e.g. `azure_ai/gpt-5.4-mini`) — the routing identity
        // disambiguates them. The `name` shown to the user in the model
        // picker stays as the raw model_name (no namespace leak).
        const modelId = routingIdentity.length > 0 ? `${routingIdentity}/${modelName}` : modelName;
        let modelInfo = entry.model_info;
        if (forceResponsesEndpoint && modelInfo?.mode === "chat") {
            modelInfo = { ...modelInfo, mode: "responses" as const };
        }

        this.modelInfoCache.set(modelId, modelInfo);
        const derived = deriveCapabilitiesFromModelInfo(modelId, modelInfo);
        this.derivedCapabilitiesCache.set(modelId, derived);

        const capabilityOverrides = modelCapabilitiesOverrides?.[modelId] ?? modelCapabilitiesOverrides?.[modelName];
        const capabilities = capabilitiesToVSCode(derived, capabilityOverrides);
        const tags = getDerivedModelTags(modelId, derived, {}, capabilityOverrides);
        const supportedEfforts = getSupportedReasoningEfforts(modelInfo, modelId);
        const reasoningSchema = buildReasoningEffortConfigurationSchema(supportedEfforts, modelId, modelInfo);

        const cacheIndicator = modelInfo?.supports_prompt_caching ? "⚡ " : "";
        const detailBase = backendName ?? "LiteLLM";

        // Pricing is optional and only shown when displayPricingInPicker is enabled.
        const pricing = displayPricingInPicker ? extractPricing(modelInfo) : undefined;
        const pricingDetail = formatPricingForDetail(pricing);
        const detail = pricingDetail
            ? `${cacheIndicator + detailBase} • ${pricingDetail}`
            : cacheIndicator + detailBase;

        // Default category remains derived picker category (string) for safety.
        const category = derivePickerCategory(derived);

        const toNumberPerMillion = (value?: number): number | undefined =>
            value !== undefined ? value * 1_000_000 : undefined;

        const info: vscode.LanguageModelChatInformation & {
            vendor?: string;
            backendName?: string;
            tags?: string[];
            detail?: string;
            tooltip?: string;
            pricing?: string;
            inputCost?: number;
            outputCost?: number;
            cacheCost?: number;
            cacheWriteCost?: number;
            longContextInputCost?: number;
            longContextOutputCost?: number;
            longContextCacheCost?: number;
            longContextCacheWriteCost?: number;
            priceCategory?: string;
        } = {
            id: modelId,
            name: modelName,
            vendor: modelInfo?.litellm_provider ?? "litellm",
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
            // The picker reads this field via `getCategoryLabel(category)` and
            // crashes with `TypeError: a.charAt is not a function` when the
            // value is not a string. The picker recognizes the three literals
            // `lightweight` | `versatile` | `powerful` and handles `undefined`
            // (omit tag). We MUST return one of those or `undefined` — never a
            // grouping object, never `null`. See `.investigate/vscode-picker-charAt-bug.md`.
            //
            // Note on grouping: the picker does NOT read `category` for
            // per-backend sectioning. Per the upstream
            // `ModelPickerWidget.buildModelPickerItems()`, grouping is driven
            // by `(vendor, groupName)` resolved through the workbench
            // `ILanguageModelsService.getLanguageModelGroups()` lookup — not
            // by anything we return in `category`. Returning a string here
            // therefore does NOT regress per-backend picker sectioning; it
            // only stops the crash on `getCategoryLabel`.
            category,
            configurationSchema: reasoningSchema,
        } as unknown as vscode.LanguageModelChatInformation;

        // Populate pricing fields only when enabled and data is present.
        // These fields are per 1M tokens per VS Code proposed API.
        if (pricing) {
            const inputCost = toNumberPerMillion(pricing.inputCostPerToken);
            const outputCost = toNumberPerMillion(pricing.outputCostPerToken);
            const cacheCost = toNumberPerMillion(pricing.cacheReadCostPerToken);
            const cacheWriteCost = toNumberPerMillion(pricing.cacheCreationCostPerToken);

            // Normalize floating artifacts so tests expecting rounded values don't fail
            const round = (value?: number): number | undefined =>
                value !== undefined ? Number.parseFloat(value.toFixed(2)) : undefined;

            (info as { pricing?: string }).pricing = formatPricingForDetail(pricing);
            (info as { inputCost?: number }).inputCost = round(inputCost);
            (info as { outputCost?: number }).outputCost = round(outputCost);
            (info as { cacheCost?: number }).cacheCost = round(cacheCost);
            (info as { cacheWriteCost?: number }).cacheWriteCost = round(cacheWriteCost);
            (info as { priceCategory?: string }).priceCategory = derivePriceCategory(pricing);

            // Tooltip: append pricing breakdown
            const pricingTooltip = formatPricingForTooltip(pricing);
            if (pricingTooltip) {
                (info as { tooltip?: string }).tooltip = `${info.tooltip}\n${pricingTooltip}`;
            }
        }

        return info;
    }

    private sleep(ms: number, _token?: vscode.CancellationToken): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

let sharedRegistry: LiteLLMProviderRegistry | undefined;

export function getOrCreateBackendRegistry(deps: RegistryDeps): LiteLLMProviderRegistry {
    if (!sharedRegistry) {
        sharedRegistry = new LiteLLMProviderRegistry(deps);
        return sharedRegistry;
    }

    return sharedRegistry;
}

/**
 * Test-only helper to reset the singleton instance. Do not call in production
 * paths.
 */
export function resetBackendRegistry(): void {
    sharedRegistry?.dispose();
    sharedRegistry = undefined;
}
