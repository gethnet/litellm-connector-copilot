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
    private readonly liteLLMClientFactory: (backend: {
        url: string;
        key?: string;
        disableCaching?: boolean;
    }) => LiteLLMClient;

    constructor(deps: TransportDeps) {
        this.configManager = deps.configManager;
        this.userAgent = deps.userAgent;
        this.logger = deps.logger;
        this.liteLLMClientFactory =
            deps.liteLLMClientFactory ??
            ((backend) =>
                new LiteLLMClient(
                    { url: backend.url, key: backend.key, disableCaching: backend.disableCaching },
                    this.userAgent
                ));
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

        // Thread disableCaching from the per-call configuration through to the
        // LiteLLMClient so Cache-Control headers are set on the HTTP connection.
        const disableCaching =
            typeof configuration?.disableCaching === "boolean" ? configuration.disableCaching : undefined;
        this.logger.trace(
            `[transport.sendRequestToLiteLLM] Creating client: baseUrl=${baseUrl}, timeout=${modelInfo?.timeout ?? "default"}ms, disableCaching=${disableCaching}`
        );
        const client = this.liteLLMClientFactory({ url: baseUrl, key: apiKey, disableCaching });

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

        // Read the per-call fallback flag from the per-group configuration.
        // VS Code 1.120 delivers workspace settings via options.configuration on
        // every call; the chat provider merges LiteLLMConfig into this object
        // before invoking the transport, so allowChatCompletionsFallback lives
        // here rather than on a globally-cached config.
        const allowFallback =
            typeof configuration?.allowChatCompletionsFallback === "boolean" &&
            configuration.allowChatCompletionsFallback === true;

        try {
            const stream = await client.chat(request, modelInfo?.mode, token, modelInfo);
            this.logger.debug(`[transport.sendRequestToLiteLLM] HTTP stream established for model: ${request.model}`);
            StructuredLogger.debug("transport.http_response_stream_open", {
                model: request.model,
                caller,
            });
            return stream;
        } catch (err) {
            // Documented escape hatch: when forceResponsesEndpoint (or a
            // backend-advertised mode) routes a model to /responses and the
            // proxy returns a 5xx (e.g. Azure AI returning a chat-completions
            // schema that LiteLLM cannot parse into ResponsesAPIResponse),
            // retry exactly once on /chat/completions. Only /responses 5xx
            // triggers the fallback — 4xx and chat-mode failures propagate as
            // hard failures. This is the behavior README.md advertises for
            // `litellm-connector.allowChatCompletionsFallback`.
            const isResponsesMode = modelInfo?.mode === "responses";
            const is500 = err instanceof Error && /LiteLLM API error: 5\d\d/.test(err.message);
            if (allowFallback && isResponsesMode && is500) {
                this.logger.warn(
                    `[transport.sendRequestToLiteLLM] /responses failed with 5xx for model ${request.model}; falling back to /chat/completions (allowChatCompletionsFallback=true)`,
                    err
                );
                StructuredLogger.warn("transport.responses_fallback_to_chat", {
                    model: request.model,
                    caller,
                    error: err instanceof Error ? err.message : String(err),
                });
                const chatModelInfo: LiteLLMModelInfo | undefined = modelInfo
                    ? { ...modelInfo, mode: "chat" }
                    : modelInfo;
                return client.chat(request, "chat", token, chatModelInfo);
            }

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
