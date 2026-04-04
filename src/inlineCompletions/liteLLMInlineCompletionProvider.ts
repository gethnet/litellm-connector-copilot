import * as vscode from "vscode";

import { calculateAvailableContext, countTokens } from "../adapters/tokenUtils";
import { Logger } from "../utils/logger";
import { LiteLLMTelemetry } from "../utils/telemetry";
import type { TelemetryService } from "../telemetry/telemetryService";
import type { LiteLLMConfig } from "../types";

const INLINE_SYSTEM_PROMPT =
    "You are an inline code completion engine.\nContinue the code at the cursor. Output only the text to insert.";
const INLINE_WRAPPER_PROMPT = "\n\n<prefix>\n\n</prefix>\n<cursor></cursor>\n<suffix>\n\n</suffix>";

export interface InlineCompletionsDependencies {
    /** Reads current config (including inline completions settings). */
    getConfig: () => Promise<LiteLLMConfig>;
    /** Completion requester (LiteLLM-backed). */
    completionProvider: {
        provideTextCompletion: (
            prompt: string,
            options: {
                modelId?: string;
                modelOptions?: Record<string, unknown>;
                configuration?: Record<string, unknown>;
            },
            token: vscode.CancellationToken
        ) => Promise<{ insertText: string }>;
    };
}

/**
 * Stable inline completions provider for VS Code 1.109.
 *
 * This avoids the (non-stable) LM text completion provider APIs and instead uses
 * `vscode.languages.registerInlineCompletionItemProvider`.
 */
export class LiteLLMInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private readonly _deps: InlineCompletionsDependencies;
    private _telemetryService?: TelemetryService;

    constructor(deps: InlineCompletionsDependencies) {
        this._deps = deps;
    }

    public setTelemetryService(service: TelemetryService): void {
        this._telemetryService = service;
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionList | vscode.InlineCompletionItem[] | null> {
        const requestId = `ic_${Math.random().toString(36).slice(2, 10)}`;
        const startTime = LiteLLMTelemetry.startTimer();

        if (this._telemetryService) {
            this._telemetryService.captureFeatureUsed("inline-completions", "inline-completions");
        }

        LiteLLMTelemetry.reportMetric({
            requestId,
            model: "n/a",
            status: "success",
            caller: "inline-completions.entry",
        });

        const config = await this._deps.getConfig();
        if (!config.inlineCompletionsEnabled) {
            const durationMs = LiteLLMTelemetry.endTimer(startTime);
            LiteLLMTelemetry.reportMetric({
                requestId,
                model: config.inlineCompletionsModelId ?? "unset",
                durationMs,
                status: "failure",
                error: "inline_completions_disabled",
                caller: "inline-completions",
            });
            if (this._telemetryService) {
                this._telemetryService.captureInlineCompletionRequest({
                    status: "disabled",
                    durationMs,
                    model: config.inlineCompletionsModelId ?? "unset",
                });
            }
            return null;
        }

        if (!config.url) {
            Logger.info("Inline completions: missing baseUrl; returning no items");
            const durationMs = LiteLLMTelemetry.endTimer(startTime);
            LiteLLMTelemetry.reportMetric({
                requestId,
                model: config.inlineCompletionsModelId ?? "unset",
                durationMs,
                status: "failure",
                error: "not_configured",
                caller: "inline-completions",
            });
            if (this._telemetryService) {
                this._telemetryService.captureInlineCompletionRequest({
                    status: "not_configured",
                    durationMs,
                    model: config.inlineCompletionsModelId ?? "unset",
                });
            }
            return null;
        }

        const modelId = config.inlineCompletionsModelId;
        if (!modelId) {
            Logger.info("Inline completions: no model configured; returning no items");
            const durationMs = LiteLLMTelemetry.endTimer(startTime);
            LiteLLMTelemetry.reportMetric({
                requestId,
                model: "unset",
                durationMs,
                status: "failure",
                error: "model_not_selected",
                caller: "inline-completions",
            });
            if (this._telemetryService) {
                this._telemetryService.captureInlineCompletionRequest({
                    status: "model_not_selected",
                    durationMs,
                    model: "unset",
                });
            }
            return null;
        }

        // Precise context calculation for inline completions
        const reservedOutput = 256;
        const maxInput = config.inlineCompletionsMaxContextTokens || 4096;

        const availableTokens = calculateAvailableContext(
            maxInput,
            reservedOutput,
            [INLINE_SYSTEM_PROMPT, INLINE_WRAPPER_PROMPT],
            modelId
        );

        const { prompt, prefixTokens, suffixTokens } = buildInlineCompletionPrompt(document, position, {
            reservedOutputTokens: reservedOutput,
            maxContextTokens: maxInput,
            availableTokens: availableTokens,
            modelId: modelId,
        });

        LiteLLMTelemetry.reportMetric({
            requestId,
            model: modelId,
            tokensIn: prefixTokens + suffixTokens,
            status: "success",
            caller: "inline-completions.request.start",
        });

        try {
            const completion = await this._deps.completionProvider.provideTextCompletion(
                prompt,
                {
                    modelId,
                    modelOptions: {},
                    // Ensure provider config is used rather than secrets.
                    configuration: {
                        baseUrl: config.url,
                        apiKey: config.key,
                    },
                },
                token
            );

            LiteLLMTelemetry.reportMetric({
                requestId,
                model: modelId,
                status: "success",
                caller: "inline-completions.litellm.success",
            });

            const insertText = completion?.insertText ?? "";
            const durationMs = LiteLLMTelemetry.endTimer(startTime);
            if (!insertText.trim()) {
                LiteLLMTelemetry.reportMetric({
                    requestId,
                    model: modelId,
                    durationMs,
                    status: "success",
                    tokensIn: prefixTokens + suffixTokens,
                    tokensOut: 0,
                    caller: "inline-completions.request.result",
                });

                /* if (this._telemetryService) {
                    this._telemetryService.captureInlineCompletionRequest({
                        status: "empty",
                        durationMs,
                        model: modelId,
                    });
                } */
                return null;
            }

            LiteLLMTelemetry.reportMetric({
                requestId,
                model: modelId,
                durationMs,
                status: "success",
                tokensIn: prefixTokens + suffixTokens,
                tokensOut: Math.ceil(insertText.length / 4),
                caller: "inline-completions.request.result",
            });

            /*  if (this._telemetryService) {
                this._telemetryService.captureInlineCompletionRequest({
                    status: "success",
                    durationMs,
                    model: modelId,
                });
            } */

            const range = new vscode.Range(position, position);
            const item = new vscode.InlineCompletionItem(insertText, range);
            return [item];
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            Logger.warn(`Inline completions failed: ${msg}`);
            const durationMs = LiteLLMTelemetry.endTimer(startTime);
            LiteLLMTelemetry.reportMetric({
                requestId,
                model: modelId,
                durationMs,
                status: "failure",
                error: msg.slice(0, 200),
                caller: "inline-completions",
            });
            LiteLLMTelemetry.reportMetric({
                requestId,
                model: modelId,
                status: "failure",
                error: msg.slice(0, 200),
                caller: "inline-completions.litellm.failure",
            });
            if (this._telemetryService) {
                this._telemetryService.captureInlineCompletionRequest({
                    status: "error",
                    durationMs,
                    model: modelId,
                });
            }
            return null;
        }
    }
}

export interface PromptWindowOptions {
    /** Tokens reserved for the model output. */
    reservedOutputTokens: number;
    /** Target max tokens for prefix+suffix. */
    maxContextTokens: number;
    /** Calculated available tokens after system prompts. */
    availableTokens: number;
    /** Model ID for tokenizer selection. */
    modelId: string;
}

export function buildInlineCompletionPrompt(
    document: vscode.TextDocument,
    position: vscode.Position,
    options: PromptWindowOptions
): { prompt: string; prefixTokens: number; suffixTokens: number } {
    const fullText = document.getText();
    const offset = document.offsetAt(position);
    const prefixFull = fullText.slice(0, offset);
    const suffixFull = fullText.slice(offset);

    const budget = options.availableTokens;

    // Prefer more prefix than suffix (common inline completion UX).
    const suffixBudget = Math.floor(budget * 0.25);
    const prefixBudget = budget - suffixBudget;

    const prefix = trimTextToTokenBudget(prefixFull, prefixBudget, options.modelId);
    const suffix = trimTextToTokenBudget(suffixFull, suffixBudget, options.modelId);

    const prefixTokens = countTokens(prefix, options.modelId);
    const suffixTokens = countTokens(suffix, options.modelId);

    // Prompt format: provide cursor marker and suffix so the model can continue.
    const prompt = [
        INLINE_SYSTEM_PROMPT,
        "",
        "<prefix>",
        prefix,
        "</prefix>",
        "<cursor></cursor>",
        "<suffix>",
        suffix,
        "</suffix>",
    ].join("\n");

    return { prompt, prefixTokens, suffixTokens };
}

function trimTextToTokenBudget(text: string, tokenBudget: number, modelId: string): string {
    if (tokenBudget <= 0) {
        return "";
    }

    // Use actual tokenizer for measurement during trimming
    const tokens = countTokens(text, modelId);
    if (tokens <= tokenBudget) {
        return text;
    }

    // Heuristic first pass to speed up trimming
    const ratio = tokenBudget / tokens;
    const charLimit = Math.floor(text.length * ratio);
    let trimmed = text.length > charLimit ? text.slice(-charLimit) : text; // For prefix, we keep the end

    // Fine-grained trim if still over
    while (countTokens(trimmed, modelId) > tokenBudget && trimmed.length > 0) {
        trimmed = trimmed.slice(Math.floor(trimmed.length * 0.1)); // Remove 10% at a time
    }

    return trimmed;
}
