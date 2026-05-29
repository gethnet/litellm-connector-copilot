import * as vscode from "vscode";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { MultiBackendClient } from "../../adapters/multiBackendClient";
import { isContextOverflowError } from "../../adapters/tokenUtils";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../../types";
import type { SendRequestArgs, TransportDeps } from "./types";

export class Transport {
    private readonly configManager: TransportDeps["configManager"];
    private readonly userAgent: string;
    private readonly getDiscoveredModelBackend: TransportDeps["getDiscoveredModelBackend"];
    private readonly getTransportModelId: TransportDeps["getTransportModelId"];
    private readonly logger: TransportDeps["logger"];
    private readonly liteLLMClientFactory: (backend: { url: string; key?: string }) => LiteLLMClient;
    private readonly multiBackendClientFactory: TransportDeps["multiBackendClientFactory"];
    private multiBackendClient: MultiBackendClient | undefined;

    constructor(deps: TransportDeps) {
        this.configManager = deps.configManager;
        this.userAgent = deps.userAgent;
        this.getDiscoveredModelBackend = deps.getDiscoveredModelBackend;
        this.getTransportModelId = deps.getTransportModelId;
        this.logger = deps.logger;
        this.liteLLMClientFactory =
            deps.liteLLMClientFactory ??
            ((backend) => new LiteLLMClient({ url: backend.url, key: backend.key }, this.userAgent));
        this.multiBackendClientFactory =
            deps.multiBackendClientFactory ?? ((backends, ua) => new MultiBackendClient(backends, ua));
    }

    public setMultiBackendClient(client: MultiBackendClient | undefined): void {
        this.multiBackendClient = client;
    }

    public async sendRequestWithRetry(args: SendRequestArgs): Promise<ReadableStream<Uint8Array>> {
        const { request, progress, token, caller, modelInfo, model } = args;
        try {
            return await this.sendRequestToLiteLLM(request, progress, token, caller, modelInfo);
        } catch (err) {
            if (isContextOverflowError(err) && modelInfo?.max_input_tokens) {
                this.logger.warn("Retrying after context overflow", err);
                const trimmed: OpenAIChatCompletionRequest = { ...request };
                trimmed.max_tokens = Math.min(trimmed.max_tokens ?? model.maxOutputTokens, model.maxOutputTokens);
                return this.sendRequestToLiteLLM(trimmed, progress, token, caller, modelInfo);
            }
            throw err;
        }
    }

    public async sendRequestToLiteLLM(
        request: OpenAIChatCompletionRequest,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        modelInfo?: LiteLLMModelInfo
    ): Promise<ReadableStream<Uint8Array>> {
        const backend = this.getDiscoveredModelBackend(request.model);
        if (!backend) {
            throw new Error(`No backend resolved for model ${request.model}`);
        }

        const transportModelId = this.getTransportModelId(request.model);
        const payload = { ...request, model: transportModelId };
        const client = this.liteLLMClientFactory({ url: backend.url, key: backend.apiKey });
        return client.chat(payload, modelInfo?.mode, token, modelInfo);
    }
}
