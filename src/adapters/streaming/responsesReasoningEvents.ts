import type { V2EmittedPart as EmittedPart } from "../../providers/v2Types";
import { Logger } from "../../utils/logger";
import { StructuredLogger } from "../../observability/structuredLogger";
import { diagnosticHash } from "./diagnosticHash";

/**
 * Real LiteLLM /responses reasoning event names.
 *
 * LiteLLM's bridge (litellm/responses/litellm_completion_transformation/
 * streaming_iterator.py) converts the chat delta's `reasoning_content` into
 * this OpenAI-native sequence for ANY non-OpenAI reasoning model (Anthropic
 * Fable, Z.ai GLM, DeepSeek, ...):
 *
 *   response.output_item.added         (item.type = "reasoning", id = rs_<uuid>)
 *   response.reasoning_summary_text.delta  (delta = thinking text)
 *   response.reasoning_summary_text.done   (text)
 *   response.reasoning_summary_part.done   (part = { type, text })
 *   response.output_item.done          (item.type = "reasoning", summary[],
 *                                       encrypted_content?/signature?)
 *
 * Native OpenAI reasoning models additionally emit response.reasoning_text.delta
 * for raw reasoning text. See GitHub issue #149 for why the previous handlers
 * (response.output_reasoning.delta, raw Anthropic content_block_*) never fired.
 */
export interface ResponsesReasoningState {
    /** Open reasoning item id from output_item.added; undefined once closed. */
    currentReasoningItemId: string | undefined;
    /** Display mode attached to deltas; mirrors the chat-path thinking contract. */
    currentThinkingDisplay: "summarized" | "omitted" | undefined;
}

export function createResponsesReasoningState(): ResponsesReasoningState {
    return {
        currentReasoningItemId: undefined,
        currentThinkingDisplay: undefined,
    };
}

/**
 * Optional correlation forwarded from the owning request. Kept structural
 * (not imported from the provider) so this adapter stays dependency-free;
 * the interpreter re-exports it for its own StreamingState.
 */
export interface StreamLogContext {
    requestId?: string;
    model?: string;
    endpoint?: string;
}

interface ReasoningAddedOrDoneItem {
    type?: unknown;
    id?: unknown;
    summary?: unknown;
    encrypted_content?: unknown;
    signature?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function isReasoningItem(item: unknown): item is ReasoningAddedOrDoneItem {
    const record = asRecord(item);
    return !!record && record.type === "reasoning";
}

/**
 * Interprets one /responses frame for reasoning purposes.
 *
 * Returns emitted thinking parts. Returns `[]` for frames this module does not
 * own (the caller must continue its own handling for those frames — notably
 * `output_item.added`/`output_item.done` with non-reasoning items, which the
 * interpreter's tool-call branches must still see).
 */
export function interpretResponsesReasoningEvent(
    json: unknown,
    state: ResponsesReasoningState,
    logContext?: StreamLogContext
): EmittedPart[] {
    const data = asRecord(json);
    if (!data || typeof data.type !== "string") {
        return [];
    }

    // Deltas: visible reasoning text → thinking parts. reasoning_text.delta is
    // the native OpenAI raw-reasoning alias; LiteLLM's bridge always uses
    // reasoning_summary_text.delta for non-OpenAI models.
    if (
        (data.type === "response.reasoning_summary_text.delta" || data.type === "response.reasoning_text.delta") &&
        typeof data.delta === "string" &&
        data.delta.length > 0
    ) {
        const metadata = state.currentThinkingDisplay ? { display: state.currentThinkingDisplay } : undefined;
        Logger.trace(`[responsesReasoning] Emitting thinking delta: ${data.delta.length} chars`);
        // Upstream identity (item_id/indices/sequence) is the only way to tie a
        // delta back to its owning reasoning item when triaging fragmented
        // thinking blocks — see the disjointed-Claude-reasoning investigation.
        StructuredLogger.trace(
            "stream.responses_reasoning_delta",
            {
                eventType: data.type,
                itemId: diagnosticHash(typeof data.item_id === "string" ? data.item_id : undefined),
                outputIndex: typeof data.output_index === "number" ? data.output_index : undefined,
                summaryIndex: typeof data.summary_index === "number" ? data.summary_index : undefined,
                sequenceNumber: typeof data.sequence_number === "number" ? data.sequence_number : undefined,
                openReasoningItemId: diagnosticHash(state.currentReasoningItemId),
                length: data.delta.length,
                display: state.currentThinkingDisplay,
            },
            logContext
        );
        return [{ type: "thinking", value: data.delta, metadata }];
    }

    // Terminal `.done` events for summary text: the visible text already
    // streamed via deltas. Emitting it again would duplicate the block.
    if (data.type === "response.reasoning_summary_text.done" || data.type === "response.reasoning_summary_part.done") {
        return [];
    }

    // Block open: record the reasoning item id. No part yet — VS Code opens the
    // collapsible thinking block from the first delta.
    if (data.type === "response.output_item.added" && isReasoningItem(data.item)) {
        state.currentReasoningItemId = typeof data.item.id === "string" ? data.item.id : undefined;
        Logger.debug("[responsesReasoning] Reasoning block opened", {
            itemId: diagnosticHash(state.currentReasoningItemId),
        });
        StructuredLogger.debug(
            "stream.responses_reasoning_block_opened",
            { itemId: diagnosticHash(state.currentReasoningItemId) },
            logContext
        );
        return [];
    }

    // Block close: emit the opaque continuity state as a metadata-only thinking
    // part so extractOpaqueThinkingBlock (src/utils.ts) can bind it back to the
    // adjacent visible deltas on the next request.
    if (data.type === "response.output_item.done" && isReasoningItem(data.item)) {
        const itemId = typeof data.item.id === "string" ? data.item.id : undefined;
        state.currentReasoningItemId = undefined;
        const encrypted = typeof data.item.encrypted_content === "string" ? data.item.encrypted_content : undefined;
        const signature = typeof data.item.signature === "string" ? data.item.signature : undefined;
        Logger.debug("[responsesReasoning] Reasoning block closed", { itemId: diagnosticHash(itemId) });
        StructuredLogger.debug(
            "stream.responses_reasoning_block_closed",
            { itemId: diagnosticHash(itemId), hasEncryptedContent: !!encrypted, hasSignature: !!signature },
            logContext
        );
        if (!encrypted && !signature) {
            // Visible text already streamed; no opaque state to preserve.
            return [];
        }
        const metadata: Record<string, unknown> = {};
        if (encrypted) {
            metadata.encrypted_content = encrypted;
        }
        if (signature) {
            metadata.signature = signature;
        }
        // Preserve the upstream id: native Responses reasoning cannot be replayed
        // with a synthesized id on the next turn.
        return [{ type: "thinking", value: "", id: itemId, metadata }];
    }

    // Not a reasoning event this module owns.
    return [];
}
