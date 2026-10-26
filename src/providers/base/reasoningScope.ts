import { createReasoningScope } from "../../adapters/reasoningContinuity";
import type { ReasoningScope } from "../../adapters/reasoningContinuity";
import { sha256HexAsync } from "../../utils/discoveryHash";

/**
 * Binds replay to the resolved authorization context without putting a credential or a
 * persistent credential fingerprint in chat history. The private random nonce lives only
 * for this provider instance: reload intentionally drops old opaque state, not text/tools.
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
