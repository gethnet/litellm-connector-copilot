import type { LiteLLMModelCard, ModelFeatureCapabilities } from "../types/modelCard";
import { Logger } from "../utils/logger";
import modelCardDefaults from "../config/modelCardDefaults.json";

/**
 * Fetches and caches model card data from LiteLLM proxy.
 * Provides fallback to JSON defaults when the endpoint is unavailable.
 */
export class ModelCardClient {
    private readonly cache = new Map<string, { data: ModelFeatureCapabilities; expiresAt: number }>();
    private readonly CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes

    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string,
        private readonly userAgent: string
    ) {
        if (!baseUrl) {
            throw new Error("ModelCardClient requires a baseUrl");
        }
    }

    /**
     * Get model features, fetching from LiteLLM if not cached.
     */
    async getModelFeatures(modelName: string): Promise<ModelFeatureCapabilities> {
        // First check cache
        const cached = this.cache.get(modelName);
        if (cached && cached.expiresAt > Date.now()) {
            Logger.trace(`[ModelCardClient] Cache hit for model: ${modelName}`);
            return cached.data;
        }

        // Try to fetch from LiteLLM
        try {
            const card = await this.fetchModelCard(modelName);
            const features = this.mapToFeatureCapabilities(card);

            this.cache.set(modelName, {
                data: features,
                expiresAt: Date.now() + this.CACHE_TTL_MS,
            });

            Logger.debug(`[ModelCardClient] Fetched and cached model card for: ${modelName}`);
            return features;
        } catch (error) {
            Logger.warn(`[ModelCardClient] Failed to fetch model card for ${modelName}, using fallback`, error);
            return this.getFallbackCapabilities(modelName);
        }
    }

    /**
     * Fetch model card from LiteLLM /model/{model_name} endpoint.
     */
    private async fetchModelCard(modelName: string): Promise<LiteLLMModelCard> {
        const url = `${this.baseUrl.replace(/\/$/, "")}/model/${encodeURIComponent(modelName)}`;
        const headers: Record<string, string> = {
            "User-Agent": this.userAgent,
        };

        // Add authorization header if API key is provided
        if (this.apiKey) {
            headers["Authorization"] = `Bearer ${this.apiKey}`;
        }

        const response = await fetch(url, {
            method: "GET",
            headers,
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch model card: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return data as LiteLLMModelCard;
    }

    /**
     * Map LiteLLM model card to internal feature capabilities.
     */
    private mapToFeatureCapabilities(card: LiteLLMModelCard): ModelFeatureCapabilities {
        const info = card.model_info;
        return {
            supportedParams: new Set(info.supported_openai_params ?? []),
            supportsSystemMessages: info.supports_system_messages ?? true,
            supportsVision: info.supports_vision ?? false,
            supportsTools: info.supports_function_calling ?? false,
            supportsReasoning: info.supports_reasoning ?? false,
            supportsPromptCaching: info.supports_prompt_caching ?? false,
            supportsNativeStreaming: info.supports_native_streaming ?? true,
            supportsResponseSchema: info.supports_response_schema ?? false,
            maxInputTokens: info.max_input_tokens ?? card.max_input_tokens ?? 128000,
            maxOutputTokens: info.max_output_tokens ?? card.max_tokens ?? 16000,
            supportedReasoningEfforts: this.parseReasoningEfforts(info),
        };
    }

    /**
     * Parse reasoning effort levels from model info.
     */
    private parseReasoningEfforts(
        info: Record<string, unknown>
    ): ModelFeatureCapabilities["supportedReasoningEfforts"] {
        const efforts: ("minimal" | "low" | "high")[] = [];

        if (info.supports_minimal_reasoning_effort === true) {
            efforts.push("minimal");
        }
        if (info.supports_low_reasoning_effort === true || info.supports_xlow_reasoning_effort === true) {
            efforts.push("low");
        }
        if (info.supports_high_reasoning_effort === true || info.supports_xhigh_reasoning_effort === true) {
            efforts.push("high");
        }

        return efforts.length > 0 ? efforts : undefined;
    }

    /**
     * Get fallback capabilities from JSON defaults or use safe defaults.
     */
    private getFallbackCapabilities(modelName: string): ModelFeatureCapabilities {
        // Try to find model in fallback JSON
        const normalizedName = modelName.toLowerCase();
        const defaults = modelCardDefaults as Record<string, ModelFeatureCapabilitiesDefaults>;

        // Check for exact match or prefix match (e.g., "gpt-5.1-codex-max" or "gpt-5.1-codex")
        let fallback = defaults[normalizedName];
        if (!fallback) {
            // Try prefix match
            const matchingKey = Object.keys(defaults).find((key) => normalizedName.startsWith(key));
            if (matchingKey) {
                fallback = defaults[matchingKey];
            }
        }

        if (fallback) {
            Logger.debug(`[ModelCardClient] Using fallback capabilities for: ${modelName}`);
            return {
                supportedParams: new Set(fallback.supportedParams),
                supportsSystemMessages: fallback.supportsSystemMessages,
                supportsVision: fallback.supportsVision,
                supportsTools: fallback.supportsTools,
                supportsReasoning: fallback.supportsReasoning,
                supportsPromptCaching: fallback.supportsPromptCaching,
                supportsNativeStreaming: fallback.supportsNativeStreaming,
                supportsResponseSchema: fallback.supportsResponseSchema,
                maxInputTokens: fallback.maxInputTokens,
                maxOutputTokens: fallback.maxOutputTokens,
                supportedReasoningEfforts: fallback.supportedReasoningEfforts,
            };
        }

        // Return safe defaults - minimal features, forcing conservative parameter sending
        Logger.debug(`[ModelCardClient] Using safe defaults for unknown model: ${modelName}`);
        return DEFAULT_MODEL_CAPABILITIES;
    }

    /** Clear cache (e.g., on window reload) */
    clearCache(): void {
        this.cache.clear();
        Logger.debug("[ModelCardClient] Cache cleared");
    }

    /** Check if a model is in cache */
    isCached(modelName: string): boolean {
        const cached = this.cache.get(modelName);
        return cached !== undefined && cached.expiresAt > Date.now();
    }
}

/**
 * Type for JSON fallback defaults (without Set type, since JSON can't contain Sets)
 */
interface ModelFeatureCapabilitiesDefaults {
    supportedParams: string[];
    supportsSystemMessages: boolean;
    supportsVision: boolean;
    supportsTools: boolean;
    supportsReasoning: boolean;
    supportsPromptCaching: boolean;
    supportsNativeStreaming: boolean;
    supportsResponseSchema: boolean;
    maxInputTokens: number;
    maxOutputTokens: number;
    supportedReasoningEfforts?: ("minimal" | "low" | "high")[];
}

/**
 * Default model capabilities used when no other info is available.
 * Conservative defaults = minimal features, forcing conservative parameter sending.
 */
const DEFAULT_MODEL_CAPABILITIES: ModelFeatureCapabilities = {
    supportedParams: new Set(["max_tokens", "temperature"]), // Conservative
    supportsSystemMessages: true,
    supportsVision: false,
    supportsTools: false,
    supportsReasoning: false,
    supportsPromptCaching: false,
    supportsNativeStreaming: true,
    supportsResponseSchema: false,
    maxInputTokens: 128000,
    maxOutputTokens: 16000,
};
