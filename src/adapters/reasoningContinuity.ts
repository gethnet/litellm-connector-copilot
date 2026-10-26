import type { LiteLLMModelInfo, ResponsesReasoningItem } from "../types";

/** History carries only a session-bound opaque authorization identifier, never credentials. */
export interface ReasoningScope {
    model: string;
    backend: string;
    group?: string;
    authorization: string;
}

export const RESPONSES_REASONING_METADATA = "litellm_responses_reasoning";

export interface ResponsesReasoningEnvelope {
    version: 1;
    source: ReasoningScope;
    item: ResponsesReasoningItem;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/** OpenAI-compatible transport is not proof that its model implements native encrypted reasoning. */
export function isNativeResponsesModel(model: string, info?: LiteLLMModelInfo): boolean {
    const provider = info?.provider ?? info?.litellm_provider;
    if (provider === "chatgpt") {
        return true;
    }
    if (provider && provider !== "openai") {
        return false;
    }
    if (!provider && model.startsWith("chatgpt/")) {
        return true;
    }
    // Unknown aliases fail closed unless discovery provides a canonical OpenAI family.
    // In particular, `openai/mistral-*` and `gpt-oss-*` are not native Responses models.
    const canonical = info?.key ?? model;
    const family = canonical.replace(/^(?:openai|chatgpt)\/(?:responses\/)?/, "");
    const openAITransport = provider === "openai" || model.startsWith("openai/") || canonical.startsWith("openai/");
    return openAITransport && /^(?:gpt-\d|o[1-9]\d*(?:-|$))/.test(family);
}

export function createReasoningScope(
    model: string,
    backend: unknown,
    group?: string,
    authorization?: string
): ReasoningScope | undefined {
    if (!model || typeof backend !== "string" || !authorization) {
        return undefined;
    }
    try {
        const url = new URL(backend);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
            return undefined;
        }
        // Preserve the path: two groups at the same hostname need not share credentials/accounts.
        return { model, backend: url.href.replace(/\/+$/, ""), ...(group ? { group } : {}), authorization };
    } catch {
        return undefined;
    }
}

/** Validate and copy only protocol fields; never serialize arbitrary VS Code metadata upstream. */
export function readResponsesReasoningItem(value: unknown): ResponsesReasoningItem | undefined {
    const item = asRecord(value);
    if (
        !item ||
        item.type !== "reasoning" ||
        typeof item.id !== "string" ||
        !/^rs_[A-Za-z0-9_-]+$/.test(item.id) ||
        typeof item.encrypted_content !== "string" ||
        !item.encrypted_content ||
        !Array.isArray(item.summary)
    ) {
        return undefined;
    }
    const summary: ResponsesReasoningItem["summary"] = [];
    for (const value of item.summary) {
        const part = asRecord(value);
        if (!part || part.type !== "summary_text" || typeof part.text !== "string") {
            return undefined;
        }
        summary.push({ type: "summary_text", text: part.text });
    }
    const result: ResponsesReasoningItem = {
        type: "reasoning",
        id: item.id,
        summary,
        encrypted_content: item.encrypted_content,
    };
    if (item.status !== undefined) {
        if (item.status !== "completed" && item.status !== "incomplete" && item.status !== "in_progress") {
            return undefined;
        }
        result.status = item.status;
    }
    return result;
}

export function hasResponsesReasoningMetadata(part: unknown): boolean {
    const metadata = asRecord(asRecord(part)?.metadata);
    return !!metadata && Object.prototype.hasOwnProperty.call(metadata, RESPONSES_REASONING_METADATA);
}

export function extractResponsesReasoning(part: unknown, target?: ReasoningScope): ResponsesReasoningItem | undefined {
    const metadata = asRecord(asRecord(part)?.metadata);
    const envelope = asRecord(metadata?.[RESPONSES_REASONING_METADATA]);
    const source = asRecord(envelope?.source);
    if (
        !target ||
        envelope?.version !== 1 ||
        source?.model !== target.model ||
        source?.backend !== target.backend ||
        source?.group !== target.group ||
        !target.authorization ||
        source?.authorization !== target.authorization
    ) {
        return undefined;
    }
    return readResponsesReasoningItem(envelope.item);
}
