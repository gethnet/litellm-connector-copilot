import type * as vscode from "vscode";
import type { LiteLLMModelInfo } from "../types";

function positiveTokenLimit(value: number, label: string): number {
    if (!Number.isFinite(value) || value < 1) {
        throw new Error(`Invalid ${label} token limit.`);
    }
    return Math.floor(value);
}

/** Normalize a local wire output cap; never change discovered model limits. */
export function resolveRequestOutputCap(
    model: Pick<vscode.LanguageModelChatInformation, "maxOutputTokens">,
    requestedMaxTokens?: unknown,
    modelInfo?: LiteLLMModelInfo
): number {
    const hostMaximum = positiveTokenLimit(model.maxOutputTokens, "model output");
    const rawMaximum =
        modelInfo?.max_output_tokens === null || modelInfo?.max_output_tokens === undefined
            ? undefined
            : positiveTokenLimit(modelInfo.max_output_tokens, "raw output");
    const outputMaximum = rawMaximum === undefined ? hostMaximum : Math.min(hostMaximum, rawMaximum);
    if (requestedMaxTokens === undefined) {
        return outputMaximum;
    }
    if (typeof requestedMaxTokens !== "number") {
        throw new Error("Invalid request output token limit.");
    }
    return Math.min(outputMaximum, positiveTokenLimit(requestedMaxTokens, "request output"));
}

/** Usage consumes an already prepared wire cap; no smart reserve or host clamp. */
export function getPreparedOutputCap(request: { max_tokens?: number }): number {
    const cap = request.max_tokens;
    if (typeof cap !== "number" || !Number.isFinite(cap) || !Number.isInteger(cap) || cap < 1) {
        throw new Error("Invalid prepared output token limit.");
    }
    return cap;
}

/**
 * A combined window exists only when explicitly supplied. The registry's
 * input-only display fallback is deliberately not a shared constraint.
 * Host context display has no reliable provenance here. Missing raw metadata
 * cannot turn the connector's synthesized input fallback into a combined limit.
 */
export function getExplicitCombinedTokenLimit(
    model: Pick<vscode.LanguageModelChatInformation, "maxContextWindowTokens">,
    modelInfo?: LiteLLMModelInfo
): number | undefined {
    // Retain the model argument for existing call sites; never infer from it.
    void model;
    const combined = modelInfo?.context_window_tokens;
    return combined === null || combined === undefined ? undefined : positiveTokenLimit(combined, "combined context");
}

/**
 * Local pre-send input budget. Output consumes combined context, never an
 * independent input maximum a second time. Tools/static prompts are accounted
 * for by callers after this calculation, each exactly once.
 */
export function getRequestInputTokenBudget(
    model: Pick<vscode.LanguageModelChatInformation, "maxInputTokens" | "maxContextWindowTokens">,
    modelInfo: LiteLLMModelInfo | undefined,
    outputCap: number,
    safetyRatio = 1
): number {
    const hostMaximum = positiveTokenLimit(model.maxInputTokens, "model input");
    const rawInput =
        modelInfo?.max_input_tokens === null || modelInfo?.max_input_tokens === undefined
            ? undefined
            : positiveTokenLimit(modelInfo.max_input_tokens, "raw input");
    const inputMaximum = rawInput === undefined ? hostMaximum : Math.min(hostMaximum, rawInput);
    // Validate present raw output even for callers that already normalized cap.
    const rawOutput =
        modelInfo?.max_output_tokens === null || modelInfo?.max_output_tokens === undefined
            ? undefined
            : positiveTokenLimit(modelInfo.max_output_tokens, "raw output");
    const reservedOutput = positiveTokenLimit(outputCap, "request output");
    if (rawOutput !== undefined && reservedOutput > rawOutput) {
        throw new Error("Request output token limit exceeds raw output maximum.");
    }
    if (!Number.isFinite(safetyRatio) || safetyRatio <= 0 || safetyRatio > 1) {
        throw new Error("Invalid input safety ratio.");
    }
    const combined = getExplicitCombinedTokenLimit(model, modelInfo);
    const available = combined === undefined ? inputMaximum : Math.min(inputMaximum, combined - reservedOutput);
    return Math.max(0, Math.floor(available * safetyRatio));
}
