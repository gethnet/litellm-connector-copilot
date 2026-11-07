import * as vscode from "vscode";
import type { LiteLLMProviderBase } from "../providers/liteLLMProviderBase";
import type { LiteLLMModelInfo } from "../types";
import { countTokens } from "../adapters/tokenUtils";
import { getRequestInputTokenBudget, resolveRequestOutputCap } from "../adapters/requestTokenBudget";
import { deriveCapabilitiesFromModelInfo } from "../utils/modelCapabilities";
import {
    computeDiffBudget,
    computeOutputReserve,
    countDiffBreadth,
    resolveCommitContextWindow,
} from "../utils/commitDiffBudget";
import { DIFF_TRUNCATION_MARKER, GitUtils } from "../utils/gitUtils";
import { StructuredLogger } from "../observability/structuredLogger";

export const DIFF_PREAMBLE = "Here is the diff:\n\n";

export type CommitPreparationProvider = Pick<
    LiteLLMProviderBase,
    "getModelInfo" | "getRawModelName" | "remoteCountTokens"
>;

export interface PreparedCommitRequest {
    diff: string;
    budget: number;
    inputBudget: number;
    maxInputTokens: number;
    outputReserve: number;
    rawModelId: string;
    modelInfo?: LiteLLMModelInfo;
    estimatedDiffTokens: number;
    processedTokens: number;
}

export function buildCommitMessages(
    diff: string,
    systemPrompt: string,
    messagePrompt: string
): vscode.LanguageModelChatMessage[] {
    return [
        vscode.LanguageModelChatMessage.User(systemPrompt),
        vscode.LanguageModelChatMessage.User(`${messagePrompt}\n\n${DIFF_PREAMBLE}${diff}`),
    ];
}

function checkCancellation(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
        throw new Error("Commit generation cancelled.");
    }
}

/**
 * Progress is measured against what was actually prepared, not a nominal model budget.
 * Returns strictly smaller diffs (by token count AND length) so retry can shrink.
 * Throws "Context window exceeded" if no smaller diff can fit.
 */
export function shrinkCommitDiff(diff: string, budget: number, rawModelId: string, info?: LiteLLMModelInfo): string {
    const currentTokens = countTokens(diff, rawModelId, info);
    const target = Math.floor(Math.min(budget, currentTokens) * 0.75);
    const markerTokens = countTokens(DIFF_TRUNCATION_MARKER, rawModelId, info);
    if (target <= markerTokens) {
        throw new Error("Context window exceeded. No smaller useful commit diff fits; reduce the staged changes.");
    }
    const next = GitUtils.truncateToTokenLimit(diff, target, rawModelId, info);
    if (
        next.length >= diff.length ||
        countTokens(next, rawModelId, info) >= currentTokens ||
        !next.replace(DIFF_TRUNCATION_MARKER, "").trim()
    ) {
        throw new Error("Context window exceeded. Commit diff recovery made no progress; reduce the staged changes.");
    }
    return next;
}

/**
 * Count complete messages, then verify every remote-directed correction before returning.
 * Logs only numeric recount summaries at warn; heuristic fallback decisions at debug.
 */
export async function prepareCommitRequest(
    provider: CommitPreparationProvider,
    modelId: string,
    reportedMaxInputTokens: number | undefined,
    candidateDiff: string,
    systemPrompt: string,
    messagePrompt: string,
    configuredOutputReserve: number | undefined,
    token: vscode.CancellationToken
): Promise<PreparedCommitRequest> {
    checkCancellation(token);
    const modelInfo = provider.getModelInfo(modelId);
    const rawModelId = provider.getRawModelName(modelId);
    const maxInputTokens = resolveCommitContextWindow(reportedMaxInputTokens, rawModelId, modelInfo);
    const outputReserve = resolveRequestOutputCap(
        deriveCapabilitiesFromModelInfo(rawModelId, modelInfo),
        computeOutputReserve(countDiffBreadth(candidateDiff), configuredOutputReserve),
        modelInfo
    );
    const inputBudget = getRequestInputTokenBudget({ maxInputTokens }, modelInfo, outputReserve, 0.9);
    const staticTokens = countTokens(
        [vscode.LanguageModelChatMessage.User(systemPrompt), vscode.LanguageModelChatMessage.User(messagePrompt)],
        rawModelId,
        modelInfo
    );
    if (staticTokens >= inputBudget) {
        throw new Error(
            "Context window exceeded. Commit instructions exceed the available input budget; shorten the configured prompts."
        );
    }
    // The safety ratio of computeDiffBudget remains the explicit prefix of (input - static).
    let budget = computeDiffBudget({
        maxInputTokens,
        outputReserve,
        staticPrompts: [systemPrompt, messagePrompt, DIFF_PREAMBLE],
        modelId: rawModelId,
        modelInfo,
    });
    budget = Math.min(budget, inputBudget - staticTokens);
    const estimatedDiffTokens = countTokens(candidateDiff, rawModelId, modelInfo);
    let diff =
        estimatedDiffTokens > budget
            ? GitUtils.compactDiff(candidateDiff, budget, rawModelId, modelInfo)
            : candidateDiff;
    if (countTokens(buildCommitMessages(diff, systemPrompt, messagePrompt), rawModelId, modelInfo) > inputBudget) {
        diff = shrinkCommitDiff(diff, budget, rawModelId, modelInfo);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        checkCancellation(token);
        const messages = buildCommitMessages(diff, systemPrompt, messagePrompt);
        const localTokens = countTokens(messages, rawModelId, modelInfo);
        if (localTokens > inputBudget) {
            throw new Error("Context window exceeded. Prepared commit input exceeds the local budget.");
        }
        let remoteTokens: number | undefined;
        try {
            remoteTokens = await provider.remoteCountTokens(modelId, messages, 3000, token);
        } catch {
            remoteTokens = undefined;
        }
        checkCancellation(token);
        if (remoteTokens !== undefined && (!Number.isFinite(remoteTokens) || remoteTokens < 0)) {
            remoteTokens = undefined;
        }
        if (remoteTokens === undefined || remoteTokens <= inputBudget) {
            if (remoteTokens === undefined) {
                StructuredLogger.debug(
                    "commit.diff_remote_recount_unavailable",
                    { localTokens, inputBudget },
                    { model: modelId, caller: "commit-message" }
                );
            }
            return {
                diff,
                budget,
                inputBudget,
                maxInputTokens,
                outputReserve,
                rawModelId,
                modelInfo,
                estimatedDiffTokens,
                processedTokens: countTokens(diff, rawModelId, modelInfo),
            };
        }
        if (attempt === 2) {
            throw new Error(
                "Context window exceeded. Remote count still exceeds the commit budget after two reductions; reduce the staged changes."
            );
        }
        const oldTokens = countTokens(diff, rawModelId, modelInfo);
        const ratio = remoteTokens / Math.max(1, localTokens);
        // The remote count is FULL input, not diff-only. Reserve the complete
        // static cost after converting the total budget back to local units.
        // This is a shaping hint, not proof of fit; recount the new full input.
        const diffAllowance = Math.max(0, Math.floor((inputBudget / ratio - staticTokens) * 0.9));
        budget = Math.min(budget, Math.floor(oldTokens * 0.75), diffAllowance);
        let next = GitUtils.compactDiff(diff, budget, rawModelId, modelInfo);
        if (next.length >= diff.length || countTokens(next, rawModelId, modelInfo) >= oldTokens) {
            next = shrinkCommitDiff(diff, budget, rawModelId, modelInfo);
        }
        if (!next.replace(DIFF_TRUNCATION_MARKER, "").trim() || countTokens(next, rawModelId, modelInfo) > budget) {
            throw new Error("Context window exceeded. No useful commit diff fits the recounted budget.");
        }
        diff = next;
        StructuredLogger.warn(
            "commit.diff_remote_recount",
            { remoteTokens, ratio: Number(ratio.toFixed(3)), budget, attempt: attempt + 1 },
            { model: modelId, caller: "commit-message" }
        );
    }
    throw new Error("Context window exceeded. Commit recount exhausted.");
}
