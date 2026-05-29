import * as vscode from "vscode";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../../types";
import type { ConfigManager } from "../../config/configManager";
import type { LiteLLMClient } from "../../adapters/litellmClient";
import type { MultiBackendClient } from "../../adapters/multiBackendClient";
import type { BackendSession } from "../backendSession";

export interface DiscoveryDeps {
    configManager: ConfigManager;
    userAgent: string;
    onModernConfigurationDetected?: () => void;
}

export interface RequestBuilderDeps {
    configManager: ConfigManager;
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
}

export interface TransportDeps {
    configManager: ConfigManager;
    userAgent: string;
    getDiscoveredModelBackend: (modelId: string) => { backendName: string; url: string; apiKey?: string } | undefined;
    getTransportModelId: (modelId: string) => string;
    logger: {
        info: (msg: string, err?: unknown) => void;
        warn: (msg: string, err?: unknown) => void;
        error: (msg: string, err?: unknown) => void;
        debug: (msg: string, err?: unknown) => void;
        trace: (msg: string, err?: unknown) => void;
    };
    liteLLMClientFactory?: (backend: { url: string; key?: string }) => LiteLLMClient;
    multiBackendClientFactory?: (
        backends: { name: string; url: string; apiKey?: string; enabled: boolean }[],
        userAgent: string
    ) => MultiBackendClient;
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
}

export interface DiscoverArgs {
    options: { silent?: boolean; configuration?: Record<string, unknown>; groupName?: string };
    token: vscode.CancellationToken;
    backends?: { name: string; url: string; apiKey?: string; enabled: boolean }[];
    session?: BackendSession;
    onModelsDiscovered?: () => void;
    onModernConfigurationDetected?: () => void;
}
