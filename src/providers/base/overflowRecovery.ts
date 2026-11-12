import * as vscode from "vscode";
import type {
    LanguageModelChatInformation,
    LanguageModelChatRequestMessage,
    ProvideLanguageModelChatResponseOptions,
} from "vscode";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../../types";
import { isContextOverflowError } from "../../adapters/tokenUtils";
import { Logger } from "../../utils/logger";
import { replaceReasoningRetryState, readReasoningRetryState } from "./reasoningRetryState";
import { stripThinkingBlocksFromRequest } from "./thinkingBlockRetry";
import type { RequestBuilder } from "./requestBuilder";

/**
 * Dependencies the one-shot overflow recovery needs from the orchestrating
 * provider. Declared structurally so the helper stays decoupled from the
 * base class while reusing the same request-builder and transport seams.
 */
export interface OverflowRecoveryDeps {
    requestBuilder: RequestBuilder;
    getCallTimeConfiguration(
        options: ProvideLanguageModelChatResponseOptions,
        model: LanguageModelChatInformation
    ): Promise<Record<string, unknown> | undefined>;
    buildOpenAIChatRequest(
        messages: readonly LanguageModelChatRequestMessage[],
        model: LanguageModelChatInformation,
        options: ProvideLanguageModelChatResponseOptions,
        modelInfo?: LiteLLMModelInfo,
        caller?: string
    ): Promise<OpenAIChatCompletionRequest>;
    sendRequestToLiteLLM(
        request: OpenAIChatCompletionRequest,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        modelInfo?: LiteLLMModelInfo,
        configuration?: Record<string, unknown>
    ): Promise<ReadableStream<Uint8Array>>;
    /**
     * When true, overflow rebuilding re-strips thinking_blocks so a prior
     * continuity redaction survives the rebuild and is not restored from
     * the original VS Code history.
     */
    stripThinkingBlocksForRetry: boolean;
}

/**
 * Sends one attempt with a single smaller-body overflow recovery.
 *
 * Invariants preserved from the base orchestrator:
 * - Cancel, SCM's `litellm_connector_preserve_messages`, and non-overflow
 *   failures propagate the ORIGINAL error object unchanged (SCM owns its
 *   own bounded diff-aware retry).
 * - A rebuild that cannot fit protected latest messages/tool exchanges
 *   surfaces the original backend overflow instead of amputating content.
 * - A rebuilt request is sent only when the finalized text+tools input is
 *   strictly smaller; prior continuity redaction is not another reduction.
 * - A second consecutive overflow is normalized to `LanguageModelError`
 *   with code `ContextExceeded` for VS Code's error surface.
 */
export async function sendOnceWithOverflow(
    deps: OverflowRecoveryDeps,
    request: OpenAIChatCompletionRequest,
    messages: readonly LanguageModelChatRequestMessage[],
    model: LanguageModelChatInformation,
    options: ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    caller?: string,
    modelInfo?: LiteLLMModelInfo,
    onAttempt?: (request: OpenAIChatCompletionRequest) => void
): Promise<ReadableStream<Uint8Array>> {
    const sendAttempt = async (candidate: OpenAIChatCompletionRequest): Promise<ReadableStream<Uint8Array>> => {
        const configuration = await deps.getCallTimeConfiguration(options, model);
        onAttempt?.(candidate);
        return deps.sendRequestToLiteLLM(candidate, progress, token, caller, modelInfo, configuration);
    };
    try {
        return await sendAttempt(request);
    } catch (err) {
        // Cancel and SCM-preserve options bypass the shared recovery entirely;
        // the SCM command owns its own diff-aware retry path. Output parameter
        // validation, quota failures, and unrelated errors propagate unchanged.
        if (
            !isContextOverflowError(err) ||
            token.isCancellationRequested ||
            (options.modelOptions as Record<string, unknown> | undefined)?.litellm_connector_preserve_messages === true
        ) {
            throw err;
        }

        const retry = deps.requestBuilder.prepareOverflowRetry(request, messages, model, options, modelInfo);
        let rebuiltRequest: OpenAIChatCompletionRequest;
        try {
            rebuiltRequest = await deps.buildOpenAIChatRequest(retry.messages, model, retry.options, modelInfo, caller);
        } catch (buildError) {
            if (isContextOverflowError(buildError)) {
                // Protected latest messages/tool exchanges cannot fit the stricter cap.
                // Surface the original backend overflow; do not amputate or resend it.
                throw err;
            }
            throw buildError;
        }
        // If continuity was already redacted on the outer retry, the rebuilt
        // request (which re-reads the original history) would reintroduce
        // thinking_blocks. Re-strip so the rejected continuity stays gone.
        const retrimmedRequest = deps.stripThinkingBlocksForRetry
            ? stripThinkingBlocksFromRequest(rebuiltRequest)
            : rebuiltRequest;
        // Overflow rebuilds from the original picker options, so re-stamp
        // the live retry representation instead of restoring picker effort.
        replaceReasoningRetryState(retrimmedRequest, readReasoningRetryState(request));
        if (
            token.isCancellationRequested ||
            !deps.requestBuilder.hasOverflowProgress(request, retrimmedRequest, modelInfo)
        ) {
            throw err;
        }
        // No raw errors or request contents: warn only after progress is proven.
        Logger.warn("[sendRequestWithRetry] Context overflow: retrying a strictly smaller prepared request");
        try {
            return await sendAttempt(retrimmedRequest);
        } catch (retryErr) {
            if (isContextOverflowError(retryErr)) {
                const contextError = new vscode.LanguageModelError(
                    "Context window exceeded. The conversation is too long for this model."
                );
                (contextError as { code?: string }).code = "ContextExceeded";
                throw contextError;
            }
            throw retryErr;
        }
    }
}
