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
        const openaiMessages = convertMessages(messagesToUse);
        validateRequest(messagesToUse);

        const reasoningEffort = this.getReasoningEffort(options, model, modelInfo);
        const mo = (options.modelOptions as Record<string, unknown>) ?? {};

        const requestBody: OpenAIChatCompletionRequest = {
            model: rawModelId,
            messages: openaiMessages,
            stream: true,
            max_tokens:
                typeof mo.max_tokens === "number"
                    ? Math.min(mo.max_tokens, model.maxOutputTokens)
                    : model.maxOutputTokens,
            ...(this.isParameterSupported("reasoning_effort", modelInfo, rawModelId) &&
            reasoningEffort &&
            reasoningEffort !== "none"
                ? { reasoning_effort: reasoningEffort }
                : {}),
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
        if (toolConfig.tool_choice) {
            requestBody.tool_choice = toolConfig.tool_choice;
        }

        this.stripUnsupportedParametersFromRequest(
            requestBody as unknown as Record<string, unknown>,
            modelInfo,
            rawModelId
        );
        return requestBody;
    }

    public async buildV2ChatRequest(
        messages: readonly V2ChatMessage[],
        model: vscode.LanguageModelChatInformation,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        modelInfo?: LiteLLMModelInfo,
        _caller?: string
    ): Promise<OpenAIChatCompletionRequest> {
        // See `buildOpenAIChatRequest` for the rationale: `model.id` is
        // namespaced, the body needs the raw model name.
        const rawModelId = this.extractRawModelName(model.id);

        const toolConfig = convertTools(options);
        const trimmedMessages = trimV2MessagesForBudget(messages, toolConfig.tools, model, modelInfo);
        validateV2Messages(trimmedMessages);

        const reasoningEffort = this.getReasoningEffort(options, model, modelInfo);
        const mo = (options.modelOptions as Record<string, unknown>) ?? {};

        const requestBody: OpenAIChatCompletionRequest = {
            model: rawModelId,
            messages: convertV2MessagesToOpenAI(trimmedMessages),
            stream: true,
            max_tokens:
                typeof options.modelOptions?.max_tokens === "number"
                    ? Math.min(options.modelOptions.max_tokens, model.maxOutputTokens)
                    : model.maxOutputTokens,
            ...(this.isParameterSupported("reasoning_effort", modelInfo, rawModelId) &&
            reasoningEffort &&
            reasoningEffort !== "none"
                ? { reasoning_effort: reasoningEffort }
                : {}),
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
        if (toolConfig.tool_choice) {
            requestBody.tool_choice = toolConfig.tool_choice;
        }

        this.stripUnsupportedParametersFromRequest(
            requestBody as unknown as Record<string, unknown>,
            modelInfo,
            rawModelId
        );
        return requestBody;
    }
}
