import * as vscode from "vscode";

import type { LiteLLMConfig } from "../types";
import { Logger } from "../utils/logger";
import { LiteLLMTelemetry } from "../utils/telemetry";
import { LiteLLMProviderBase } from "./liteLLMProviderBase";

/**
 * Implements VS Code's LanguageModelTextCompletionProvider for inline completions.
 *
 * This provider reuses the shared ingress pipeline from LiteLLMProviderBase by
 * wrapping the prompt string into a chat message and building an OpenAI-style
 * chat request.
 */
export class LiteLLMCompletionProvider extends LiteLLMProviderBase {
    async provideTextCompletion(
        prompt: string,
        options: {
            modelId?: string;
            modelOptions?: Record<string, unknown>;
            configuration?: Record<string, unknown>;
        },
        token: vscode.CancellationToken
    ): Promise<{ insertText: string }> {
        const requestId = Math.random().toString(36).substring(7);
        const startTime = LiteLLMTelemetry.startTimer();

        try {
            const config = options.configuration
                ? this._configManager.convertProviderConfiguration(options.configuration)
                : await this._configManager.getConfig();

            if (!config.url) {
                throw new Error("LiteLLM configuration not found. Please configure the LiteLLM base URL.");
            }

            const model = await this.resolveCompletionModel(config, token);
            if (!model) {
                throw new Error("No model available for completions");
            }

            const modelInfo = this._modelInfoCache.get(model.id);
            const messages: vscode.LanguageModelChatRequestMessage[] = [this.wrapPromptAsMessage(prompt)];

            // Reuse the base request pipeline. We pass a minimal ProvideLanguageModelChatResponseOptions-like
            // structure with provider configuration and model options.
            const requestBody = await this.buildOpenAIChatRequest(
                messages,
                model,
                {
                    modelOptions: options.modelOptions,
                    configuration: options.configuration,
                    tools: [],
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                modelInfo,
                "inline-completions"
            );

            // For completions we don't emit progress parts; we just need the raw stream to extract text.
            const nullProgress: vscode.Progress<vscode.LanguageModelResponsePart> = { report: () => {} };
            const stream = await this.sendRequestToLiteLLM(
                requestBody,
                nullProgress,
                token,
                "inline-completions",
                modelInfo
            );

            const completionText = await this.extractCompletionTextFromStream(stream, token);

            LiteLLMTelemetry.reportMetric({
                requestId,
                model: model.id,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                status: "success",
                caller: "inline-completions",
            });

            return {
                insertText: completionText,
            };
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            Logger.error(`Completions failed: ${errorMsg}`, err);

            LiteLLMTelemetry.reportMetric({
                requestId,
                model: options.modelId ?? "unknown",
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                status: "failure",
                error: errorMsg,
                caller: "inline-completions",
            });

            throw err;
        }
    }

    private wrapPromptAsMessage(prompt: string): vscode.LanguageModelChatRequestMessage {
        return {
            role: vscode.LanguageModelChatMessageRole.User,
            content: [new vscode.LanguageModelTextPart(prompt)],
            name: undefined,
        };
    }

    private async resolveCompletionModel(
        config: LiteLLMConfig,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation | undefined> {
        if (this._lastModelList.length === 0) {
            await this.discoverModels({ silent: true }, token);
        }

        if (config.modelIdOverride) {
            return this._lastModelList.find((m) => m.id === config.modelIdOverride);
        }

        // Prefer models explicitly tagged for inline completions.
        const tagged = this._lastModelList.find((m) => {
            const tags = (m as unknown as { tags?: string[] }).tags;
            return tags?.includes("inline-completions") === true;
        });
        if (tagged) {
            return tagged;
        }

        // Fallback: first discovered model.
        return this._lastModelList[0];
    }

    private async extractCompletionTextFromStream(
        stream: ReadableStream<Uint8Array>,
        token: vscode.CancellationToken
    ): Promise<string> {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";

        try {
            while (!token.isCancellationRequested) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (!line.startsWith("data:")) {
                        continue;
                    }
                    const data = line.replace(/^data:\s*/, "");
                    if (!data || data === "[DONE]") {
                        continue;
                    }
                    try {
                        const json = JSON.parse(data) as {
                            choices?: Array<{ delta?: { content?: string } }>;
                        };
                        const delta = json.choices?.[0]?.delta;
                        if (delta?.content) {
                            fullText += delta.content;
                        }
                    } catch {
                        // ignore malformed frames
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        return fullText;
    }
}
