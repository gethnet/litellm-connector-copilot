import * as vscode from "vscode";

import { estimateSingleMessageTokens } from "../adapters/tokenUtils";
import { Logger } from "../utils/logger";
import { LiteLLMTelemetry } from "../utils/telemetry";
import type { LiteLLMConfig } from "../types";

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

    constructor(deps: InlineCompletionsDependencies) {
        this._deps = deps;
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionList | vscode.InlineCompletionItem[] | null> {
        const requestId = `ic_${Math.random().toString(36).slice(2, 10)}`;
        const startTime = LiteLLMTelemetry.startTimer();

        LiteLLMTelemetry.reportMetric({
            requestId,
            model: "n/a",
            status: "success",
            caller: "inline-completions.entry",
        });

        const config = await this._deps.getConfig();
        if (!config.inlineCompletionsEnabled) {
            LiteLLMTelemetry.reportMetric({
                requestId,
                model: config.inlineCompletionsModelId ?? "unset",
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                status: "failure",
                error: "inline_completions_disabled",
                caller: "inline-completions",
            });
            return null;
        }

        if (!config.url) {
            Logger.debug("Inline completions: missing baseUrl; returning no items");
            LiteLLMTelemetry.reportMetric({
                requestId,
                model: config.inlineCompletionsModelId ?? "unset",
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                status: "failure",
                error: "not_configured",
                caller: "inline-completions",
            });
            return null;
        }

        const modelId = config.inlineCompletionsModelId;
        if (!modelId) {
            Logger.debug("Inline completions: no model configured; returning no items");
            LiteLLMTelemetry.reportMetric({
                requestId,
                model: "unset",
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                status: "failure",
                error: "model_not_selected",
                caller: "inline-completions",
            });
            return null;
        }

        const { prompt, prefixTokens, suffixTokens } = buildInlineCompletionPrompt(document, position, {
            // Reserve some output space; we can tune later.
            reservedOutputTokens: 256,
            maxContextTokens: 4096,
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
            if (!insertText.trim()) {
                LiteLLMTelemetry.reportMetric({
                    requestId,
                    model: modelId,
                    durationMs: LiteLLMTelemetry.endTimer(startTime),
                    status: "success",
                    tokensIn: prefixTokens + suffixTokens,
                    tokensOut: 0,
                    caller: "inline-completions.request.result",
                });
                return null;
            }

            LiteLLMTelemetry.reportMetric({
                requestId,
                model: modelId,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
                status: "success",
                tokensIn: prefixTokens + suffixTokens,
                tokensOut: Math.ceil(insertText.length / 4),
                caller: "inline-completions.request.result",
            });

            const range = new vscode.Range(position, position);
            const item = new vscode.InlineCompletionItem(insertText, range);
            // Avoid showing completions in comments/strings? Leave for later.
            void context;
            return [item];
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            Logger.warn(`Inline completions failed: ${msg}`);
            LiteLLMTelemetry.reportMetric({
                requestId,
                model: modelId,
                durationMs: LiteLLMTelemetry.endTimer(startTime),
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
            return null;
        }
    }
}

export interface PromptWindowOptions {
    /** Tokens reserved for the model output. */
    reservedOutputTokens: number;
    /** Target max tokens for prefix+suffix. */
    maxContextTokens: number;
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

    // We use a simple chat-message token estimator (chars/4) for budgeting.
    // Build two synthetic messages to reuse the estimator.
    const makeMsg = (value: string): vscode.LanguageModelChatRequestMessage => ({
        role: vscode.LanguageModelChatMessageRole.User,
        content: [new vscode.LanguageModelTextPart(value)],
        name: undefined,
    });

    const budget = Math.max(256, options.maxContextTokens - options.reservedOutputTokens);

    // Prefer more prefix than suffix (common inline completion UX).
    const suffixBudget = Math.floor(budget * 0.25);
    const prefixBudget = budget - suffixBudget;

    const prefix = trimTextToTokenBudget(prefixFull, prefixBudget);
    const suffix = trimTextToTokenBudget(suffixFull, suffixBudget);

    const prefixTokens = estimateSingleMessageTokens(makeMsg(prefix));
    const suffixTokens = estimateSingleMessageTokens(makeMsg(suffix));

    // Prompt format: provide cursor marker and suffix so the model can continue.
    const prompt = [
        "You are an inline code completion engine.",
        "Continue the code at the cursor. Output only the text to insert.",
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

function trimTextToTokenBudget(text: string, tokenBudget: number): string {
    if (tokenBudget <= 0) {
        return "";
    }

    // Approx tokens ~= chars/4 -> chars ~= tokens*4.
    const maxChars = Math.max(0, tokenBudget * 4);
    if (text.length <= maxChars) {
        return text;
    }

    // Keep the end of prefix (most relevant) and start of suffix.
    // We don't know if it's prefix or suffix here; callers pass appropriate slice.
    return text.slice(text.length - maxChars);
}
