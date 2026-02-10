import * as vscode from "vscode";
import type {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatProvider,
    LanguageModelChatRequestMessage,
    LanguageModelResponsePart,
    Progress,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";

import { tryParseJSONObject } from "../utils";
import { Logger } from "../utils/logger";
import { LiteLLMTelemetry } from "../utils/telemetry";
import { LiteLLMProviderBase } from "./liteLLMProviderBase";

/**
 * Chat provider implementation for VS Code's LanguageModelChatProvider.
 *
 * All shared orchestration (model discovery, request building, trimming, parameter filtering,
 * endpoint routing) is implemented in LiteLLMProviderBase.
 */
export class LiteLLMChatProvider extends LiteLLMProviderBase implements LanguageModelChatProvider {
    // Streaming state
    private _toolCallBuffers = new Map<number, { id?: string; name?: string; args: string }>();
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

    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        return this.discoverModels(options, token);
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

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const caller = (model as any).tags?.[0] || undefined;

        const trackingProgress: Progress<LanguageModelResponsePart> = {
            report: (part) => {
                if (part instanceof vscode.LanguageModelTextPart) {
                    this._partialAssistantText += part.value;
                }
                progress.report(part);
            },
        };

        try {
            const config = options.configuration
                ? this._configManager.convertProviderConfiguration(options.configuration)
                : await this._configManager.getConfig();

            if (!config.url) {
                throw new Error("LiteLLM configuration not found. Please configure the LiteLLM base URL.");
            }

            // Optional model override (primarily for completions). If set, we try to use it.
            // If the override isn't in cache yet, attempt a best-effort refresh.
            let modelToUse = model;
            if (config.modelIdOverride) {
                const overrideId = config.modelIdOverride;
                const cachedOverride = this._lastModelList.find((m) => m.id === overrideId);
                if (cachedOverride) {
                    modelToUse = cachedOverride;
                } else {
                    try {
                        Logger.info(`modelIdOverride set to '${overrideId}' but not in cache; refreshing model list`);
                        await this.discoverModels({ silent: true }, token);
                        const refreshed = this._lastModelList.find((m) => m.id === overrideId);
                        if (refreshed) {
                            modelToUse = refreshed;
                        } else {
                            Logger.warn(
                                `modelIdOverride '${overrideId}' not found after refresh; using selected model '${model.id}'`
                            );
                        }
                    } catch (refreshErr) {
                        Logger.warn("Failed to refresh model list for override; using selected model", refreshErr);
                    }
                }
            }

            const modelInfo = this._modelInfoCache.get(modelToUse.id);
            const requestBody = await this.buildOpenAIChatRequest(messages, modelToUse, options, modelInfo, caller);

            let stream: ReadableStream<Uint8Array>;
            try {
                // Note: sendRequestToLiteLLM may fully handle /responses by emitting directly to progress.
                // In that case it returns an already-closed stream.
                stream = await this.sendRequestToLiteLLM(requestBody, trackingProgress, token, caller, modelInfo);
            } catch (err: unknown) {
                if (token.isCancellationRequested) {
                    throw new Error("Operation cancelled by user");
                }

                if (err instanceof Error && err.message.includes("LiteLLM API error")) {
                    const errorText = err.message.split("\n").slice(1).join("\n");
                    const parsedMessage = this.parseApiError(400, errorText);
                    if (
                        parsedMessage.toLowerCase().includes("unsupported parameter") ||
                        parsedMessage.toLowerCase().includes("not supported")
                    ) {
                        Logger.warn(`Retrying request without optional parameters due to: ${parsedMessage}`);
                        delete requestBody.temperature;
                        delete requestBody.top_p;
                        delete requestBody.frequency_penalty;
                        delete requestBody.presence_penalty;
                        delete requestBody.stop;

                        if (token.isCancellationRequested) {
                            throw new Error("Operation cancelled by user");
                        }
                        stream = await this.sendRequestToLiteLLM(
                            requestBody,
                            trackingProgress,
                            token,
                            caller,
                            modelInfo
                        );
                    } else {
                        throw err;
                    }
                } else {
                    throw err;
                }
            }

            await this.processStreamingResponse(stream, trackingProgress, token);

            LiteLLMTelemetry.reportMetric({
                requestId,
                model: modelToUse.id,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                status: "success",
                caller,
            });
        } catch (err: unknown) {
            let errorMessage = err instanceof Error ? err.message : String(err);
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
            Logger.error("Chat request failed", err);
            throw new Error(errorMessage);
        }
    }

    async provideTokenCount(
        _model: LanguageModelChatInformation,
        text: string | LanguageModelChatRequestMessage,
        _token: CancellationToken
    ): Promise<number> {
        if (typeof text === "string") {
            return Math.ceil(text.length / 4);
        }
        let totalTokens = 0;
        for (const part of text.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                totalTokens += Math.ceil(part.value.length / 4);
            }
        }
        return totalTokens;
    }

    private resetStreamingState(): void {
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
                Logger.warn(`Inactivity timeout after ${timeoutMs}ms`);
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
                const idx = (tc.index as number) ?? 0;
                if (this._completedToolCallIndices.has(idx)) {
                    continue;
                }
                const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
                if (tc.id) {
                    buf.id = tc.id as string;
                }
                const func = tc.function as Record<string, unknown> | undefined;
                if (func?.name) {
                    buf.name = func.name as string;
                }
                if (func?.arguments) {
                    buf.args += func.arguments as string;
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
                    }
                    visibleOut += this.stripControlTokens(data);
                    data = "";
                    break;
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
                const index = m?.[2] ? Number(m[2]) : undefined;
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
            }
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
}
