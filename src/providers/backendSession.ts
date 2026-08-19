import type { LiteLLMClient } from "../adapters/litellmClient";

/**
 * Represents a resolved per-group connection context.
 * Holds everything needed to make requests to one LiteLLM backend.
 * Populated from VS Code per-group `options.configuration` (VS Code 1.120+).
 */
export interface BackendSession {
    /** Human-readable name (group name or backend name) */
    readonly backendName: string;
    /** Base URL of the LiteLLM proxy */
    readonly baseUrl: string;
    /** API key for authentication (undefined if not required) */
    readonly apiKey: string | undefined;
    /** Optional full OpenAI-compatible FIM endpoint for this provider group. */
    readonly completionsUrl?: string;
    /** HTTP client for making requests */
    readonly client: LiteLLMClient;
}
