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
 * OpenAI-compatible breakdown of prompt token usage.
 */
export interface OpenAIUsagePromptTokenDetails {
    cached_tokens?: number;
    cache_creation_input_tokens?: number;
}

/**
 * OpenAI-compatible breakdown of completion token usage.
 * Extra fields like `tool_tokens` are preserved when upstream providers expose them.
 */
export interface OpenAIUsageCompletionTokenDetails {
    reasoning_tokens?: number;
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
    tool_tokens?: number;
}

/**
 * Usage payload emitted back to VS Code through a `LanguageModelDataPart`.
 * Required fields match the OpenAI usage object so VS Code's BYOK plumbing can parse it,
 * while optional fields carry richer budgeting diagnostics.
 */
export interface OpenAIUsagePayload {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: OpenAIUsagePromptTokenDetails;
    completion_tokens_details?: OpenAIUsageCompletionTokenDetails;
    system_prompt_tokens?: number;
    reserved_output_tokens?: number;
    total_token_max?: number;
    /** Estimated cost in USD attributed to input (prompt) tokens. */
    estimated_input_cost?: number;
    /** Estimated cost in USD attributed to output (completion) tokens. */
    estimated_output_cost?: number;
    /** Estimated total cost in USD (input + output + cache adjustments). */
    estimated_total_cost?: number;
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
    /** Override the reasoning capability (surfaced as tag). */
    reasoning?: boolean;
    /** Override the pdf input capability (surfaced as tag). */
    pdfInput?: boolean;
}

export type SupportedReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelOverride {
    /** Regex pattern to match model IDs */
    match: string;
    /** Override for supports_reasoning */
    supportsReasoning?: boolean | null;
    /** Override for supported reasoning efforts */
    reasoningEfforts?: SupportedReasoningEffort[];
    /** Default reasoning effort when reasoning is supported */
    defaultEffort?: SupportedReasoningEffort;
    /** Force this override to be mandatory (ignore remote LiteLLM values) */
    forceMandatory?: boolean;
    /** Custom tags to add to model */
    tags?: string[];
    /** Override for supported_openai_params */
    supportedOpenaiParams?: string[];
    /** Additional notes about this override */
    notes?: string;
}

/**
 * LiteLLM model configuration parameters.
 */
export interface LiteLLMParams {
    custom_llm_provider?: string;
    litellm_credential_name?: string;
    use_in_pass_through?: boolean;
    use_litellm_proxy?: boolean;
    /**
     * When true, merge OpenAI chat `delta.reasoning_content` into `delta.content` so the
     * reasoning text is surfaced inline with the assistant response instead of as a
     * separate thinking part. Defaults to `false` (emit as thinking).
     */
    merge_reasoning_content_in_choices?: boolean;
    model?: string;
    tags?: string[];
}

/**
 * LiteLLM workspace-level configuration. Backend connection details
 * (baseUrl, apiKey) are delivered by VS Code 1.120 per-group
 * `options.configuration` payloads on every provider call; they are NOT
 * stored in workspace settings. This type only carries workspace-scoped
 * ergonomic toggles and overrides.
 */
export interface LiteLLMConfig {
    inactivityTimeout?: number;
    disableCaching?: boolean;
    disableQuotaToolRedaction?: boolean;
    /**
     * Enable/disable the model override system.
     * When enabled, merged user and bundled model override rules are applied.
     * When disabled, only LiteLLM /model/info derived capabilities are used.
     * Default: true (backwards compatible).
     */
    enableModelOverrides?: boolean;
    /**
     * Per-model capability overrides exposed to VS Code.
     * Key is the Model ID (e.g. 'gpt-4o').
     * When set, overrides the auto-derived toolCalling / imageInput capabilities.
     */
    modelCapabilitiesOverrides?: Record<string, ModelCapabilityOverride>;
    /**
     * Optional: force a specific model id.
     * When unset, the provider uses the model selected by Copilot/VS Code.
     */
    modelIdOverride?: string;

    /** Model id to use for LiteLLM commit message generation. */
    commitModelIdOverride?: string;

    /**
     * When true, forces all models to use the `/responses` endpoint instead of per-model mode selection.
     * This ensures consistent behavior across models, especially for those that require reasoning support.
     * Default: false (opt-in, JSON-only, not in Settings UI).
     */
    forceResponsesEndpoint?: boolean;

    /**
     * When true and forceResponsesEndpoint is true, falls back to `/chat/completions` if `/responses` fails.
     * This is an escape hatch for models that cannot use /responses.
     * Default: false (JSON-only, not in Settings UI).
     */
    allowChatCompletionsFallback?: boolean;

    /** When true, show pricing data in the model picker hover (if available from /model/info). Default: true. */
    displayPricingInPicker?: boolean;

    /** Timeout in milliseconds for /model/info discovery requests. Default: 5000. */
    discoveryTimeoutMs?: number;

    /** TTL in milliseconds for cached /model/info discovery responses. Default: 60000. Set to 0 to disable caching. */
    discoveryCacheTtlMs?: number;

    /** Trailing-edge debounce window in milliseconds for outward model-discovery change notifications. Default: 250. */
    discoveryFireDebounceMs?: number;

    /** Minimum interval in milliseconds between outward model-discovery change notifications. Default: 2000. */
    discoveryFireMinIntervalMs?: number;

    // sendDefaultParameters was removed in v2.2.0 (deprecated v1.5.0). Use individual modelOptions instead.
}

/**
 * Connection-level configuration for a single LiteLLM proxy. Each
 * `LiteLLMClient` is bound to exactly one proxy and carries its baseUrl
 * and API key. The `disableCaching` flag is duplicated here so the client
 * can opt the connection itself out of `Cache-Control` headers without
 * needing access to the workspace-level `LiteLLMConfig`.
 */
export interface LiteLLMClientConfig {
    url: string;
    key?: string;
    disableCaching?: boolean;
    /** Timeout in milliseconds for /model/info discovery requests. Default: 5000. */
    discoveryTimeoutMs?: number;
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
    supports_reasoning?: boolean | null;
    supports_computer_use?: boolean | null;
    // Pricing fields (per-token costs, USD). Optional; absent when backend does not return pricing.
    input_cost_per_token?: number | null;
    output_cost_per_token?: number | null;
    cache_read_input_token_cost?: number | null;
    cache_creation_input_token_cost?: number | null;
    // Extended reasoning effort support fields from LiteLLM
    supports_none_reasoning_effort?: boolean | null;
    supports_minimal_reasoning_effort?: boolean | null;
    supports_low_reasoning_effort?: boolean | null;
    supports_medium_reasoning_effort?: boolean | null;
    supports_high_reasoning_effort?: boolean | null;
    supports_xhigh_reasoning_effort?: boolean | null;
    supports_max_reasoning_effort?: boolean | null;
    // Supported parameters array - must be validated before API calls
    supported_openai_params?: string[] | null;
    // Modalities for advanced capability detection
    modalities?: string[];
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
    data: {
        model_name?: string;
        model_info?: LiteLLMModelInfo;
    }[];
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
    stream_options?: { include_usage?: boolean };
    /**
     * OpenAI-compatible reasoning effort hint accepted by LiteLLM in flat top-level
     * snake_case form on both `/chat/completions` and `/responses`. LiteLLM translates
     * this to the appropriate provider-specific shape internally (e.g. nested
     * `reasoning.effort` for the OpenAI Responses API, Anthropic-specific thinking
     * config, etc.). We deliberately use this single canonical format so the connector
     * never has to reason about per-provider request shaping.
     *
     * Two shapes are accepted:
     *  - string: "minimal" | "low" | "medium" | "high" | "xhigh"
     *  - object: { effort: "low" | "medium" | "high"; summary?: "auto" | "concise" | "detailed" }
     *    — used by `gpt-5.4+` when callers want to control the summary text returned
     *    alongside the reasoning text.
     *
     * When omitted, LiteLLM falls back to the upstream model's default. We never
     * attach this field unless the user has explicitly selected an effort level via
     * the model picker or modelOptions override.
     */
    reasoning_effort?: string | { effort: string; summary?: string };
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
     * Mirror of `OpenAIChatCompletionRequest.reasoning_effort` — LiteLLM accepts the
     * same flat snake_case key on `/responses`, so we propagate it unchanged from
     * the canonical chat-shaped request body during transformation. Accepts the
     * same string-or-object shape as the chat-shaped request — see that field for
     * details.
     */
    reasoning_effort?: string | { effort: string; summary?: string };
    stream_options?: { include_usage?: boolean };
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
    | {
          type: "message";
          role: string;
          content: string | OpenAIChatMessageContentItem[];
      }
    | { type: "function_call"; id: string; call_id?: string; name: string; arguments: string }
    | { type: "function_call_output"; id?: string; call_id: string; output: string }
    | {
          /**
           * Carries an Anthropic `thinking` or `redacted_thinking` block back
           * to the model. `encrypted_content` is the signature (or the opaque
           * redacted data) that the API uses to verify reasoning continuity
           * across turns. `summary` carries the human-readable thinking text
           * (empty for redacted blocks).
           */
          type: "reasoning";
          id: string;
          summary: { type: "summary_text"; text: string }[];
          encrypted_content: string;
      };

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
