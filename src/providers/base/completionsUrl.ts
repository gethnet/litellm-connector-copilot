const TERMINAL_COMPLETIONS_PATH = /\/completions\/?$/i;

function normalizeUrl(value: string | undefined): string | undefined {
    const trimmed = value?.trim() ?? "";
    if (!/^https?:\/\//i.test(trimmed)) {
        return undefined;
    }

    return trimmed.replace(/\/+$/, "");
}

/**
 * Derives the OpenAI-compatible FIM endpoint from the configured LiteLLM group URL.
 * The configured path is authoritative: `/v1` is preserved when supplied and is
 * never inserted or removed by this helper.
 */
export function deriveCompletionsUrl(groupBaseUrl: string | undefined): string | undefined {
    const normalized = normalizeUrl(groupBaseUrl);
    if (!normalized) {
        return undefined;
    }

    return TERMINAL_COMPLETIONS_PATH.test(normalized) ? normalized : `${normalized}/completions`;
}

/**
 * Resolves model, group, and derived completion endpoints in upstream-compatible
 * priority order. Invalid explicit URLs are ignored so a valid lower-priority
 * endpoint can still advertise the model as inline-completion capable.
 */
export function resolveCompletionsUrl(
    groupBaseUrl: string | undefined,
    modelCompletionsUrl?: string,
    groupCompletionsUrl?: string
): string | undefined {
    return normalizeUrl(modelCompletionsUrl) ?? normalizeUrl(groupCompletionsUrl) ?? deriveCompletionsUrl(groupBaseUrl);
}
