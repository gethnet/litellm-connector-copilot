import * as vscode from "vscode";
import { countTokens } from "../tokenUtils";
import type {
    LiteLLMModelInfo,
    OpenAIUsageCompletionTokenDetails,
    OpenAIUsagePayload,
    OpenAIUsagePromptTokenDetails,
} from "../../types";
import { calculateRequestCost, extractPricing, type RequestCost } from "../../utils/pricingCalculator";

/**
 * Snapshot of all tracked token counts for a single request.
 * Values prefer upstream usage when available; fall back to internal counting.
 */
export interface TokenSnapshot {
    // Input side
    promptTokens: number;
    cachedTokens: number;
    cacheCreationInputTokens: number;
    systemPromptTokens: number;

    // Output side
    completionTokens: number;
    reasoningTokens: number;
    toolTokens: number;
    acceptedPredictionTokens: number;
    rejectedPredictionTokens: number;

    // Metadata
    sawUpstreamUsage: boolean;

    // Pricing-aware cost estimation (USD). Zero when pricing unavailable.
    estimatedInputCost?: number;
    estimatedOutputCost?: number;
    estimatedTotalCost?: number;
}

/**
 * Wraps a Progress<LanguageModelResponsePart> to capture token counts from
 * every part that flows through, regardless of endpoint (/chat/completions
 * or /responses). Accumulates internal counts during streaming and merges
 * with upstream usage when available.
 *
 * Usage:
 *   const capture = new StreamTokenCapture(modelId, innerProgress, modelInfo);
 *   // pass capture.progress wherever you'd pass progress
 *   await sendRequest(..., capture.progress, ...);
 *   const snapshot = capture.getSnapshot();
 */
export class StreamTokenCapture {
    private readonly _inner: vscode.Progress<vscode.LanguageModelResponsePart>;
    private _modelId: string;
    private _modelInfo?: LiteLLMModelInfo;
    private _pricing: ReturnType<typeof extractPricing>;

    // Accumulated internal counts (populated during streaming)
    private _textBuffer = "";
    private _reasoningBuffer = "";
    private _toolCallTokens = 0;

    // Upstream usage (from DataPart or response.completed)
    private _sawUpstreamUsage = false;
    private _upstream?: OpenAIUsagePayload;

    // Pre-computed input token estimates (set by caller before request)
    private _estimatedPromptTokens = 0;
    private _estimatedSystemPromptTokens = 0;

    // Enrichment context (injected by caller for the usage DataPart pass-through)
    private _reservedOutputTokens?: number;
    private _totalTokenMax?: number;

    constructor(
        modelId: string,
        inner: vscode.Progress<vscode.LanguageModelResponsePart>,
        modelInfo?: LiteLLMModelInfo
    ) {
        this._modelId = modelId;
        this._inner = inner;
        this._modelInfo = modelInfo;
        this._pricing = extractPricing(modelInfo);
    }

    public setModelInfo(modelId: string, modelInfo?: LiteLLMModelInfo): void {
        this._modelInfo = modelInfo;
        this._pricing = extractPricing(modelInfo);
        this._modelId = modelId;
    }

    // ── Input-side configuration (call before sending the request) ──

    setEstimatedPromptTokens(count: number): void {
        this._estimatedPromptTokens = count;
    }

    setEstimatedSystemPromptTokens(count: number): void {
        this._estimatedSystemPromptTokens = count;
    }

    setReservedOutputTokens(tokens: number): void {
        this._reservedOutputTokens = tokens;
    }

    setTotalTokenMax(tokens: number): void {
        this._totalTokenMax = tokens;
    }

    // ── The wrapped progress (pass this to sendRequest*) ──

    get progress(): vscode.Progress<vscode.LanguageModelResponsePart> {
        return { report: (part) => this._intercept(part) };
    }

    // ── Snapshot (call after stream completes) ──

    getSnapshot(): TokenSnapshot {
        const hasUpstream = this._sawUpstreamUsage && this._upstream !== undefined;
        const promptDetails: OpenAIUsagePromptTokenDetails | undefined = this._upstream?.prompt_tokens_details;
        const completionDetails: OpenAIUsageCompletionTokenDetails | undefined =
            this._upstream?.completion_tokens_details;

        const snapshot: TokenSnapshot = {
            // Input — prefer upstream, fall back to pre-computed estimate
            promptTokens: this._upstream?.prompt_tokens ?? this._estimatedPromptTokens,
            cachedTokens: promptDetails?.cached_tokens ?? 0,
            cacheCreationInputTokens: promptDetails?.cache_creation_input_tokens ?? 0,
            systemPromptTokens: this._upstream?.system_prompt_tokens ?? this._estimatedSystemPromptTokens,

            // Output — prefer upstream, fall back to internal accumulation
            completionTokens:
                this._upstream?.completion_tokens ?? countTokens(this._textBuffer, this._modelId, this._modelInfo),
            reasoningTokens:
                completionDetails?.reasoning_tokens ??
                countTokens(this._reasoningBuffer, this._modelId, this._modelInfo),
            toolTokens: completionDetails?.tool_tokens ?? (this._toolCallTokens > 0 ? this._toolCallTokens : 0),
            acceptedPredictionTokens: completionDetails?.accepted_prediction_tokens ?? 0,
            rejectedPredictionTokens: completionDetails?.rejected_prediction_tokens ?? 0,

            sawUpstreamUsage: hasUpstream,
        };

        const cost: RequestCost = calculateRequestCost({
            promptTokens: snapshot.promptTokens,
            completionTokens: snapshot.completionTokens,
            cachedTokens: snapshot.cachedTokens,
            cacheCreationInputTokens: snapshot.cacheCreationInputTokens,
            pricing: this._pricing,
        });
        if (this._pricing) {
            snapshot.estimatedInputCost = cost.inputCost;
            snapshot.estimatedOutputCost = cost.outputCost;
            snapshot.estimatedTotalCost = cost.totalCost;
        }

        return snapshot;
    }

    // ── Flush usage data (call after stream completes if no upstream usage was seen) ──

    /**
     * Emits a usage DataPart to VS Code if no upstream usage was seen during streaming.
     * This ensures usage data is always reported, even for providers that don't send
     * usage in their streaming response.
     *
     * Should be called after the stream completes and before getSnapshot().
     */
    flushUsage(): void {
        if (this._sawUpstreamUsage) {
            // Usage was already sent during streaming (enriched by _handleUsageDataPart)
            return;
        }

        // Build usage payload from accumulated counts
        const snapshot = this.getSnapshot();

        // Don't emit usage if there's no meaningful token usage (empty stream)
        // Check if any actual tokens were generated (not just estimated prompt tokens)
        if (snapshot.completionTokens === 0 && snapshot.toolTokens === 0 && snapshot.reasoningTokens === 0) {
            // No output tokens generated, don't emit usage
            return;
        }

        // For completion_tokens, use the max of text tokens and tool tokens
        // This handles cases where only tool calls are streamed (no text)
        const completionTokens = Math.max(snapshot.completionTokens, snapshot.toolTokens);

        const usagePayload: OpenAIUsagePayload = {
            prompt_tokens: snapshot.promptTokens,
            completion_tokens: completionTokens,
            total_tokens: snapshot.promptTokens + completionTokens,
        };

        // Add prompt token details if we have them
        const promptTokenDetails: OpenAIUsagePromptTokenDetails = {};
        if (snapshot.cachedTokens > 0) {
            promptTokenDetails.cached_tokens = snapshot.cachedTokens;
        }
        if (snapshot.cacheCreationInputTokens > 0) {
            promptTokenDetails.cache_creation_input_tokens = snapshot.cacheCreationInputTokens;
        }
        if (Object.keys(promptTokenDetails).length > 0) {
            usagePayload.prompt_tokens_details = promptTokenDetails;
        }

        // Add completion token details if we have them
        const completionTokenDetails: OpenAIUsageCompletionTokenDetails = {};
        if (snapshot.reasoningTokens > 0) {
            completionTokenDetails.reasoning_tokens = snapshot.reasoningTokens;
        }
        if (snapshot.toolTokens > 0) {
            completionTokenDetails.tool_tokens = snapshot.toolTokens;
        }
        if (snapshot.acceptedPredictionTokens > 0) {
            completionTokenDetails.accepted_prediction_tokens = snapshot.acceptedPredictionTokens;
        }
        if (snapshot.rejectedPredictionTokens > 0) {
            completionTokenDetails.rejected_prediction_tokens = snapshot.rejectedPredictionTokens;
        }
        if (Object.keys(completionTokenDetails).length > 0) {
            usagePayload.completion_tokens_details = completionTokenDetails;
        }

        // Add optional fields
        if (snapshot.systemPromptTokens > 0) {
            usagePayload.system_prompt_tokens = snapshot.systemPromptTokens;
        }
        if (this._reservedOutputTokens !== undefined) {
            usagePayload.reserved_output_tokens = this._reservedOutputTokens;
        }
        if (this._totalTokenMax !== undefined) {
            usagePayload.total_token_max = this._totalTokenMax;
        }

        if (snapshot.estimatedInputCost !== undefined) {
            usagePayload.estimated_input_cost = snapshot.estimatedInputCost;
        }
        if (snapshot.estimatedOutputCost !== undefined) {
            usagePayload.estimated_output_cost = snapshot.estimatedOutputCost;
        }
        if (snapshot.estimatedTotalCost !== undefined) {
            usagePayload.estimated_total_cost = snapshot.estimatedTotalCost;
        }

        // Emit the usage DataPart
        const payloadJson = JSON.stringify(usagePayload);
        const payloadBytes = new TextEncoder().encode(payloadJson);
        this._inner.report(new vscode.LanguageModelDataPart(payloadBytes, "usage"));
    }

    // ── Internal: intercept every part ──

    private _intercept(part: vscode.LanguageModelResponsePart): void {
        // Thinking must be detected BEFORE TextPart because the /responses path
        // falls back to TextPart("*text*") on older VS Code hosts. If we check
        // TextPart first, the thinking text (with "*" wrappers) would be
        // counted as raw completion tokens and never reach reasoning.
        if (this._isThinkingPart(part)) {
            const value = this._extractThinkingValue(part);
            this._reasoningBuffer += value;
            // Also count in text buffer for total completion tokens
            this._textBuffer += value;
        }
        // Text → accumulate for completion token estimation
        else if (part instanceof vscode.LanguageModelTextPart) {
            this._textBuffer += part.value;
        }
        // Tool calls → estimate tokens from name + args
        else if (part instanceof vscode.LanguageModelToolCallPart) {
            const toolText = `${part.name}${JSON.stringify(part.input ?? {})}`;
            this._toolCallTokens += countTokens(toolText, this._modelId, this._modelInfo);
        }
        // Usage DataPart → capture upstream usage, enrich, and forward
        else if (part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage") {
            this._handleUsageDataPart(part);
            return; // _handleUsageDataPart forwards enriched part itself
        }

        // Forward every part to the inner progress
        this._inner.report(part);
    }

    private _handleUsageDataPart(part: vscode.LanguageModelDataPart): void {
        try {
            const parsed = JSON.parse(Buffer.from(part.data).toString("utf-8")) as OpenAIUsagePayload;
            this._sawUpstreamUsage = true;

            // Monotonic merge: when upstream sends multiple usage frames (e.g. mid-stream
            // + final), pick Math.max to avoid regressing counts. Mirrors the legacy
            // mergeUsagePayloadWithLastKnown logic from the chat provider.
            this._upstream = this._upstream ? this._mergeMonotonic(this._upstream, parsed) : parsed;

            // Enrich with internal estimates for missing fields
            const completionDetails: OpenAIUsageCompletionTokenDetails = {
                ...(this._upstream.completion_tokens_details ?? {}),
            };
            if (completionDetails.tool_tokens === undefined && this._toolCallTokens > 0) {
                completionDetails.tool_tokens = this._toolCallTokens;
            }
            if (completionDetails.reasoning_tokens === undefined && this._reasoningBuffer.length > 0) {
                completionDetails.reasoning_tokens = countTokens(this._reasoningBuffer, this._modelId, this._modelInfo);
            }

            const promptDetails: OpenAIUsagePromptTokenDetails | undefined = this._upstream.prompt_tokens_details;
            const completionCount =
                this._upstream.completion_tokens ?? countTokens(this._textBuffer, this._modelId, this._modelInfo);
            const promptCount = this._upstream.prompt_tokens ?? this._estimatedPromptTokens;

            const enriched: OpenAIUsagePayload = {
                ...this._upstream,
                completion_tokens: completionCount,
                total_tokens: promptCount + completionCount,
                system_prompt_tokens:
                    this._upstream.system_prompt_tokens ?? (this._estimatedSystemPromptTokens || undefined),
                prompt_tokens_details: promptDetails,
                completion_tokens_details: Object.keys(completionDetails).length > 0 ? completionDetails : undefined,
                reserved_output_tokens: this._upstream.reserved_output_tokens ?? this._reservedOutputTokens,
                total_token_max: this._upstream.total_token_max ?? this._totalTokenMax,
            };

            const cost: RequestCost = calculateRequestCost({
                promptTokens: enriched.prompt_tokens ?? 0,
                completionTokens: enriched.completion_tokens ?? 0,
                cachedTokens: enriched.prompt_tokens_details?.cached_tokens ?? 0,
                cacheCreationInputTokens: enriched.prompt_tokens_details?.cache_creation_input_tokens ?? 0,
                pricing: this._pricing,
            });
            enriched.estimated_input_cost = cost.inputCost;
            enriched.estimated_output_cost = cost.outputCost;
            enriched.estimated_total_cost = cost.totalCost;

            // Re-encode and forward the enriched usage
            const enrichedBytes = new TextEncoder().encode(JSON.stringify(enriched));
            this._inner.report(new vscode.LanguageModelDataPart(enrichedBytes, "usage"));
        } catch {
            // Malformed usage — forward as-is
            this._inner.report(part);
        }
    }

    /**
     * Monotonic merge: when upstream sends multiple usage frames, pick the larger
     * value for each field to avoid regressing counts mid-stream.
     */
    private _mergeMonotonic(prev: OpenAIUsagePayload, next: OpenAIUsagePayload): OpenAIUsagePayload {
        const pick = (a?: number, b?: number): number | undefined => {
            if (typeof a === "number" && typeof b === "number") {
                return Math.max(a, b);
            }
            return typeof a === "number" ? a : b;
        };

        const promptTokens = pick(prev.prompt_tokens, next.prompt_tokens) ?? 0;
        const completionTokens = pick(prev.completion_tokens, next.completion_tokens) ?? 0;

        return {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            system_prompt_tokens: pick(prev.system_prompt_tokens, next.system_prompt_tokens),
            prompt_tokens_details: {
                cached_tokens: pick(
                    prev.prompt_tokens_details?.cached_tokens,
                    next.prompt_tokens_details?.cached_tokens
                ),
                cache_creation_input_tokens: pick(
                    prev.prompt_tokens_details?.cache_creation_input_tokens,
                    next.prompt_tokens_details?.cache_creation_input_tokens
                ),
            },
            completion_tokens_details: {
                reasoning_tokens: pick(
                    prev.completion_tokens_details?.reasoning_tokens,
                    next.completion_tokens_details?.reasoning_tokens
                ),
                tool_tokens: pick(
                    prev.completion_tokens_details?.tool_tokens,
                    next.completion_tokens_details?.tool_tokens
                ),
                accepted_prediction_tokens: pick(
                    prev.completion_tokens_details?.accepted_prediction_tokens,
                    next.completion_tokens_details?.accepted_prediction_tokens
                ),
                rejected_prediction_tokens: pick(
                    prev.completion_tokens_details?.rejected_prediction_tokens,
                    next.completion_tokens_details?.rejected_prediction_tokens
                ),
            },
            reserved_output_tokens: prev.reserved_output_tokens ?? next.reserved_output_tokens,
            total_token_max: prev.total_token_max ?? next.total_token_max,
        };
    }

    // ── ThinkingPart detection (handles both real ThinkingPart and "*text*" fallback) ──

    private _isThinkingPart(part: vscode.LanguageModelResponsePart): boolean {
        // Real ThinkingPart (VS Code proposed API)
        const ThinkingPart = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart;
        if (ThinkingPart && part instanceof (ThinkingPart as new (...args: unknown[]) => unknown)) {
            return true;
        }
        // The /responses path emits reasoning as TextPart("*text*") on older VS Code — detect that pattern
        if (part instanceof vscode.LanguageModelTextPart) {
            const v = part.value;
            return v.startsWith("*") && v.endsWith("*") && v.length > 2;
        }
        return false;
    }

    private _extractThinkingValue(part: vscode.LanguageModelResponsePart): string {
        // Real ThinkingPart value
        const tp = part as unknown as { value: string | string[] };
        if (Array.isArray(tp.value)) {
            return tp.value.join("");
        }
        const v = tp.value as string;
        // Strip the "*" wrapper from /responses path fallback
        if (v.startsWith("*") && v.endsWith("*")) {
            return v.slice(1, -1);
        }
        return v;
    }
}
