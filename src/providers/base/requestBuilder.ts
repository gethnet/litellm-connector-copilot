import type * as vscode from "vscode";
import {
    convertMessages,
    convertTools,
    validateRequest,
    validateV2Messages,
    convertV2MessagesToOpenAI,
} from "../../utils";
import { trimMessagesToFitBudget, trimV2MessagesForBudget } from "../../adapters/tokenUtils";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest, OpenAIFunctionToolDef } from "../../types";
import type { RequestBuilderDeps } from "./types";
import type { V2ChatMessage } from "../v2Types";
import { resolveChatReasoningTransport } from "./reasoningTransport";
import { applyPromptCachePolicy, modelSupportsPromptCacheControl } from "../../utils/promptCacheControl";
import type { PromptCachePolicySummary } from "../../utils/promptCacheControl";

export class RequestBuilder {
    private readonly configManager: RequestBuilderDeps["configManager"];
    private readonly getReasoningEffort: RequestBuilderDeps["getReasoningEffort"];
    private readonly detectQuotaToolRedaction: RequestBuilderDeps["detectQuotaToolRedaction"];
    private readonly stripUnsupportedParametersFromRequest: RequestBuilderDeps["stripUnsupportedParametersFromRequest"];
    private readonly isParameterSupported: RequestBuilderDeps["isParameterSupported"];
    private readonly getTelemetryOptions: RequestBuilderDeps["getTelemetryOptions"];
    private readonly usageOptOutModels: RequestBuilderDeps["usageOptOutModels"];
    private readonly extractRawModelName: RequestBuilderDeps["extractRawModelName"];

    constructor(deps: RequestBuilderDeps) {
        this.configManager = deps.configManager;
        this.getReasoningEffort = deps.getReasoningEffort;
        this.detectQuotaToolRedaction = deps.detectQuotaToolRedaction;
        this.stripUnsupportedParametersFromRequest = deps.stripUnsupportedParametersFromRequest;
        this.isParameterSupported = deps.isParameterSupported;
        this.getTelemetryOptions = deps.getTelemetryOptions;
        this.usageOptOutModels = deps.usageOptOutModels;
        this.extractRawModelName = deps.extractRawModelName;
    }

    private addCacheBypassIfEnabled(requestBody: OpenAIChatCompletionRequest, disableCaching: boolean): void {
        if (!disableCaching) {
            return;
        }

        requestBody.extra_body = {
            ...requestBody.extra_body,
            cache: {
                ...(requestBody.extra_body?.cache ?? {}),
                "no-cache": true,
            },
        };
    }

    /**
     * Applies the shared finalization tail every chat request body needs,
     * regardless of which message pipeline produced it.
     *
     * Order is load-bearing and must not be rearranged:
     *
     * 1. LiteLLM response-cache bypass goes on first so the parameter strip can
     *    remove `cache` for backends that reject it.
     * 2. Unsupported parameters are stripped against the model card.
     * 3. Anthropic prompt caching is applied *after* the strip, because the
     *    strip only knows the card's advertised parameters and would otherwise
     *    drop a `cache_control` field it does not recognize.
     *
     * Returns the sanitized policy summary so callers can log the decision
     * without re-deriving it.
     */
    private finalizeRequestBody(
        requestBody: OpenAIChatCompletionRequest,
        rawModelId: string,
        disableCaching: boolean,
        modelInfo?: LiteLLMModelInfo
    ): PromptCachePolicySummary {
        this.addCacheBypassIfEnabled(requestBody, disableCaching);
        this.stripUnsupportedParametersFromRequest(
            requestBody as unknown as Record<string, unknown>,
            modelInfo,
            rawModelId
        );

        const promptCachePolicy = applyPromptCachePolicy(requestBody.messages, rawModelId, modelInfo);
        if (promptCachePolicy.path1) {
            requestBody.cache_control = { type: "ephemeral" };
        }
        return promptCachePolicy;
    }

    public async buildOpenAIChatRequest(
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        model: vscode.LanguageModelChatInformation,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        modelInfo?: LiteLLMModelInfo,
        _caller?: string
    ): Promise<OpenAIChatCompletionRequest> {
        const config = await this.configManager.getConfig();

        // `model.id` is the namespaced `<routing>/<raw>` form VS Code hands
        // us at response time. The LiteLLM request body, the capability
        // lookup, the parameter-supported probes, and the usage-opt-out
        // set all need the RAW model name (the part after the first `/`).
        const rawModelId = this.extractRawModelName(model.id);

        const toolRedaction = this.detectQuotaToolRedaction(
            messages,
            options.tools ?? [],
            `build-${Math.random().toString(36).slice(2, 10)}`,
            rawModelId,
            config.disableQuotaToolRedaction === true,
            _caller
        );
        // `confidence` is intentionally not threaded into the request body
        // today. It is consumed by the base for logging/telemetry already;
        // this call site only needs the (possibly redacted) tool list.
        const toolConfig = convertTools({ ...options, tools: toolRedaction.tools });
        const messagesToUse = trimMessagesToFitBudget(messages, toolConfig.tools, model, modelInfo);
        const openaiMessages = convertMessages(messagesToUse, {
            attachPromptCacheControl: modelSupportsPromptCacheControl(rawModelId, modelInfo),
        });
        validateRequest(messagesToUse);

        const reasoningEffort = this.getReasoningEffort(options, model, modelInfo);
        const reasoningTransport = resolveChatReasoningTransport(
            reasoningEffort,
            rawModelId,
            modelInfo,
            this.isParameterSupported
        );
        const mo = (options.modelOptions as Record<string, unknown>) ?? {};

        const requestBody: OpenAIChatCompletionRequest = {
            model: rawModelId,
            messages: openaiMessages,
            stream: true,
            max_tokens:
                typeof mo.max_tokens === "number"
                    ? Math.min(mo.max_tokens, model.maxOutputTokens)
                    : model.maxOutputTokens,
            ...reasoningTransport,
        };

        if (!this.usageOptOutModels.has(rawModelId)) {
            requestBody.stream_options = { include_usage: true } as { include_usage?: boolean };
        }

        if (this.isParameterSupported("temperature", modelInfo, rawModelId)) {
            const temp = mo.temperature as number | undefined;
            requestBody.temperature = temp;
        }
        if (this.isParameterSupported("frequency_penalty", modelInfo, rawModelId)) {
            const fp = mo.frequency_penalty as number | undefined;
            requestBody.frequency_penalty = fp;
        }
        if (this.isParameterSupported("presence_penalty", modelInfo, rawModelId)) {
            const pp = mo.presence_penalty as number | undefined;
            requestBody.presence_penalty = pp;
        }
        if (this.isParameterSupported("stop", modelInfo, rawModelId) && mo.stop) {
            requestBody.stop = mo.stop as string | string[];
        }
        if (this.isParameterSupported("top_p", modelInfo, rawModelId) && typeof mo.top_p === "number") {
            requestBody.top_p = mo.top_p;
        }

        if (toolConfig.tools) {
            requestBody.tools = toolConfig.tools as unknown as OpenAIFunctionToolDef[];
        }

        // Only include tool_choice when:
        // 1. Model supports tool_choice (per isParameterSupported), AND
        // 2. Tools are present, AND
        //    a. Explicitly required by toolMode (toolConfig.tool_choice is set), OR
        //    b. Model supports it - default to "auto" for backward compatibility
        if (toolConfig.tools && toolConfig.tools.length > 0) {
            if (this.isParameterSupported("tool_choice", modelInfo, rawModelId)) {
                if (toolConfig.tool_choice) {
                    // Explicitly required tool (toolMode === Required)
                    requestBody.tool_choice = toolConfig.tool_choice;
                } else {
                    // Model supports tool_choice, tools present, but no explicit required mode
                    // Default to "auto" for backward compatibility
                    requestBody.tool_choice = "auto";
                }
            }
            // If model doesn't support tool_choice, omit it entirely
        }

        this.finalizeRequestBody(requestBody, rawModelId, config.disableCaching === true, modelInfo);
        return requestBody;
    }

    public async buildV2ChatRequest(
        messages: readonly V2ChatMessage[],
        model: vscode.LanguageModelChatInformation,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        modelInfo?: LiteLLMModelInfo,
        _caller?: string
    ): Promise<OpenAIChatCompletionRequest> {
        const config = await this.configManager.getConfig();
        // See `buildOpenAIChatRequest` for the rationale: `model.id` is
        // namespaced, the body needs the raw model name.
        const rawModelId = this.extractRawModelName(model.id);

        const toolConfig = convertTools(options);
        const trimmedMessages = trimV2MessagesForBudget(messages, toolConfig.tools, model, modelInfo);
        validateV2Messages(trimmedMessages);

        const reasoningEffort = this.getReasoningEffort(options, model, modelInfo);
        const reasoningTransport = resolveChatReasoningTransport(
            reasoningEffort,
            rawModelId,
            modelInfo,
            this.isParameterSupported
        );
        const mo = (options.modelOptions as Record<string, unknown>) ?? {};

        const openaiMessages = convertV2MessagesToOpenAI(trimmedMessages, {
            attachPromptCacheControl: modelSupportsPromptCacheControl(rawModelId, modelInfo),
        });
        const requestBody: OpenAIChatCompletionRequest = {
            model: rawModelId,
            messages: openaiMessages,
            stream: true,
            max_tokens:
                typeof options.modelOptions?.max_tokens === "number"
                    ? Math.min(options.modelOptions.max_tokens, model.maxOutputTokens)
                    : model.maxOutputTokens,
            ...reasoningTransport,
        };

        if (this.isParameterSupported("temperature", modelInfo, rawModelId)) {
            const temp = mo.temperature as number | undefined;
            requestBody.temperature = temp;
        }
        if (this.isParameterSupported("frequency_penalty", modelInfo, rawModelId)) {
            const fp = mo.frequency_penalty as number | undefined;
            requestBody.frequency_penalty = fp;
        }
        if (this.isParameterSupported("presence_penalty", modelInfo, rawModelId)) {
            const pp = mo.presence_penalty as number | undefined;
            requestBody.presence_penalty = pp;
        }
        if (this.isParameterSupported("top_p", modelInfo, rawModelId) && typeof mo.top_p === "number") {
            requestBody.top_p = mo.top_p;
        }

        if (toolConfig.tools) {
            requestBody.tools = toolConfig.tools as unknown as OpenAIFunctionToolDef[];
        }

        // Only include tool_choice when:
        // 1. Model supports tool_choice (per isParameterSupported), AND
        // 2. Tools are present, AND
        //    a. Explicitly required by toolMode (toolConfig.tool_choice is set), OR
        //    b. Model supports it - default to "auto" for backward compatibility
        if (toolConfig.tools && toolConfig.tools.length > 0) {
            if (this.isParameterSupported("tool_choice", modelInfo, rawModelId)) {
                if (toolConfig.tool_choice) {
                    // Explicitly required tool (toolMode === Required)
                    requestBody.tool_choice = toolConfig.tool_choice;
                } else {
                    // Model supports tool_choice, tools present, but no explicit required mode
                    // Default to "auto" for backward compatibility
                    requestBody.tool_choice = "auto";
                }
            }
            // If model doesn't support tool_choice, omit it entirely
        }

        this.finalizeRequestBody(requestBody, rawModelId, config.disableCaching === true, modelInfo);
        return requestBody;
    }
}
