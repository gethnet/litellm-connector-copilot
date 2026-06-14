import type * as vscode from "vscode";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { isContextOverflowError } from "../../adapters/tokenUtils";
import { StructuredLogger } from "../../observability/structuredLogger";
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
        this.logger.debug(
            `[transport.sendRequestToLiteLLM] Preparing LiteLLM request for model: ${request.model} (caller: ${caller})`
        );
        StructuredLogger.debug("transport.send_request_start", {
            model: request.model,
            caller,
            mode: modelInfo?.mode,
            hasTools: !!request.tools && request.tools.length > 0,
            toolCount: request.tools?.length ?? 0,
            messageCount: request.messages?.length ?? 0,
        });

        const baseUrl = typeof configuration?.baseUrl === "string" ? configuration.baseUrl.trim() : "";
        const apiKey = typeof configuration?.apiKey === "string" ? configuration.apiKey.trim() : "";

        if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
            const errMsg = `No baseUrl provided in call-time configuration for model "${request.model}". Configure the LiteLLM provider group in VS Code's Language Models view.`;
            this.logger.error(`[transport.sendRequestToLiteLLM] Configuration validation failed: ${errMsg}`);
            StructuredLogger.error("transport.config_validation_failed", {
                model: request.model,
                reason: "missing_or_invalid_baseUrl",
                caller,
            });
            throw new Error(errMsg);
        }
        if (!apiKey) {
            const errMsg = `No apiKey provided in call-time configuration for model "${request.model}". Configure the LiteLLM provider group in VS Code's Language Models view.`;
            this.logger.error(`[transport.sendRequestToLiteLLM] Configuration validation failed: ${errMsg}`);
            StructuredLogger.error("transport.config_validation_failed", {
                model: request.model,
                reason: "missing_apiKey",
                caller,
            });
            throw new Error(errMsg);
        }

        this.logger.trace(
            `[transport.sendRequestToLiteLLM] Creating client: baseUrl=${baseUrl}, timeout=${modelInfo?.timeout ?? "default"}ms`
        );
        const client = this.liteLLMClientFactory({ url: baseUrl, key: apiKey });

        this.logger.info(
            `[transport.sendRequestToLiteLLM] Sending request to LiteLLM: model=${request.model} caller=${caller} streaming=true`
        );
        StructuredLogger.info("transport.http_request_start", {
            model: request.model,
            caller,
            endpoint: modelInfo?.mode,
            requestModel: request.model,
            reasoning_effort: (request as { reasoning_effort?: string }).reasoning_effort,
            max_tokens: request.max_tokens,
            temperature: request.temperature,
            top_p: request.top_p,
        });

        try {
            const stream = await client.chat(request, modelInfo?.mode, token, modelInfo);
            this.logger.debug(`[transport.sendRequestToLiteLLM] HTTP stream established for model: ${request.model}`);
            StructuredLogger.debug("transport.http_response_stream_open", {
                model: request.model,
                caller,
            });
            return stream;
        } catch (err) {
            this.logger.error(`[transport.sendRequestToLiteLLM] HTTP request failed for model ${request.model}`, err);
            StructuredLogger.error("transport.http_request_failed", {
                model: request.model,
                caller,
                error: err instanceof Error ? err.message : String(err),
            });
            throw err;
        }
    }
}
