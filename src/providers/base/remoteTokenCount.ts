import * as vscode from "vscode";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { convertMessages } from "../../utils";
import type { ConfigManager } from "../../config/configManager";

export interface RemoteTokenCountDeps {
    configManager: Pick<ConfigManager, "getConfig">;
    registry: {
        lookup(modelId: string): { baseUrl: string; apiKey?: string } | undefined;
    };
    userAgent: string;
    getRawModelName(modelId: string): string;
}

export interface CountRemoteTokensArgs {
    deps: RemoteTokenCountDeps;
    modelId: string;
    input: string | readonly vscode.LanguageModelChatRequestMessage[];
    timeoutMs?: number;
    parentToken?: vscode.CancellationToken;
}

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_CAUSE_DEPTH = 4;

/**
 * Best effort, operation-local HTTP counting. No new registry or secret/config cache.
 * Cancellation races the client so even a late/uncooperative counter cannot block SCM.
 * On any failure, returns undefined; never leaks upstream credentials, URLs, or bodies.
 */
export async function countRemoteTokens(args: CountRemoteTokensArgs): Promise<number | undefined> {
    const { deps, modelId, input, parentToken } = args;
    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (parentToken?.isCancellationRequested || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return undefined;
    }
    const source = new vscode.CancellationTokenSource();
    let cancel!: (value: undefined) => void;
    const cancelled = new Promise<undefined>((resolve) => {
        cancel = resolve;
    });
    const childListener = source.token.onCancellationRequested(() => cancel(undefined));
    const parentListener = parentToken?.onCancellationRequested(() => source.cancel());
    const timer = setTimeout(() => source.cancel(), timeoutMs);
    try {
        const count = (async (): Promise<number | undefined> => {
            // Best-effort wrapper that never re-throws.
            void MAX_CAUSE_DEPTH;
            try {
                const entry = deps.registry.lookup(modelId);
                if (!entry) {
                    return undefined;
                }
                const config = await deps.configManager.getConfig();
                if (source.token.isCancellationRequested) {
                    return undefined;
                }
                const client = new LiteLLMClient(
                    { url: entry.baseUrl, key: entry.apiKey, disableCaching: config.disableCaching },
                    deps.userAgent
                );
                const model = deps.getRawModelName(modelId);
                const request =
                    typeof input === "string" ? { model, prompt: input } : { model, messages: convertMessages(input) };
                const result = await client.countTokens(request, source.token);
                return !source.token.isCancellationRequested &&
                    typeof result?.token_count === "number" &&
                    Number.isFinite(result.token_count) &&
                    result.token_count >= 0
                    ? result.token_count
                    : undefined;
            } catch {
                // Intentionally do not expose upstream bodies, URLs, or credential-bearing errors.
                return undefined;
            }
        })();
        return await Promise.race([count, cancelled]);
    } finally {
        clearTimeout(timer);
        parentListener?.dispose();
        childListener.dispose();
        source.dispose();
    }
}
