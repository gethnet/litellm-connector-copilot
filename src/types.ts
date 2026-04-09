/**
 * OpenAI function-call entry emitted by assistant messages.
 */
export interface OpenAIToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}

/**
 * OpenAI function tool definition used to advertise tools.
 */
export interface OpenAIFunctionToolDef {
    type: "function";
    function: { name: string; description?: string; parameters?: object };
}

/**
 * Content item for vision/image support in OpenAI messages
 */
export interface OpenAIChatMessageContentItem {
    type: "text" | "image_url";
    text?: string;
    image_url?: {
        url: string;
    };
}

/**
 * OpenAI-style chat message used for router requests.
 */
export interface OpenAIChatMessage {
    role: OpenAIChatRole;
    content?: string | OpenAIChatMessageContentItem[];
    name?: string;
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
}

/**
 * Capability overrides for a single model.
 * Undefined fields are left at their auto-derived values.
 */
export interface ModelCapabilityOverride {
    /** Override the toolCalling capability reported to VS Code. */
    toolCalling?: boolean;
    /** Override the imageInput (vision) capability reported to VS Code. */
    imageInput?: boolean;
}

/**
 * LiteLLM model configuration parameters.
 */
export interface LiteLLMParams {
    custom_llm_provider?: string;
    litellm_credential_name?: string;
    use_in_pass_through?: boolean;
    use_litellm_proxy?: boolean;
    merge_reasoning_content_in_choices?: boolean;
    model?: string;
    tags?: string[];
}

/**
 * Configuration for a single LiteLLM proxy backend.
 * Multiple backends can be configured; each contributes models to the aggregated model list.
 */
export interface LiteLLMBackend {
    /** Human-readable label (e.g., "Cloud", "Local GPU", "Team Alpha"). */
    name: string;
    /** Base URL of the LiteLLM proxy (e.g., "http://localhost:4000"). */
    url: string;
    /**
     * Reference key into VS Code SecretStorage for the API key.
     * The actual secret is stored under "litellm-connector.apiKey.{apiKeySecretRef}".
     * Defaults to the backend name if not specified.
     */
    apiKeySecretRef?: string;
    /** Whether this backend is enabled. Defaults to true. */
    enabled?: boolean;
}

/**
 * Resolved backend with its API key, used internally for routing.
 */
export interface ResolvedBackend {
    name: string;
    url: string;
    apiKey?: string;
    enabled: boolean;
}

/**
 * LiteLLM configuration stored in VS Code settings.
 */
export interface LiteLLMConfig {
    /** Legacy single-backend base URL. Kept for backward compatibility. */
    url: string;
    /** Legacy single-backend API key. Kept for backward compatibility. */
    key?: string;

    /**
     * Multi-backend configuration. When populated, models from all enabled backends
     * are aggregated. Model IDs are prefixed with "{backendName}/".
     * Takes precedence over legacy url/key when non-empty.
     */
    backends?: LiteLLMBackend[];

    inactivityTimeout?: number;
    disableCaching?: boolean;
    /** Experimental: emit token usage metadata as a response data part for manual UI probing. */
    experimentalEmitUsageData?: boolean;
    disableQuotaToolRedaction?: boolean;
    modelOverrides?: Record<string, string[]>;
    /**
     * Per-model capability overrides exposed to VS Code.
     * Key is the Model ID (e.g. 'gpt-4o').
     * When set, overrides the auto-derived toolCalling / imageInput capabilities.
     */
    modelCapabilitiesOverrides?: Record<string, ModelCapabilityOverride>;
    /**
     * Optional: force a specific model id (e.g. for inline completions).
     * When unset, the provider uses the model selected by Copilot/VS Code.
     */
    modelIdOverride?: string;

    /** Enable VS Code inline completions backed by LiteLLM (stable API). */
    inlineCompletionsEnabled?: boolean;

    /** Model id to use for LiteLLM inline completions. */
    inlineCompletionsModelId?: string;

    /** Max context tokens to use for LiteLLM inline completions. */
    inlineCompletionsMaxContextTokens?: number;

    /** Model id to use for LiteLLM commit message generation. */
    commitModelIdOverride?: string;

    /** Experimental: enable V2 Chat Provider using proposed VS Code APIs. */
    v2ApiEnabled?: boolean;

    /** When enabled, send default values for temperature, frequency_penalty, and presence_penalty if not provided by VS Code. */
    sendDefaultParameters?: boolean;
}

/**
 * Detailed model information from LiteLLM proxy including capabilities and token constraints.
 */
export interface LiteLLMModelInfo {
    id?: string;
    db_model?: boolean;
    key?: string;
    max_tokens?: number;
    max_input_tokens?: number;
    max_output_tokens?: number;
    context_window_tokens?: number;
    litellm_provider?: string;
    mode?: string;
    supports_system_messages?: boolean | null;
    supports_response_schema?: boolean;
    supports_vision?: boolean;
    supports_function_calling?: boolean;
    supports_tool_choice?: boolean;
    supports_assistant_prefill?: boolean | null;
    supports_prompt_caching?: boolean;
    supports_audio_input?: boolean | null;
    supports_audio_output?: boolean | null;
    supports_pdf_input?: boolean;
    supports_embedding_image_input?: boolean | null;
    supports_native_streaming?: boolean | null;
    supports_web_search?: boolean | null;
    supports_url_context?: boolean | null;
    supports_reasoning?: boolean;
    supports_computer_use?: boolean | null;
    supported_openai_params?: string[];
    tags?: string[];
    [key: string]: unknown; // Allow additional fields for extensibility
}

/**
 * Single model entry from /model/info endpoint.
 */
export interface LiteLLMModelEntry {
    model_name: string;
    litellm_params?: LiteLLMParams;
    model_info?: LiteLLMModelInfo;
}

/**
 * Response envelope for LiteLLM /model/info endpoint.
 */
export interface LiteLLMModelInfoResponse {
    data: Array<{
        model_name?: string;
        model_info?: LiteLLMModelInfo;
    }>;
}

/**
 * Request for LiteLLM token counter endpoint.
 */
export interface LiteLLMTokenCounterRequest {
    model: string;
    prompt?: string;
    messages?: OpenAIChatMessage[];
    contents?: Record<string, unknown>[];
}

/**
 * Response from LiteLLM token counter endpoint.
 */
export interface LiteLLMTokenCounterResponse {
    token_count: number;
}

/**
 * OpenAI-style chat completion request.
 */
export interface OpenAIChatCompletionRequest {
    model: string;
    messages: OpenAIChatMessage[];
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    stop?: string | string[];
    tools?: OpenAIFunctionToolDef[];
    tool_choice?: string | object;
    /**
     * LiteLLM passthrough body.
     * Used for features like caching controls.
     *
     * Docs: https://docs.litellm.ai/docs/proxy/caching#no-cache
     */
    extra_body?: {
        cache?: {
            /** Skip cache check, get fresh response */
            "no-cache"?: boolean;
        };
        [key: string]: unknown;
    };
}

/**
 * LiteLLM /responses endpoint request.
 */
export interface LiteLLMResponsesRequest {
    model: string;
    input: (OpenAIChatMessageContentItem | LiteLLMResponseInputItem)[];
    instructions?: string;
    stream?: boolean;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    stop?: string | string[];
    tools?: LiteLLMResponseTool[];
    tool_choice?: string | object;
    /**
     * LiteLLM passthrough body.
     * Used for features like caching controls.
     */
    extra_body?: {
        cache?: {
            "no-cache"?: boolean;
        };
        [key: string]: unknown;
    };
}

/**
 * Input item for LiteLLM /responses endpoint.
 */
export type LiteLLMResponseInputItem =
    | { type: "message"; role: string; content: string }
    | { type: "function_call"; id: string; call_id?: string; name: string; arguments: string }
    | { type: "function_call_output"; id?: string; call_id: string; output: string };

/**
 * Tool definition for LiteLLM /responses endpoint.
 */
export interface LiteLLMResponseTool {
    type: "function";
    name: string;
    description: string;
    parameters: object;
}

/**
 * Transformed model item for internal use.
 */
export interface TransformedModelItem {
    id: string;
    object: string;
    created: number;
    owned_by: string;
    model_name: string;
    litellm_params?: LiteLLMParams;
    model_info?: LiteLLMModelInfo;
}

/**
 * Buffer used to accumulate streamed tool call parts until arguments are valid JSON.
 */
export interface ToolCallBuffer {
    id?: string;
    name?: string;
    args: string;
}

/** OpenAI-style chat roles. */
export type OpenAIChatRole = "system" | "user" | "assistant" | "tool";
