import * as vscode from "vscode";
import { LiteLLMProviderBase } from "./liteLLMProviderBase";
import { Logger } from "../utils/logger";
import { LiteLLMTelemetry } from "../utils/telemetry";
import { interpretStreamEvent, createInitialStreamingState } from "../adapters/streaming/liteLLMStreamInterpreter";
import { emitV2PartsToVSCode } from "../adapters/streaming/vscodePartEmitter";

/**
 * V2 Chat provider implementation using proposed VS Code APIs.
 *
 * This provider supports LanguageModelChatMessage2 and LanguageModelThinkingPart.
 */
export class LiteLLMChatProviderV2 extends LiteLLMProviderBase implements vscode.LanguageModelChatProvider {
    private emitUsageDataPart(
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        promptTokens: number,
        completionTokens: number
    ): void {
        progress.report(
            vscode.LanguageModelDataPart.json(
                {
                    kind: "usage",
                    promptTokens,
                    completionTokens,
                    details: `V2 Context: ${promptTokens} | Output: ${completionTokens}`,
                },
                "application/vnd.litellm.usage+json"
            )
        );
    }

    async provideLanguageModelChatInformation(
        options: vscode.PrepareLanguageModelChatModelOptions,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        return this.discoverModels(options, token);
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const startTime = LiteLLMTelemetry.startTimer();
        const requestId = Math.random().toString(36).substring(7);
        const caller = "chat-v2";

        if (this._telemetryService) {
            // This will be chatty, but a good point for other things.
            // this._telemetryService.captureFeatureUsed("chat-v2", caller);
        }

        Logger.info(`V2 Chat request started | RequestID: ${requestId} | Model: ${model.id}`);

        try {
            const config = await this._configManager.getConfig();
            const modelInfo = this._modelInfoCache.get(model.id);
            const normalizedMessages = this.normalizeMessagesForV2Pipeline(messages);

            const requestBody = await this.buildV2ChatRequest(normalizedMessages, model, options, modelInfo, caller);
            const tokensIn = this.countTokensForV2Messages(normalizedMessages, model.id, modelInfo);

            const stream = await this.sendRequestWithRetry(
                requestBody,
                normalizedMessages as unknown as readonly vscode.LanguageModelChatRequestMessage[],
                model,
                options,
                progress as vscode.Progress<vscode.LanguageModelResponsePart>,
                token,
                caller,
                modelInfo
            );

            let assistantText = "";
            const state = createInitialStreamingState();
            let usageFromResponse: { inputTokens?: number; outputTokens?: number } | undefined;

            for await (const chunk of this.decodeStream(stream, token)) {
                const parts = interpretStreamEvent(chunk, state);
                for (const part of parts) {
                    if (part.type === "text") {
                        assistantText += part.value;
                    } else if (part.type === "response") {
                        usageFromResponse = part.usage;
                    }
                }
                emitV2PartsToVSCode(parts, progress);
            }

            const tokensOut =
                usageFromResponse?.outputTokens ?? this.countTokensForV2Messages(assistantText, model.id, modelInfo);

            if (config.experimentalEmitUsageData && !usageFromResponse && typeof tokensIn === "number") {
                Logger.debug("V2: Emitting usage data via data part fallback");
                this.emitUsageDataPart(progress, tokensIn, tokensOut);
            }

            LiteLLMTelemetry.reportMetric({
                requestId,
                model: model.id,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                tokensIn,
                tokensOut,
                status: "success",
                caller,
            });
        } catch (err) {
            const durationMs = LiteLLMTelemetry.endTimer(startTime);
            const message = err instanceof Error ? err.message : String(err);

            Logger.error(
                `V2 Chat request failed | RequestID: ${requestId} | Model: ${model.id} | Duration: ${durationMs}ms`,
                err
            );

            if (this._telemetryService) {
                this._telemetryService.captureRequestFailed({
                    request_id: requestId,
                    caller,
                    model: model.id,
                    endpoint: "unknown",
                    durationMs,
                    errorType: message,
                });
            }

            LiteLLMTelemetry.reportMetric({
                requestId,
                model: model.id,
                durationMs,
                status: "failure",
                error: message,
                caller,
            });
            throw err;
        }
    }

    private async *decodeStream(stream: ReadableStream<Uint8Array>, token: vscode.CancellationToken) {
        const { decodeSSE } = await import("../adapters/sse/sseDecoder.js");
        let badFrames = 0;
        for await (const payload of decodeSSE(stream, token)) {
            try {
                yield JSON.parse(payload);
            } catch (parseErr) {
                badFrames += 1;
                if (badFrames <= 3) {
                    Logger.warn(`[decodeStream] Failed to parse SSE frame`, {
                        preview: typeof payload === "string" ? payload.slice(0, 120) : "<non-string>",
                        error: parseErr instanceof Error ? parseErr.message : String(parseErr),
                    });
                }
                continue;
            }
        }
        if (badFrames > 3) {
            Logger.warn(`[decodeStream] ${badFrames} SSE frames failed to parse (additional bad frames suppressed)`);
        }
    }
}
