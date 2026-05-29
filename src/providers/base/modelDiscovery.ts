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
import type { LiteLLMModelInfo, LiteLLMModelInfoResponse } from "../../types";
import type { BackendSession } from "../backendSession";
import type { DiscoverArgs, DiscoveryDeps } from "./types";

const TTL_MS = 30_000;

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
        const entry = this.lastModelList.find((m) => m.id === modelId) as
            | (vscode.LanguageModelChatInformation & {
                  _backendName?: string;
                  _backendUrl?: string;
                  _apiKey?: string;
              })
            | undefined;
        if (!entry?._backendName || !entry._backendUrl) {
            return undefined;
        }
        return {
            backendName: entry._backendName,
            url: entry._backendUrl,
            apiKey: entry._apiKey,
        };
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
        if (cached.length !== fresh.length) return true;
        for (let i = 0; i < cached.length; i++) {
            const cachedModel = cached[i] as vscode.LanguageModelChatInformation & { _backendName?: string };
            const freshModel = fresh[i] as vscode.LanguageModelChatInformation & { _backendName?: string };
            if (cachedModel.id !== freshModel.id) return true;
            if (cachedModel.name !== freshModel.name) return true;
            if ((cachedModel as { vendor?: unknown }).vendor !== (freshModel as { vendor?: unknown }).vendor)
                return true;
            if (cachedModel.isUserSelectable !== freshModel.isUserSelectable) return true;
            if (
                JSON.stringify((cachedModel as { category?: unknown }).category) !==
                JSON.stringify((freshModel as { category?: unknown }).category)
            )
                return true;
            if (JSON.stringify(cachedModel.configurationSchema) !== JSON.stringify(freshModel.configurationSchema))
                return true;
        }
        return false;
    }

    public async discover(args: DiscoverArgs): Promise<vscode.LanguageModelChatInformation[]> {
        const { options, token } = args;
        if (this.inFlightDiscovery) {
            return this.inFlightDiscovery;
        }

        const now = Date.now();
        if (options.configuration) {
            const key = this.getConfigCacheKey(options.configuration);
            const cached = this.perConfigCache.get(key);
            if (cached && options.silent && now - cached.fetchedAtMs < TTL_MS) {
                return cached.models;
            }
        } else if (options.silent && this.lastModelList.length > 0 && now - this.modelListFetchedAtMs < TTL_MS) {
            return this.lastModelList;
        }

        this.inFlightDiscovery = this.doDiscover(options, token);
        const result = await this.inFlightDiscovery;
        this.inFlightDiscovery = undefined;
        return result;
    }

    private async doDiscover(
        options: { silent?: boolean; configuration?: Record<string, unknown>; groupName?: string },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        try {
            if (options.configuration) {
                const groupName =
                    options.groupName ??
                    (typeof options.configuration.providerName === "string"
                        ? options.configuration.providerName
                        : "default");
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
        const infos = models.data.map((entry) =>
            this.toVSCodeInfo(entry, backendByName.get(entry.backendName), config.forceResponsesEndpoint)
        );

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

        const infos = models.data.map((entry) =>
            this.toVSCodeInfo(
                entry,
                { name: session.backendName, url: session.baseUrl, apiKey: session.apiKey },
                config.forceResponsesEndpoint
            )
        );

        this.multiBackendClient = new MultiBackendClient(
            [{ name: session.backendName, url: session.baseUrl, apiKey: session.apiKey, enabled: true }],
            this.userAgent
        );
        this.activeBackendNames = [session.backendName];
        this.lastModelList = infos;
        this.modelListFetchedAtMs = Date.now();
        return infos;
    }

    private toVSCodeInfo(
        entry: LiteLLMModelInfoResponse["data"][number],
        backend: { name?: string; url?: string; apiKey?: string } | undefined,
        forceResponsesEndpoint?: boolean
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
        const backendName = (entry as any).backendName ?? backend?.name ?? "LiteLLM";
        const modelName = entry.model_name ?? `${backendName}/unknown`;
        const namespacedId = (entry as any).namespacedId ?? `${backendName}/${modelName}`;
        let modelInfo = entry.model_info;
        if (forceResponsesEndpoint && modelInfo?.mode === "chat") {
            modelInfo = { ...modelInfo, mode: "responses" as const };
        }

        this.modelInfoCache.set(namespacedId, modelInfo);
        const derived = deriveCapabilitiesFromModelInfo(namespacedId, modelInfo);
        this.derivedCapabilitiesCache.set(namespacedId, derived);

        const capabilities = capabilitiesToVSCode(derived, undefined);
        const tags = getDerivedModelTags(namespacedId, derived, {}, undefined);
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
}
