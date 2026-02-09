import * as vscode from "vscode";
import type {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatRequestMessage,
    LanguageModelChatProvider,
    LanguageModelResponsePart,
    Progress,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";

import type { LiteLLMModelInfo, OpenAIChatCompletionRequest, OpenAIFunctionToolDef } from "../types";
import { convertTools, convertMessages, tryParseJSONObject, validateRequest } from "../utils";
import { ConfigManager } from "../config/configManager";
import { LiteLLMClient } from "../adapters/litellmClient";
import { ResponsesClient } from "../adapters/responsesClient";
import { transformToResponsesFormat } from "../adapters/responsesAdapter";
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_CONTEXT_LENGTH, trimMessagesToFitBudget } from "../adapters/tokenUtils";
import { Logger } from "../utils/logger";
import { LiteLLMTelemetry } from "../utils/telemetry";

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

export class LiteLLMChatModelProvider implements LanguageModelChatProvider {
    private _parameterProbeCache: Map<string, Set<string>> = new Map<string, Set<string>>();
    private _modelInfoCache: Map<string, LiteLLMModelInfo | undefined> = new Map<
        string,
        LiteLLMModelInfo | undefined
    >();
    private _configManager: ConfigManager;

    // Streaming state
    private _toolCallBuffers: Map<number, { id?: string; name?: string; args: string }> = new Map<
        number,
        { id?: string; name?: string; args: string }
    >();
    private _completedToolCallIndices = new Set<number>();
    private _hasEmittedAssistantText = false;
    private _emittedBeginToolCallsHint = false;
    private _partialAssistantText = "";
    private _textToolParserBuffer = "";
    private _textToolActive: { name?: string; index?: number; argBuffer: string; emitted?: boolean } | undefined =
        undefined;
    private _emittedTextToolCallKeys = new Set<string>();
    private _emittedTextToolCallIds = new Set<string>();
    private _lastEmittedText = "";
    private _repeatCount = 0;
    private _lastFinishReason: string | undefined = undefined;

    constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly userAgent: string
    ) {
        this._configManager = new ConfigManager(secrets);
    }

    async provideLanguageModelChatInformation(
        _options: { silent: boolean },
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        Logger.debug("provideLanguageModelChatInformation called");
        try {
            const config = await this._configManager.getConfig();
            Logger.debug(`Config URL: ${config.url ? "set" : "not set"}`);
            if (!config.url) {
                Logger.info("No base URL configured, returning empty model list.");
                return [];
            }

            const client = new LiteLLMClient(config, this.userAgent);
            Logger.debug("Fetching model info from LiteLLM...");
            const { data } = await client.getModelInfo();

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

                    const maxInputTokens = modelInfo?.max_input_tokens ?? DEFAULT_CONTEXT_LENGTH;
                    const maxOutputTokens = modelInfo?.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

                    // Build capabilities based on model_info flags
                    const capabilities = this.buildCapabilities(modelInfo);

                    const info = {
                        id: modelId,
                        name: entry.model_name ?? modelId,
                        tooltip: `${modelInfo?.litellm_provider ?? "LiteLLM"} (${modelInfo?.mode ?? "responses"})`,
                        family: "litellm",
                        version: "1.0.0",
                        maxInputTokens: Math.max(1, maxInputTokens),
                        maxOutputTokens: Math.max(1, maxOutputTokens),
                        capabilities,
                    } satisfies LanguageModelChatInformation;

                    // If model has exceptionally high context, ensure we don't overflow VS Code's expectations if any
                    // but generally we trust model_info
                    return info;
                }
            );

            return infos;
        } catch (err) {
            Logger.error("Failed to fetch models", err);
            return [];
        }
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: readonly LanguageModelChatRequestMessage[],
        options: ProvideLanguageModelChatResponseOptions & { configuration?: Record<string, unknown> },
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        this.resetStreamingState();
        const startTime = LiteLLMTelemetry.startTimer();
        const requestId = Math.random().toString(36).substring(7);

        const trackingProgress: Progress<LanguageModelResponsePart> = {
            report: (part) => {
                if (part instanceof vscode.LanguageModelTextPart) {
                    this._partialAssistantText += part.value;
                }
                progress.report(part);
            },
        };

        try {
            // Try to get configuration from the new v1.109+ API first
            const config = options.configuration
                ? this._configManager.convertProviderConfiguration(options.configuration)
                : await this._configManager.getConfig();

            if (!config.url) {
                throw new Error("LiteLLM configuration not found. Please configure the LiteLLM base URL.");
            }

            const modelInfo = this._modelInfoCache.get(model.id);
            const toolRedaction = this.detectQuotaToolRedaction(
                messages,
                options.tools ?? [],
                requestId,
                model.id,
                config.disableQuotaToolRedaction === true
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

            // Add frequency_penalty and presence_penalty to help prevent repetitive loops if supported
            // We only apply these as defaults if Copilot (options.modelOptions) hasn't already provided them.
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

            // Final safety: strip any unsupported parameters that slipped through earlier checks
            this.stripUnsupportedParametersFromRequest(
                requestBody as unknown as Record<string, unknown>,
                modelInfo,
                model.id
            );

            const client = new LiteLLMClient(config, this.userAgent);

            // Try /responses endpoint first if mode is 'responses'
            if (modelInfo?.mode === "responses") {
                try {
                    const responsesClient = new ResponsesClient(config, this.userAgent);
                    const responsesRequest = transformToResponsesFormat(requestBody);
                    await responsesClient.sendResponsesRequest(responsesRequest, trackingProgress, token, modelInfo);
                    LiteLLMTelemetry.reportMetric({
                        requestId,
                        model: model.id,
                        durationMs: LiteLLMTelemetry.endTimer(startTime),
                        status: "success",
                    });
                    return;
                } catch (err) {
                    Logger.warn(`/responses failed, falling back to /chat/completions: ${err}`);
                    // Fall through to standard chat/completions
                }
            }

            let stream: ReadableStream<Uint8Array>;
            try {
                stream = await client.chat(requestBody, "chat", token);
            } catch (err: unknown) {
                if (token.isCancellationRequested) {
                    throw new Error("Operation cancelled by user");
                }
                // If we get an unsupported parameter error, try one more time without those parameters
                if (err instanceof Error && err.message.includes("LiteLLM API error")) {
                    const errorText = err.message.split("\n").slice(1).join("\n");
                    const parsedMessage = this.parseApiError(400, errorText);
                    if (
                        parsedMessage.toLowerCase().includes("unsupported parameter") ||
                        parsedMessage.toLowerCase().includes("not supported")
                    ) {
                        Logger.warn(`Retrying request without optional parameters due to: ${parsedMessage}`);
                        // Strip common optional parameters that might cause issues
                        delete requestBody.temperature;
                        delete requestBody.top_p;
                        delete requestBody.frequency_penalty;
                        delete requestBody.presence_penalty;
                        delete requestBody.stop;

                        if (token.isCancellationRequested) {
                            throw new Error("Operation cancelled by user");
                        }
                        stream = await client.chat(requestBody, modelInfo?.mode, token);
                    } else {
                        throw err;
                    }
                } else {
                    throw err;
                }
            }

            await this.processStreamingResponse(stream, trackingProgress, token);
        } catch (err: unknown) {
            let errorMessage = err instanceof Error ? err.message : String(err);

            // If it's a LiteLLM API error, try to parse it for more detail
            if (errorMessage.includes("LiteLLM API error")) {
                const statusMatch = errorMessage.match(/error: (\d+)/);
                const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 400;
                const errorParts = errorMessage.split("\n");
                const errorText = errorParts.length > 1 ? errorParts.slice(1).join("\n") : "";

                const parsedMessage = this.parseApiError(statusCode, errorText);
                errorMessage = `LiteLLM Error (${model.id}): ${parsedMessage}`;

                if (
                    parsedMessage.toLowerCase().includes("temperature") ||
                    parsedMessage.toLowerCase().includes("unsupported value")
                ) {
                    errorMessage +=
                        ". This model may not support certain parameters like temperature. Please check your model settings.";
                }
            }

            console.error("[LiteLLM Model Provider] Chat request failed", err);
            throw new Error(errorMessage);
        }
    }

    async provideTokenCount(
        model: LanguageModelChatInformation,
        text: string | LanguageModelChatRequestMessage,
        _token: CancellationToken
    ): Promise<number> {
        if (typeof text === "string") {
            return Math.ceil(text.length / 4);
        } else {
            let totalTokens = 0;
            for (const part of text.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    totalTokens += Math.ceil(part.value.length / 4);
                }
            }
            return totalTokens;
        }
    }

    private resetStreamingState() {
        this._toolCallBuffers.clear();
        this._completedToolCallIndices.clear();
        this._hasEmittedAssistantText = false;
        this._emittedBeginToolCallsHint = false;
        this._textToolParserBuffer = "";
        this._textToolActive = undefined;
        this._emittedTextToolCallKeys.clear();
        this._emittedTextToolCallIds.clear();
        this._partialAssistantText = "";
        this._lastEmittedText = "";
        this._repeatCount = 0;
        this._lastFinishReason = undefined;
    }

    private isParameterSupported(param: string, modelInfo: LiteLLMModelInfo | undefined, modelId?: string): boolean {
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

        if (modelInfo?.supported_openai_params) {
            return modelInfo.supported_openai_params.includes(param);
        }

        return true;
    }

    private async processStreamingResponse(
        responseBody: ReadableStream<Uint8Array>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const reader = responseBody.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const config = await this._configManager.getConfig();
        const timeoutMs = (config.inactivityTimeout ?? 60) * 1000;
        let watchdog: NodeJS.Timeout | undefined;

        const resetWatchdog = () => {
            if (watchdog) {
                clearTimeout(watchdog);
            }
            watchdog = setTimeout(() => {
                console.warn(`[LiteLLM Model Provider] Inactivity timeout after ${timeoutMs}ms`);
                void reader.cancel("Inactivity timeout");
            }, timeoutMs);
        };

        token.onCancellationRequested(() => {
            if (watchdog) {
                clearTimeout(watchdog);
            }
            void reader.cancel("User cancelled");
        });

        try {
            resetWatchdog();
            while (!token.isCancellationRequested) {
                const { done, value } = await reader.read();
                resetWatchdog();
                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (!line.startsWith("data: ")) {
                        continue;
                    }
                    const data = line.slice(6);
                    if (data === "[DONE]") {
                        await this.flushToolCallBuffers(progress, false);
                        await this.flushActiveTextToolCall(progress);
                        continue;
                    }

                    try {
                        const parsed = JSON.parse(data);
                        await this.processDelta(parsed, progress);
                    } catch {
                        // ignore
                    }
                }
            }

            if (this._lastFinishReason === "length") {
                progress.report(
                    new vscode.LanguageModelTextPart("\n\n---\n_[Response truncated. Reply 'continue' to resume.]_")
                );
            }
        } finally {
            if (watchdog) {
                clearTimeout(watchdog);
            }
            reader.releaseLock();
        }
    }

    private async processDelta(
        delta: Record<string, unknown>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): Promise<boolean> {
        let emitted = false;
        const eventType = delta.type as string | undefined;

        if (eventType === "response.output_text.delta") {
            const textDelta = (delta.delta || delta.text || delta.chunk) as string | undefined;
            if (textDelta) {
                if (textDelta === this._lastEmittedText) {
                    this._repeatCount++;
                } else {
                    this._lastEmittedText = textDelta;
                    this._repeatCount = 0;
                }

                if (this._repeatCount < 20) {
                    progress.report(new vscode.LanguageModelTextPart(textDelta));
                    return true;
                }
                return false;
            }
            return false;
        }

        if (eventType === "response.output_item.done") {
            const item = delta.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") {
                const callId = item.call_id as string | undefined;
                const argumentsStr = item.arguments as string | undefined;
                const name = (item.name as string | undefined) || "unknown_tool";

                if (callId && argumentsStr) {
                    const parsed = tryParseJSONObject(argumentsStr);
                    if (parsed.ok) {
                        progress.report(new vscode.LanguageModelToolCallPart(callId, name, parsed.value));
                        return true;
                    }
                }
            }
            return false;
        }

        let choice = (delta.choices as Record<string, unknown>[] | undefined)?.[0];
        if (!choice) {
            const output = (delta.output as Record<string, unknown>[] | undefined)?.[0];
            if (output) {
                const content = output.content as Record<string, unknown>[] | undefined;
                const textContent = content?.find((c) => c.type === "output_text");
                if (textContent) {
                    choice = {
                        delta: { content: textContent.text },
                        finish_reason: output.finish_reason,
                    };
                }
            }
        }

        if (!choice && !eventType) {
            const content = (delta.content || delta.text) as string | undefined;
            if (content) {
                choice = { delta: { content }, finish_reason: undefined };
            }
        }

        if (!choice) {
            return false;
        }

        const deltaObj = choice.delta as Record<string, unknown>;
        if (deltaObj?.content) {
            const content = String(deltaObj.content);
            const res = this.processTextContent(content, progress);
            if (res.emittedText) {
                this._hasEmittedAssistantText = true;
            }
            if (res.emittedAny) {
                emitted = true;
            }
        }

        if (deltaObj?.tool_calls) {
            const toolCalls = deltaObj.tool_calls as Record<string, unknown>[];
            if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText && toolCalls.length > 0) {
                progress.report(new vscode.LanguageModelTextPart(" "));
                this._emittedBeginToolCallsHint = true;
            }

            for (const tc of toolCalls) {
                const idx = (tc["index"] as number) ?? 0;
                if (this._completedToolCallIndices.has(idx)) {
                    continue;
                }
                const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
                if (tc["id"]) {
                    buf.id = tc["id"] as string;
                }
                const func = tc["function"] as Record<string, unknown> | undefined;
                if (func?.["name"]) {
                    buf.name = func["name"] as string;
                }
                if (func?.["arguments"]) {
                    buf.args += func["arguments"] as string;
                }
                this._toolCallBuffers.set(idx, buf);
                await this.tryEmitBufferedToolCall(idx, progress);
            }
        }

        const finish = choice.finish_reason as string | undefined;
        if (finish) {
            this._lastFinishReason = finish;
        }
        if (finish === "tool_calls" || finish === "stop") {
            await this.flushToolCallBuffers(progress, true);
        }
        return emitted;
    }

    private processTextContent(
        input: string,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): { emittedText: boolean; emittedAny: boolean } {
        const BEGIN = "<|tool_call_begin|>";
        const ARG_BEGIN = "<|tool_call_argument_begin|>";
        const END = "<|tool_call_end|>";

        let data = this._textToolParserBuffer + input;
        let emittedText = false;
        let emittedAny = false;
        let visibleOut = "";

        while (data.length > 0) {
            if (!this._textToolActive) {
                const b = data.indexOf(BEGIN);
                if (b === -1) {
                    const longestPartialPrefix = ((): number => {
                        for (let k = Math.min(BEGIN.length - 1, data.length - 1); k > 0; k--) {
                            if (data.endsWith(BEGIN.slice(0, k))) {
                                return k;
                            }
                        }
                        return 0;
                    })();
                    if (longestPartialPrefix > 0) {
                        const visible = data.slice(0, data.length - longestPartialPrefix);
                        if (visible) {
                            visibleOut += this.stripControlTokens(visible);
                        }
                        this._textToolParserBuffer = data.slice(data.length - longestPartialPrefix);
                        data = "";
                        break;
                    } else {
                        visibleOut += this.stripControlTokens(data);
                        data = "";
                        break;
                    }
                }
                const pre = data.slice(0, b);
                if (pre) {
                    visibleOut += this.stripControlTokens(pre);
                }
                data = data.slice(b + BEGIN.length);

                const a = data.indexOf(ARG_BEGIN);
                const e = data.indexOf(END);
                let delimIdx = -1;
                let delimKind: "arg" | "end" | undefined = undefined;
                if (a !== -1 && (e === -1 || a < e)) {
                    delimIdx = a;
                    delimKind = "arg";
                } else if (e !== -1) {
                    delimIdx = e;
                    delimKind = "end";
                } else {
                    this._textToolParserBuffer = BEGIN + data;
                    data = "";
                    break;
                }

                const header = data.slice(0, delimIdx).trim();
                const m = header.match(/^([A-Za-z0-9_\-.]+)(?::(\d+))?/);
                const name = m?.[1] ?? undefined;
                const index = m?.[2] ? Number(m?.[2]) : undefined;
                this._textToolActive = { name, index, argBuffer: "", emitted: false };
                if (delimKind === "arg") {
                    data = data.slice(delimIdx + ARG_BEGIN.length);
                } else {
                    data = data.slice(delimIdx + END.length);
                    const did = this.emitTextToolCallIfValid(progress, this._textToolActive, "{}");
                    if (did) {
                        this._textToolActive.emitted = true;
                        emittedAny = true;
                    }
                    this._textToolActive = undefined;
                }
                continue;
            }

            const e2 = data.indexOf(END);
            if (e2 === -1) {
                this._textToolActive.argBuffer += data;
                if (!this._textToolActive.emitted) {
                    const did = this.emitTextToolCallIfValid(
                        progress,
                        this._textToolActive,
                        this._textToolActive.argBuffer
                    );
                    if (did) {
                        this._textToolActive.emitted = true;
                        emittedAny = true;
                    }
                }
                data = "";
                break;
            } else {
                this._textToolActive.argBuffer += data.slice(0, e2);
                data = data.slice(e2 + END.length);
                if (!this._textToolActive.emitted) {
                    const did = this.emitTextToolCallIfValid(
                        progress,
                        this._textToolActive,
                        this._textToolActive.argBuffer
                    );
                    if (did) {
                        emittedAny = true;
                    }
                }
                this._textToolActive = undefined;
                continue;
            }
        }

        if (visibleOut) {
            if (visibleOut === this._lastEmittedText) {
                this._repeatCount++;
            } else {
                this._lastEmittedText = visibleOut;
                this._repeatCount = 0;
            }

            if (this._repeatCount < 20) {
                progress.report(new vscode.LanguageModelTextPart(visibleOut));
                emittedText = true;
                emittedAny = true;
            }
        }

        this._textToolParserBuffer = data;
        return { emittedText, emittedAny };
    }

    private emitTextToolCallIfValid(
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        call: { name?: string; index?: number; argBuffer: string; emitted?: boolean },
        argText: string
    ): boolean {
        const name = call.name ?? "unknown_tool";
        const parsed = tryParseJSONObject(argText);
        if (!parsed.ok) {
            return false;
        }
        const canonical = JSON.stringify(parsed.value);
        const key = `${name}:${canonical}`;
        if (typeof call.index === "number") {
            const idKey = `${name}:${call.index}`;
            if (this._emittedTextToolCallIds.has(idKey)) {
                return false;
            }
            this._emittedTextToolCallIds.add(idKey);
        } else if (this._emittedTextToolCallKeys.has(key)) {
            return false;
        }
        this._emittedTextToolCallKeys.add(key);
        const id = `tct_${Math.random().toString(36).slice(2, 10)}`;
        progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
        return true;
    }

    private async flushActiveTextToolCall(progress: vscode.Progress<vscode.LanguageModelResponsePart>): Promise<void> {
        if (!this._textToolActive) {
            return;
        }
        this.emitTextToolCallIfValid(progress, this._textToolActive, this._textToolActive.argBuffer);
        this._textToolActive = undefined;
    }

    private async tryEmitBufferedToolCall(
        index: number,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): Promise<void> {
        const buf = this._toolCallBuffers.get(index);
        if (!buf || !buf.name) {
            return;
        }
        const canParse = tryParseJSONObject(buf.args);
        if (!canParse.ok) {
            return;
        }
        const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
        progress.report(new vscode.LanguageModelToolCallPart(id, buf.name, canParse.value));
        this._toolCallBuffers.delete(index);
        this._completedToolCallIndices.add(index);
    }

    private async flushToolCallBuffers(
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        throwOnInvalid: boolean
    ): Promise<void> {
        for (const [idx, buf] of Array.from(this._toolCallBuffers.entries())) {
            const parsed = tryParseJSONObject(buf.args);
            if (!parsed.ok) {
                if (throwOnInvalid) {
                    throw new Error("Invalid JSON for tool call");
                }
                continue;
            }
            const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
            const name = buf.name ?? "unknown_tool";
            progress.report(new vscode.LanguageModelToolCallPart(id, name, parsed.value));
            this._toolCallBuffers.delete(idx);
            this._completedToolCallIndices.add(idx);
        }
    }

    private stripControlTokens(text: string): string {
        return text
            .replace(/<\|[a-zA-Z0-9_-]+_section_(?:begin|end)\|>/g, "")
            .replace(/<\|tool_call_(?:argument_)?(?:begin|end)\|>/g, "");
    }

    private detectQuotaToolRedaction(
        messages: readonly LanguageModelChatRequestMessage[],
        tools: readonly vscode.LanguageModelChatTool[],
        requestId: string,
        modelId: string,
        disableRedaction: boolean
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
        });

        return { tools: filteredTools };
    }

    private findQuotaErrorInMessages(
        messages: readonly LanguageModelChatRequestMessage[]
    ): { toolName: string; errorText: string; turnIndex: number } | undefined {
        const quotaRegex = /(free\s*tier\s*quota\s*exceeded|quota\s*exceeded)/i;
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
                errorText: text.slice(0, 500),
                turnIndex: i,
            };
        }

        return undefined;
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

    /**
     * Build capabilities object from model_info flags.
     * Maps LiteLLM model capabilities to VSCode LanguageModelChatCapabilities.
     */
    private buildCapabilities(modelInfo: LiteLLMModelInfo | undefined): vscode.LanguageModelChatCapabilities {
        if (!modelInfo) {
            // Default capabilities if no model_info available
            return {
                toolCalling: true,
                imageInput: false,
            };
        }

        // Map LiteLLM capabilities to VSCode capabilities
        const capabilities: vscode.LanguageModelChatCapabilities = {
            // Tool calling is supported if function_calling is supported
            toolCalling: modelInfo.supports_function_calling !== false,
            // Image input is supported if vision is supported
            imageInput: modelInfo.supports_vision === true,
        };

        return capabilities;
    }

    /**
     * Parse error response from LiteLLM API and extract human-readable message.
     */
    private parseApiError(statusCode: number, errorText: string): string {
        try {
            const parsed = JSON.parse(errorText);
            if (parsed.error?.message) {
                return parsed.error.message;
            }
        } catch {
            /* ignore */
        }
        if (errorText) {
            return errorText.slice(0, 200);
        }
        return `API request failed with status ${statusCode}`;
    }

    /**
     * Remove unsupported parameters from the request body as a final safety net.
     */
    private stripUnsupportedParametersFromRequest(
        requestBody: Record<string, unknown>,
        modelInfo: LiteLLMModelInfo | undefined,
        modelId?: string
    ): void {
        // NOTE: Some LiteLLM backends (and/or upstream providers) reject non-OpenAI parameters.
        // In particular, LiteLLM proxy caching controls may be expressed as `cache` or `extra_body.cache`.
        // If a backend doesn't support it, we must not send it.
        const paramsToCheck = [
            "temperature",
            "stop",
            "frequency_penalty",
            "presence_penalty",
            "top_p",
            // caching controls (proxy-specific)
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

        // Always ensure we don't accidentally pass a top-level `cache` object.
        // Some providers error with: "Unknown parameter: 'cache'".
        if ("cache" in requestBody) {
            delete requestBody.cache;
        }

        // If we have extra_body, ensure it doesn't contain cache controls unless the model explicitly supports it.
        // We don't have a reliable per-model signal for this, so we default to stripping cache directives.
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
}
