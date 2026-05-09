import type { LiteLLMClient } from "../adapters/litellmClient";

/**
 * Represents a resolved per-group connection context.
 * Holds everything needed to make requests to one LiteLLM backend.
 * Populated from either:
 *   - options.configuration (VS Code 1.119+ group system), OR
 *   - ConfigManager.resolveBackends() (legacy path)
 */
export interface BackendSession {
    /** Human-readable name (group name or backend name) */
    readonly backendName: string;
    /** Base URL of the LiteLLM proxy */
    readonly baseUrl: string;
    /** API key for authentication (undefined if not required) */
    readonly apiKey: string | undefined;
    /** HTTP client for making requests */
    readonly client: LiteLLMClient;
}
