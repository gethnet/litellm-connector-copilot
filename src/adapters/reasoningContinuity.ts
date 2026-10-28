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

export type ReasoningReplayPolicy = "native" | "bridge" | "omit";

/** Internal, request-local decision shared by conversion, wire projection and stream capture. */
export interface ReasoningRequestContext {
    policy: ReasoningReplayPolicy;
    scope?: ReasoningScope;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/** OpenAI-compatible transport alone cannot distinguish native OpenAI from third-party bridges. */
function hasNativeResponsesProvenance(model: string, info?: LiteLLMModelInfo): boolean {
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

/**
 * Requires an explicit `supports_reasoning: true` from the model card, not a model-name list.
 * Derived hints are deliberately ignored: LiteLLM lists `reasoning_effort` in
 * `supported_openai_params` for non-reasoning models too (gpt-4o, gpt-4.1, gpt-3.5), so it
 * cannot gate `include: reasoning.encrypted_content`. Unknown support fails closed.
 */
export function isNativeResponsesModel(model: string, info?: LiteLLMModelInfo): boolean {
    return hasNativeResponsesProvenance(model, info) && info?.supports_reasoning === true;
}

export function resolveReasoningReplayPolicy(model: string, info?: LiteLLMModelInfo): ReasoningReplayPolicy {
    if (!hasNativeResponsesProvenance(model, info)) {
        return "bridge";
    }
    // A native model without proven reasoning support must not fall back to synthetic bridge IDs.
    return isNativeResponsesModel(model, info) ? "native" : "omit";
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

/** Structural thinking ID, not proof of native provenance; text parts are excluded by callers. */
export function thinkingPartId(part: unknown): string | undefined {
    const record = asRecord(part);
    return record && "value" in record && typeof record.id === "string" ? record.id : undefined;
}

/** Unscoped validation for token counting. Only extractResponsesReasoning authorizes replay. */
export function readResponsesReasoningEnvelope(
    part: unknown
): { version: 1; source: unknown; item: ResponsesReasoningItem } | undefined {
    const metadata = asRecord(asRecord(part)?.metadata);
    const envelope = asRecord(metadata?.[RESPONSES_REASONING_METADATA]);
    if (envelope?.version !== 1) {
        return undefined;
    }
    const item = readResponsesReasoningItem(envelope.item);
    return item ? { version: 1, source: envelope.source, item } : undefined;
}

export function extractResponsesReasoning(part: unknown, target?: ReasoningScope): ResponsesReasoningItem | undefined {
    const envelope = readResponsesReasoningEnvelope(part);
    const source = asRecord(envelope?.source);
    if (
        !target ||
        !envelope ||
        source?.model !== target.model ||
        source?.backend !== target.backend ||
        source?.group !== target.group ||
        !target.authorization ||
        source?.authorization !== target.authorization
    ) {
        return undefined;
    }
    return envelope.item;
}
