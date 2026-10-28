import type * as vscode from "vscode";
import { createReasoningScope } from "../../adapters/reasoningContinuity";
import type { ReasoningScope } from "../../adapters/reasoningContinuity";
import { sha256HexAsync } from "../../utils/discoveryHash";
import { resolveCallTimeConfiguration } from "./callConfig";
import type { CallConfigDeps } from "./callConfig";
import type { RequestBuilderDeps } from "./types";

/**
 * Binds replay to the resolved authorization context without putting a credential or a
 * cross-session credential fingerprint in chat history. The salted, non-reversible hash
 * is persisted on disk with chat history; neither the credential nor nonce is persisted.
 * The private random nonce lives only for this provider instance: reload intentionally
 * drops old opaque state, not text/tools.
 */
export class ReasoningScopeResolver {
    private readonly sessionNonce = globalThis.crypto.randomUUID();

    async resolve(
        model: string,
        configuration: Record<string, unknown> | undefined,
        group?: string
    ): Promise<ReasoningScope | undefined> {
        const apiKey = configuration?.apiKey;
        if (typeof apiKey !== "string" || !apiKey.trim()) {
            return undefined;
        }
        // Never log or persist this input. Salting prevents cross-session correlation and
        // avoids retaining raw credentials in an additional in-memory replay cache.
        const authorization = await sha256HexAsync(JSON.stringify([this.sessionNonce, apiKey.trim()]));
        return createReasoningScope(model, configuration?.baseUrl, group, authorization);
    }
}

export interface ReasoningCallContext {
    getCallTimeConfiguration(
        options: vscode.ProvideLanguageModelChatResponseOptions,
        model: vscode.LanguageModelChatInformation
    ): Promise<Record<string, unknown> | undefined>;
    getReasoningScope: NonNullable<RequestBuilderDeps["resolveReasoningScope"]>;
}

/** One resolver per provider, with the same call-time configuration policy as transport. */
export function createReasoningCallContext(
    deps: CallConfigDeps & Pick<RequestBuilderDeps, "extractRawModelName">
): ReasoningCallContext {
    const resolver = new ReasoningScopeResolver();
    const getCallTimeConfiguration: ReasoningCallContext["getCallTimeConfiguration"] = (options, model) =>
        resolveCallTimeConfiguration(options, model, deps);
    return {
        getCallTimeConfiguration,
        getReasoningScope: async (options, model) => {
            const configuration = await getCallTimeConfiguration(options, model);
            const group =
                typeof configuration?.groupName === "string"
                    ? configuration.groupName
                    : (deps.registry.lookup(model.id)?.routingIdentity ?? model.id);
            return resolver.resolve(deps.extractRawModelName(model.id), configuration, group);
        },
    };
}
