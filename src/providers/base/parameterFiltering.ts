import type { LiteLLMModelInfo } from "../../types";

/**
 * Static fallback parameter limitations for known model families.
 * Used as fallback when model info (supported_openai_params) is unavailable.
 * These are prefix matches - if modelId includes the key, the limitation applies.
 */
export const KNOWN_PARAMETER_LIMITATIONS: Record<string, Set<string>> = {
    "claude-3-5-sonnet": new Set(["temperature"]),
    "claude-3-5-haiku": new Set(["temperature"]),
    "claude-3-opus": new Set(["temperature"]),
    "claude-3-sonnet": new Set(["temperature"]),
    "claude-3-haiku": new Set(["temperature"]),
    "claude-haiku-4-5": new Set(["temperature"]),
    "gpt-5.1-codex": new Set(["temperature", "frequency_penalty", "presence_penalty"]),
    "gpt-5.1-codex-mini": new Set(["temperature", "frequency_penalty", "presence_penalty"]),
    "gpt-5.1-codex-max": new Set(["temperature", "frequency_penalty", "presence_penalty"]),
    "codex-mini-latest": new Set(["temperature", "frequency_penalty", "presence_penalty"]),
    "o1-": new Set(["temperature", "top_p", "presence_penalty", "frequency_penalty"]),
    "gpt-5": new Set(["temperature", "top_p", "presence_penalty", "frequency_penalty"]),
};

/**
 * Parameters the detector treats as "restrictable" — i.e. when a model's
 * `supported_openai_params` is present but does NOT list one of these,
 * we strip it. Non-restrictable parameters are left in place when absent
 * from the supported list (preserves legacy lenient behavior).
 */
const RESTRICTABLE_PARAMS: ReadonlySet<string> = new Set([
    "temperature",
    "top_p",
    "presence_penalty",
    "frequency_penalty",
    "stop",
    "reasoning_effort",
    "tool_choice",
    "cache",
]);

/**
 * Decides whether a given OpenAI parameter can be sent to a model.
 *
 * Source of truth: the `supported_openai_params` array on the model's
 * `LiteLLMModelInfo` (from discovery, including opt-in modelOverrides).
 * There is no probe cache here — the registry's per-model capability data
 * is authoritative and re-validated on every discovery call.
 *
 * Resolution order:
 * 1. `modelInfo.supported_openai_params` present (including user overrides):
 *      - empty array → unsupported (model reports "supports nothing").
 *      - param listed → supported.
 *      - param absent and restrictable → unsupported.
 *      - param absent and non-restrictable → supported (lenient).
 *    Explicit model-info lists win over static family denylists so corrected
 *    gateway cards / `supportedOpenaiParams` overrides can re-enable params.
 * 2. Exact-id `KNOWN_PARAMETER_LIMITATIONS` match → unsupported.
 * 3. Prefix `KNOWN_PARAMETER_LIMITATIONS` match → unsupported.
 * 4. No model-info list and no static match → supported (openai-compatible default).
 */
export function isParameterSupported(
    param: string,
    modelInfo: LiteLLMModelInfo | undefined,
    modelId?: string
): boolean {
    if (modelInfo?.supported_openai_params) {
        const supportedParams = modelInfo.supported_openai_params;
        const normalizedParam = param.toLowerCase();
        const isSupported = supportedParams.some((p) => p.toLowerCase() === normalizedParam);

        if (supportedParams.length === 0) {
            return false;
        }

        if (!isSupported) {
            return !isRestrictableParam(param);
        }
        return true;
    }

    if (modelId) {
        if (KNOWN_PARAMETER_LIMITATIONS[modelId]?.has(param)) {
            return false;
        }
        for (const [knownModel, limitations] of Object.entries(KNOWN_PARAMETER_LIMITATIONS)) {
            if (modelId.includes(knownModel) && limitations.has(param)) {
                return false;
            }
        }
    }

    return true;
}

/** True when `param` is in the restrictable set (case-insensitive). */
export function isRestrictableParam(param: string): boolean {
    return RESTRICTABLE_PARAMS.has(param.toLowerCase());
}

/**
 * Removes parameters the model does not support from an OpenAI-compatible
 * request body, in place. Covers the standard scalar params plus LiteLLM's
 * cache-bypass (`extra_body.cache`), which is retained only when the model
 * explicitly supports the `cache` parameter.
 */
export function stripUnsupportedParametersFromRequest(
    requestBody: Record<string, unknown>,
    modelInfo: LiteLLMModelInfo | undefined,
    modelId?: string
): void {
    const paramsToCheck = [
        "temperature",
        "stop",
        "frequency_penalty",
        "presence_penalty",
        "top_p",
        "no_cache",
        "no-cache",
        "tool_choice", // Added for GPT-5.6 Azure and similar models that don't support tool_choice
    ];
    for (const p of paramsToCheck) {
        if (!isParameterSupported(p, modelInfo, modelId) && p in requestBody) {
            delete requestBody[p];
        }
    }

    // LiteLLM's cache bypass is carried only by extra_body.cache. It is
    // retained when the model explicitly supports the cache parameter.
    delete requestBody.cache;
    if (requestBody.extra_body && typeof requestBody.extra_body === "object") {
        const extraBody = requestBody.extra_body as Record<string, unknown>;
        if (!isParameterSupported("cache", modelInfo, modelId)) {
            delete extraBody.cache;
        }
        if (Object.keys(extraBody).length === 0) {
            delete requestBody.extra_body;
        }
    }
}
