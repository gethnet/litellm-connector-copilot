import type * as vscode from "vscode";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { isContextOverflowError } from "../../adapters/tokenUtils";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../../types";
import type { SendRequestArgs, TransportDeps } from "./types";

/**
 * Sends a LiteLLM request to the configured endpoint.
 *
 * The single-provider design means routing is direct: the
 * `LiteLLMClient` is constructed from the baseUrl/apiKey passed on the
 * originating VS Code call (via `options.configuration`). There is no
 * global state consulted for routing and no model-id parsing.
 */
export class Transport {
    private readonly configManager: TransportDeps["configManager"];
    private readonly userAgent: string;
    private readonly logger: TransportDeps["logger"];
    private readonly liteLLMClientFactory: (backend: { url: string; key?: string }) => LiteLLMClient;

    constructor(deps: TransportDeps) {
        this.configManager = deps.configManager;
        this.userAgent = deps.userAgent;
        this.logger = deps.logger;
        this.liteLLMClientFactory =
            deps.liteLLMClientFactory ??
            ((backend) => new LiteLLMClient({ url: backend.url, key: backend.key }, this.userAgent));
    }

    public async sendRequestWithRetry(args: SendRequestArgs): Promise<ReadableStream<Uint8Array>> {
        const { request, progress, token, caller, modelInfo, model, configuration } = args;
        try {
            return await this.sendRequestToLiteLLM(request, progress, token, caller, modelInfo, configuration);
        } catch (err) {
            if (isContextOverflowError(err) && modelInfo?.max_input_tokens) {
                this.logger.warn("Retrying after context overflow", err);
                const trimmed: OpenAIChatCompletionRequest = { ...request };
                trimmed.max_tokens = Math.min(trimmed.max_tokens ?? model.maxOutputTokens, model.maxOutputTokens);
                return this.sendRequestToLiteLLM(trimmed, progress, token, caller, modelInfo, configuration);
            }
            throw err;
        }
    }

    public async sendRequestToLiteLLM(
        request: OpenAIChatCompletionRequest,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        modelInfo?: LiteLLMModelInfo,
        configuration?: Record<string, unknown>
    ): Promise<ReadableStream<Uint8Array>> {
        const baseUrl = typeof configuration?.baseUrl === "string" ? configuration.baseUrl.trim() : "";
        const apiKey = typeof configuration?.apiKey === "string" ? configuration.apiKey.trim() : "";

        if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
            throw new Error(
                `No baseUrl provided in call-time configuration for model "${request.model}". ` +
                    `Configure the LiteLLM provider group in VS Code's Language Models view.`
            );
        }
        if (!apiKey) {
            throw new Error(
                `No apiKey provided in call-time configuration for model "${request.model}". ` +
                    `Configure the LiteLLM provider group in VS Code's Language Models view.`
            );
        }

        const client = this.liteLLMClientFactory({ url: baseUrl, key: apiKey });
        return client.chat(request, modelInfo?.mode, token, modelInfo);
    }
}
