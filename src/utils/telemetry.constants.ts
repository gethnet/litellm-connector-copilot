/**
 * Telemetry constants and configuration for PostHog integration.
 */

// PostHog API Key - Hard-coded as per plan
export const POSTHOG_API_KEY = "phc_OJr5j3sxq9AX6YglCd9NMP4HlwchYwBa53n8Jz44jkp";
export const POSTHOG_HOST = "https://us.i.posthog.com";

// Sampling configuration
export const TELEMETRY_WARN_SAMPLE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const TELEMETRY_WARN_SAMPLE_THRESHOLD = 10; // Every 10th warn after first

// Event Names
export const EVENTS = {
    REQUEST_STARTED: "request.started",
    REQUEST_VALIDATED: "request.validated",
    REQUEST_TRIMMED: "request.trimmed",
    REQUEST_FILTERED: "request.filtered",
    REQUEST_COMPLETED: "request.completed",
    TOKENS_ESTIMATED: "tokens.estimated",
    HTTP_REQUEST_SENT: "http.request.sent",
    HTTP_RESPONSE_RECEIVED: "http.response.received",
    RESPONSE_STREAMED: "response.streamed",
    ERROR_CAUGHT: "error.caught",
    PERFORMANCE_METRICS: "performance.metrics",
} as const;

// Feature Flags (Properties)
export const FEATURE_FLAGS = {
    USED_CHAT_API: "used_chat_api",
    USED_COMPLETIONS_API: "used_completions_api",
    USED_RESPONSES_ENDPOINT: "used_responses_endpoint",
    TOOL_CALLS_ENABLED: "tool_calls_enabled",
    TOOL_CALLS_INVOKED: "tool_calls_invoked",
    USED_INLINE_COMPLETIONS: "used_inline_completions",
} as const;
