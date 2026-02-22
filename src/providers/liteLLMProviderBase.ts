import * as vscode from "vscode";
import type {
    LanguageModelChatInformation,
    LanguageModelChatRequestMessage,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";

import type { LiteLLMModelInfo, OpenAIChatCompletionRequest, OpenAIFunctionToolDef } from "../types";
import { convertMessages, convertTools, validateRequest } from "../utils";
import { LiteLLMClient } from "../adapters/litellmClient";
import { ResponsesClient } from "../adapters/responsesClient";
import { transformToResponsesFormat } from "../adapters/responsesAdapter";
import { countTokens, trimMessagesToFitBudget } from "../adapters/tokenUtils";
import { ConfigManager } from "../config/configManager";
import { Logger } from "../utils/logger";
import { LiteLLMTelemetry } from "../utils/telemetry";
import {
    deriveCapabilitiesFromModelInfo,
    capabilitiesToVSCode,
    getModelTags as getDerivedModelTags,
} from "../utils/modelCapabilities";
import type { DerivedModelCapabilities } from "../utils/modelCapabilities";

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
    "o1-preview": new Set(["temperature", "top_p", "presence_penalty", "frequency_penalty"]),
    "o1-mini": new Set(["temperature", "top_p", "presence_penalty", "frequency_penalty"]),
    "o1-": new Set(["temperature", "top_p", "presence_penalty", "frequency_penalty"]),
};

/**
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
    protected readonly _modelInfoCache = new Map<string, LiteLLMModelInfo | undefined>();
    protected readonly _derivedCapabilitiesCache = new Map<string, DerivedModelCapabilities>();
    protected readonly _parameterProbeCache = new Map<string, Set<string>>();
    protected _lastModelList: LanguageModelChatInformation[] = [];
    protected _modelListFetchedAtMs = 0;

    constructor(
        protected readonly secrets: vscode.SecretStorage,
        protected readonly userAgent: string
    ) {
        this._configManager = new ConfigManager(secrets);
    }

    /** Clears all model-related caches (model list, model info, parameter probe). */
    public clearModelCache(): void {
        Logger.info("Clearing model discovery cache");
        this._modelInfoCache.clear();
        this._derivedCapabilitiesCache.clear();
        this._parameterProbeCache.clear();
        this._lastModelList = [];
        this._modelListFetchedAtMs = 0;
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
        _options: { silent: boolean },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        Logger.debug("discoverModels called");
        try {
            const config = await this._configManager.getConfig();
            Logger.debug(`Config URL: ${config.url ? "set" : "not set"}`);
            if (!config.url) {
                Logger.info("No base URL configured, returning empty model list.");
                return [];
            }

            const client = new LiteLLMClient(config, this.userAgent);
            Logger.debug("Fetching model info from LiteLLM...");
            const { data } = await client.getModelInfo(token);

            if (!data || !Array.isArray(data)) {
                Logger.warn("Received invalid data format from /model/info", data);
                return [];
            }

            Logger.info(`Found ${data.length} models`);
            const infos: LanguageModelChatInformation[] = data.map(
                (entry: { model_info?: LiteLLMModelInfo; model_name?: string }, index: number) => {
                    const modelId = entry.model_info?.key ?? entry.model_name ?? `model-${index}`;
                    const modelInfo = entry.model_info;
                    this._modelInfoCache.set(modelId, modelInfo);

                    const derived = deriveCapabilitiesFromModelInfo(modelId, modelInfo);
                    this._derivedCapabilitiesCache.set(modelId, derived);

                    const capabilities = capabilitiesToVSCode(derived);
                    const tags = getDerivedModelTags(modelId, derived, config.modelOverrides);

                    // const formatTokens = (num: number): string => {
                    //     if (num >= 1000000) {
                    //         return `${(num / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
                    //     }
                    //     if (num >= 1000) {
                    //         return `${Math.floor(num / 1000)}K`;
                    //     }
                    //     return num.toString();
                    // };

                    const inputDesc = derived.rawContextWindow;
                    const outputDesc = derived.maxOutputTokens;
                    const tooltip = `${modelInfo?.litellm_provider ?? "LiteLLM"} (${modelInfo?.mode ?? "responses"}) — Context: ${inputDesc} in / ${outputDesc} out`;

                    return {
                        id: modelId,
                        name: entry.model_name ?? modelId,
                        tooltip,
                        detail: `↑ ${inputDesc}   ↓ ${outputDesc}`,
                        family: "litellm",
                        version: "1.0.0",
                        maxInputTokens: derived.maxInputTokens,
                        maxOutputTokens: derived.maxOutputTokens,
                        capabilities,
                        tags,
                    } as LanguageModelChatInformation;
                }
            );

            this._lastModelList = infos;
            this._modelListFetchedAtMs = Date.now();
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
        _token: vscode.CancellationToken
    ): Promise<number> {
        const modelInfo = this._modelInfoCache.get(model.id);
        const count = countTokens(text, model.id, modelInfo);
        // Logger.debug(`provideTokenCount called for model ${model.id}: ${count} tokens`);
        return count;
    }

    /**
     * Determines the tags for a model based on its info and user overrides.
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
            modelInfo?.supported_openai_params?.includes("tools") ||
            modelInfo?.supported_openai_params?.includes("tool_choice")
        ) {
            tags.add("tools");
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

        // ProvideLanguageModelChatResponseOptions doesn't include provider configuration.
        // Some call sites pass an intersection type that includes it.
        const optionsWithConfig = options as ProvideLanguageModelChatResponseOptions & {
            configuration?: Record<string, unknown>;
        };

        const config = optionsWithConfig.configuration
            ? this._configManager.convertProviderConfiguration(optionsWithConfig.configuration)
            : await this._configManager.getConfig();

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

        const requestBody: OpenAIChatCompletionRequest = {
            model: model.id,
            messages: openaiMessages,
            stream: true,
            max_tokens:
                typeof options.modelOptions?.max_tokens === "number"
                    ? Math.min(options.modelOptions.max_tokens, model.maxOutputTokens)
                    : model.maxOutputTokens,
        };

        if (this.isParameterSupported("temperature", modelInfo, model.id)) {
            requestBody.temperature = (options.modelOptions?.temperature as number) ?? 0.7;
        }
        if (this.isParameterSupported("frequency_penalty", modelInfo, model.id)) {
            requestBody.frequency_penalty = (options.modelOptions?.frequency_penalty as number) ?? 0.2;
        }
        if (this.isParameterSupported("presence_penalty", modelInfo, model.id)) {
            requestBody.presence_penalty = (options.modelOptions?.presence_penalty as number) ?? 0.1;
        }

        if (options.modelOptions) {
            const mo = options.modelOptions as Record<string, unknown>;
            if (this.isParameterSupported("stop", modelInfo, model.id) && mo.stop) {
                requestBody.stop = mo.stop as string | string[];
            }
            if (this.isParameterSupported("top_p", modelInfo, model.id) && typeof mo.top_p === "number") {
                requestBody.top_p = mo.top_p;
            }
            if (
                this.isParameterSupported("frequency_penalty", modelInfo, model.id) &&
                typeof mo.frequency_penalty === "number"
            ) {
                requestBody.frequency_penalty = mo.frequency_penalty;
            }
            if (
                this.isParameterSupported("presence_penalty", modelInfo, model.id) &&
                typeof mo.presence_penalty === "number"
            ) {
                requestBody.presence_penalty = mo.presence_penalty;
            }
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

    /** Sends a request to LiteLLM, with /responses fallback when applicable. */
    protected async sendRequestToLiteLLM(
        request: OpenAIChatCompletionRequest,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        modelInfo?: LiteLLMModelInfo
    ): Promise<ReadableStream<Uint8Array>> {
        const config = await this._configManager.getConfig();
        if (!config.url) {
            throw new Error("LiteLLM configuration not found. Please configure the LiteLLM base URL.");
        }

        const client = new LiteLLMClient(config, this.userAgent);

        if (modelInfo?.mode === "responses") {
            try {
                const responsesClient = new ResponsesClient(config, this.userAgent);
                const responsesRequest = transformToResponsesFormat(request);
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
            } catch (err) {
                Logger.warn(`/responses failed, falling back to /chat/completions: ${err}`);
            }
        }

        return client.chat(request, modelInfo?.mode, token, modelInfo);
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
