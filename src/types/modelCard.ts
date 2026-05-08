/**
 * LiteLLM model card types - represents data from /model/{model_name} endpoint
 */

/**
 * Represents the full model card data from LiteLLM /model/{model_name} endpoint.
 */
export interface LiteLLMModelCard {
    model_name: string;
    model_info: LiteLLMModelInfoCard;
    litellm_params: Record<string, unknown>;
    provider: string;
    input_cost: string;
    output_cost: string;
    max_tokens: number;
    max_input_tokens: number;
}

/**
 * Model info subset from the model card, focused on capabilities relevant for request building.
 */
export interface LiteLLMModelInfoCard {
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
    max_input_tokens?: number;
    max_output_tokens?: number;
    supports_minimal_reasoning_effort?: boolean;
    supports_low_reasoning_effort?: boolean;
    supports_xlow_reasoning_effort?: boolean;
    supports_high_reasoning_effort?: boolean;
    supports_xhigh_reasoning_effort?: boolean;
    [key: string]: unknown;
}

/**
 * Subset of model info relevant for request building.
 * This is a clean internal representation used throughout the codebase.
 */
export interface ModelFeatureCapabilities {
    /** Supported OpenAI parameters for this model */
    supportedParams: Set<string>;

    /** Whether model supports system messages */
    supportsSystemMessages: boolean;

    /** Whether model supports vision/image input */
    supportsVision: boolean;

    /** Whether model supports tool calling */
    supportsTools: boolean;

    /** Whether model supports reasoning/thinking */
    supportsReasoning: boolean;

    /** Whether model supports prompt caching */
    supportsPromptCaching: boolean;

    /** Whether model supports native streaming */
    supportsNativeStreaming: boolean;

    /** Whether model supports structured output / response_schema */
    supportsResponseSchema: boolean;

    /** Max input tokens */
    maxInputTokens: number;

    /** Max output tokens */
    maxOutputTokens: number;

    /** Supported reasoning effort levels (if reasoning supported) */
    supportedReasoningEfforts?: ("minimal" | "low" | "high")[];
}
