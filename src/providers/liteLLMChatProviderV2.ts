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

        Logger.info(`V2 Chat request started | RequestID: ${requestId} | Model: ${model.id}`);

        try {
            const config = await this._configManager.getConfig();
            const modelInfo = this._modelInfoCache.get(model.id);
            const normalizedMessages = this.normalizeMessagesForV2Pipeline(messages);

            const requestBody = await this.buildV2ChatRequest(normalizedMessages, model, options, modelInfo, caller);
            const tokensIn = this.countTokensForV2Messages(normalizedMessages, model.id, modelInfo);

            const stream = await this.sendRequestToLiteLLM(
                requestBody,
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
            Logger.error("V2 Chat request failed", err);
            throw err;
        }
    }

    private async *decodeStream(stream: ReadableStream<Uint8Array>, token: vscode.CancellationToken) {
        const { decodeSSE } = await import("../adapters/sse/sseDecoder.js");
        for await (const payload of decodeSSE(stream, token)) {
            try {
                yield JSON.parse(payload);
            } catch {
                continue;
            }
        }
    }
}
