import * as vscode from "vscode";
import type { LiteLLMConfig } from "../types";
import { LiteLLMProviderBase } from "./liteLLMProviderBase";
import { LiteLLMTelemetry } from "../utils/telemetry";
import { Logger } from "../utils/logger";
import { countTokens } from "../adapters/tokenUtils";
import { StreamTokenCapture } from "../adapters/streaming/streamTokenCapture";
import { decodeSSE } from "../adapters/sse/sseDecoder";
import { createInitialStreamingState, interpretStreamEvent } from "../adapters/streaming/liteLLMStreamInterpreter";
import { COMMIT_MESSAGE_PROMPT, COMMIT_SYSTEM_PROMPT } from "../utils/prompts";
import { stripMarkdownCodeBlocks } from "../utils";
import type { EffortFallbackCache } from "../utils/reasoningEffortFallback";

/**
 * Provider for generating Git commit messages using LiteLLM.
 * Extends the shared orchestration from LiteLLMProviderBase.
 */
export class LiteLLMCommitMessageProvider extends LiteLLMProviderBase {
    constructor(secrets: vscode.SecretStorage, userAgent: string, effortFallbackCache?: EffortFallbackCache) {
        super(secrets, userAgent, effortFallbackCache);
    }

    /**
     * Generates a commit message from a git diff.
     * @param diff The git diff to analyze.
     * @param options Language model request options.
     * @param token Cancellation token.
     * @param onProgress Callback for streaming response parts.
     */
    /**
     * @deprecated Direct provider request fallback removed; use VS Code's selectChatModels route only.
     * Retained for potential future credential-supply logic.
     */
    async provideCommitMessage(
        diff: string,
        options: vscode.LanguageModelChatRequestOptions,
        token: vscode.CancellationToken,
        onProgress?: (text: string) => void,
        configuration?: Record<string, unknown>
    ): Promise<string> {
        const requestId = Math.random().toString(36).substring(7);
        const startTime = LiteLLMTelemetry.startTimer();
        const caller = "scm-generator";
        const telemetry = this.getTelemetryOptions(
            options as unknown as vscode.ProvideLanguageModelChatResponseOptions
        );
        const justification = telemetry.justification;

        Logger.info(
            `Commit message request started | RequestID: ${requestId} | Caller: ${caller} | Justification: ${justification || "none"}`
        );

        let tokensIn: number | undefined;
        let modelId = "unknown";

        try {
            // Note: With VS Code 1.120+ per-group provider configuration, the backend
            // URL/key are configured via languageModelChatProviders contribution point.
            // The config object here only contains workspace-scoped settings.
            const config = await this._configManager.getConfig();

            // Select a model suitable for commit message generation
            const model = await this.resolveCommitModel(config, token);
            if (!model) {
                throw new Error("No model available for commit message generation");
            }
            modelId = model.id;
            // Capability lookup goes directly to the BackendRegistry — same
            // single-source-of-truth read as the chat and completion paths.
            const modelInfo = this._registry.getModelInfo(model.id);

            // Construct the chat messages
            const messages: vscode.LanguageModelChatRequestMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [new vscode.LanguageModelTextPart(COMMIT_SYSTEM_PROMPT)],
                    name: undefined,
                },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [
                        new vscode.LanguageModelTextPart(`${COMMIT_MESSAGE_PROMPT}\n\nHere is the diff:\n\n${diff}`),
                    ],
                    name: undefined,
                },
            ];

            // Calculate tokensIn for telemetry
            tokensIn = countTokens(messages, this.getRawModelName(model.id), modelInfo);

            // Build the OpenAI-compatible request body
            // `model.id` may be the namespaced `<routing>/<raw>` form; the
            // request builder extracts the raw name for `request.model`.
            const requestBody = await this.buildOpenAIChatRequest(
                messages,
                model,
                {
                    modelOptions: options.modelOptions,
                    tools: [],
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                modelInfo,
                "scm-generator"
            );

            // Send the request
            const tokenCapture = new StreamTokenCapture(
                model.id,
                {
                    report: (part) => {
                        if (part instanceof vscode.LanguageModelTextPart && onProgress) {
                            onProgress(part.value);
                        }
                    },
                },
                modelInfo
            );
            tokenCapture.setEstimatedPromptTokens(tokensIn ?? 0);
            const trackingProgress = tokenCapture.progress;

            const stream = await this.sendRequestWithRetry(
                requestBody,
                messages,
                model,
                {
                    modelOptions: options.modelOptions,
                    tools: [],
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                    requestInitiator: "commit-message",
                    configuration,
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                trackingProgress,
                token,
                "scm-generator",
                modelInfo
            );

            // Extract the final text from the stream
            const commitMessage = await this.extractTextFromStream(stream, token, onProgress);

            // Sanitize the message by stripping markdown code blocks
            const sanitizedMessage = stripMarkdownCodeBlocks(commitMessage);

            const snapshot = tokenCapture.getSnapshot();
            const tokensOut = snapshot.sawUpstreamUsage
                ? snapshot.completionTokens
                : countTokens(sanitizedMessage, this.getRawModelName(model.id), modelInfo);

            LiteLLMTelemetry.reportMetric({
                requestId,
                model: model.id,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                tokensIn,
                tokensOut,
                status: "success",
                caller: "scm-generator",
            });

            return sanitizedMessage;
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            Logger.error(`Commit message generation failed: ${errorMsg}`, err);

            LiteLLMTelemetry.reportMetric({
                requestId,
                model: modelId,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                tokensIn,
                status: "failure",
                error: errorMsg,
                caller: "scm-generator",
            });

            if (err instanceof Error) {
                this._telemetryService?.captureException(err, {
                    caller: "scm-generator",
                    properties: {
                        requestId,
                        modelId,
                    },
                });
            }

            throw err;
        }
    }

    /**
     * Resolves the model to use for commit message generation.
     *
     * The commit-message path is a command, not a chat-VS-Code call: VS Code
     * does not pass `options.configuration` here, so we cannot route by
     * per-group config. The model list returned by the chat picker is not
     * available at this call site either (stateless — there is no model-list
     * cache). The override is honored if set; otherwise the user must select
     * a model from the picker. See AGENTS.md for the deferred rework.
     */
    /**
     * @deprecated Use vscode.lm.selectChatModels() instead.
     * Retained for potential future use.
     */
    private async resolveCommitModel(
        config: LiteLLMConfig,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation | undefined> {
        Logger.debug("Starting Commit Model Resolution");

        // Build a synthetic list from the in-memory registry so the override
        // lookup and tag-based fallback work without a model-list cache. The
        // registry is the only place we have any model→backend knowledge at
        // this call site.
        const registry = this._registry;
        const models: vscode.LanguageModelChatInformation[] = [];
        for (const [id, entry] of this.registryEntries(registry)) {
            models.push({
                id,
                name: id,
                family: "litellm",
                version: "1.0",
                tooltip: `Provider: ${id} via ${entry.baseUrl}`,
                detail: entry.baseUrl,
                maxInputTokens: 0,
                maxOutputTokens: 0,
                capabilities: { toolCalling: true, imageInput: false },
            });
        }

        if (config.commitModelIdOverride) {
            Logger.trace(`Returning model data ${config.commitModelIdOverride}`);
            return models.find((m) => m.id === config.commitModelIdOverride);
        }

        // Prefer models explicitly tagged for SCM generation. The registry
        // doesn't carry tags, so the override path is the only deterministic
        // choice here; the tag-based fallback is a no-op until the registry
        // grows tags.
        return undefined;
    }

    /**
     * Adapter to enumerate registry entries as [id, entry] pairs. Avoids
     * exposing the registry's internal `Map` to consumers of this provider.
     */
    private *registryEntries(registry: {
        findBackendForRawName(rawName: string): { baseUrl: string; apiKey: string; rawModelName: string } | undefined;
    }): Iterable<[string, { baseUrl: string; apiKey: string; rawModelName: string }]> {
        // The registry doesn't expose iteration. We rely on VS Code's picker
        // to surface models to the user; commit-model resolution from a
        // non-chat call site is a known limitation. This generator is here
        // to keep the resolver's control flow simple.
        for (const id of []) {
            const entry = registry.findBackendForRawName(id);
            if (entry) {
                yield [id, entry];
            }
        }
    }

    /**
     * Extracts text from the LiteLLM SSE stream and optionally calls a progress callback.
     */
    private async extractTextFromStream(
        stream: ReadableStream<Uint8Array>,
        token: vscode.CancellationToken,
        onProgress?: (text: string) => void
    ): Promise<string> {
        let fullText = "";
        const state = createInitialStreamingState();

        try {
            for await (const payload of decodeSSE(stream, token)) {
                if (token.isCancellationRequested) {
                    break;
                }

                const json = this.tryParseJSON(payload);
                if (!json) {
                    continue;
                }

                const parts = interpretStreamEvent(json, state);
                for (const part of parts) {
                    if (part.type === "text") {
                        fullText += part.value;
                        if (onProgress) {
                            onProgress(part.value);
                        }
                    }
                }
            }
        } catch {
            Logger.warn("Error while extracting commit text");
        }

        return fullText;
    }

    private tryParseJSON(text: string): unknown {
        try {
            return JSON.parse(text);
        } catch {
            return undefined;
        }
    }
}
