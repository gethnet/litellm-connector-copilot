import type * as vscode from "vscode";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../../types";
import type { LiteLLMClient } from "../../adapters/litellmClient";
import type { ConfigManager as configMgr } from "../../config/configManager";

export interface RequestBuilderDeps {
    configManager: configMgr;
    getReasoningEffort: (
        options: vscode.ProvideLanguageModelChatResponseOptions,
        model: vscode.LanguageModelChatInformation,
        modelInfo?: LiteLLMModelInfo
    ) => string | undefined;
    detectQuotaToolRedaction: (
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        tools: readonly vscode.LanguageModelChatTool[],
        requestId: string,
        modelId: string,
        disableRedaction: boolean,
        caller?: string
    ) => { tools: readonly vscode.LanguageModelChatTool[] };
    stripUnsupportedParametersFromRequest: (
        requestBody: Record<string, unknown>,
        modelInfo: LiteLLMModelInfo | undefined,
        modelId?: string
    ) => void;
    isParameterSupported: (param: string, modelInfo: LiteLLMModelInfo | undefined, modelId?: string) => boolean;
    getTelemetryOptions: (options: vscode.ProvideLanguageModelChatResponseOptions) => {
        caller?: string;
        justification?: string;
        modelConfiguration?: Record<string, unknown>;
    };
    usageOptOutModels: Set<string>;
    /**
     * Strips the routing prefix from a model id to recover the raw
     * LiteLLM model name (e.g. `wolfram.com/azure_ai/gpt-5.4-mini` →
     * `azure_ai/gpt-5.4-mini`). Used for `request.model` in the
     * OpenAI-compatible body and for capability/parameter lookups that
     * are keyed on the raw model family.
     */
    extractRawModelName: (modelId: string) => string;
}

export interface TransportDeps {
    configManager: configMgr;
    userAgent: string;
    logger: {
        info: (msg: string, err?: unknown) => void;
        warn: (msg: string, err?: unknown) => void;
        error: (msg: string, err?: unknown) => void;
        debug: (msg: string, err?: unknown) => void;
        trace: (msg: string, err?: unknown) => void;
    };
    liteLLMClientFactory?: (backend: { url: string; key?: string }) => LiteLLMClient;
}

export interface SendRequestArgs {
    request: OpenAIChatCompletionRequest;
    messages: readonly vscode.LanguageModelChatRequestMessage[];
    model: vscode.LanguageModelChatInformation;
    options: vscode.ProvideLanguageModelChatResponseOptions;
    progress: vscode.Progress<vscode.LanguageModelResponsePart>;
    token: vscode.CancellationToken;
    caller?: string;
    modelInfo?: LiteLLMModelInfo;
    /**
     * Per-group provider configuration passed by VS Code on the originating
     * call. When present, the transport uses its `baseUrl` / `apiKey` directly
     * to construct the LiteLLM client. When absent, the request cannot be
     * routed and the transport throws a configuration error.
     */
    configuration?: Record<string, unknown>;
}
