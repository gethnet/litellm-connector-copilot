import type * as vscode from "vscode";
import { Logger } from "../../utils/logger";
import type { ConfigManager } from "../../config/configManager";
import type { LiteLLMProviderRegistry } from "../liteLLMProviderRegistry";

/**
 * Dependencies needed to resolve the per-group configuration for a
 * response-time call. Extracted as an interface so the resolver is a pure
 * function of (options, model, deps) and unit-testable in isolation.
 */
export interface CallConfigDeps {
    configManager: ConfigManager;
    registry: Pick<LiteLLMProviderRegistry, "lookup">;
}

/**
 * Resolves the per-group configuration for a response-time call.
 *
 * Discovery-time call paths and the per-group config come from
 * `options.configuration` (set by VS Code 1.120 at discovery time).
 * Response-time paths in VS Code 1.120 do NOT pass the per-group config
 * on `options.configuration` — the proposed-type definition for
 * `ProvideLanguageModelChatResponseOptions` does not declare that field.
 *
 * As a fallback we consult the in-memory `LiteLLMProviderRegistry` keyed
 * by the model id. The registry is populated by every successful
 * discovery call, so a model that's been discovered in this session is
 * routable. If neither channel has the model, the call is a
 * configuration problem and the transport surfaces a visible error.
 *
 * IMPORTANT: VS Code may pass an EMPTY configuration object (truthy, but
 * no `baseUrl` or `apiKey`) for some calls, particularly for models picked
 * from a group other than the one currently being routed. We trust
 * `options.configuration` ONLY when it has both a usable `baseUrl`
 * (string, non-empty) and a usable `apiKey` (string, non-empty). Anything
 * else falls through to the registry. Without this guard, the empty
 * object previously short-circuited the registry fallback and produced a
 * "No baseUrl provided" runtime error.
 *
 * Both resolution paths merge the workspace-config ergonomic toggles
 * (`allowChatCompletionsFallback`, `disableCaching`) onto the returned
 * configuration so the transport can read them without a second config
 * fetch on the hot path.
 */
export async function resolveCallTimeConfiguration(
    options: vscode.ProvideLanguageModelChatResponseOptions,
    model: vscode.LanguageModelChatInformation,
    deps: CallConfigDeps
): Promise<Record<string, unknown> | undefined> {
    const opt = options as vscode.ProvideLanguageModelChatResponseOptions & {
        configuration?: Record<string, unknown>;
    };
    const optBaseUrl = typeof opt.configuration?.baseUrl === "string" ? opt.configuration.baseUrl.trim() : "";
    const optApiKey = typeof opt.configuration?.apiKey === "string" ? opt.configuration.apiKey.trim() : "";

    // Fetch workspace-config toggles once so both paths can merge them.
    const cfg = await deps.configManager.getConfig();

    if (opt.configuration && optBaseUrl.length > 0 && optApiKey.length > 0) {
        Logger.trace(
            `getCallTimeConfiguration: HIT via options.configuration modelId="${model.id}" baseUrl="${optBaseUrl}"`
        );
        // Merge workspace-config ergonomic toggles onto the per-group
        // configuration so the transport can read allowChatCompletionsFallback
        // and disableCaching without a separate config fetch on the hot path.
        return {
            ...opt.configuration,
            allowChatCompletionsFallback: cfg.allowChatCompletionsFallback,
            disableCaching: cfg.disableCaching,
        };
    }
    if (opt.configuration) {
        // Object is present but malformed (empty / missing fields).
        // This is the case we need to escape from — VS Code passed an
        // empty object and we must not trust it.
        Logger.trace(
            `getCallTimeConfiguration: options.configuration present but invalid (empty baseUrl or apiKey) modelId="${model.id}"; falling back to registry`
        );
    } else {
        Logger.trace(
            `getCallTimeConfiguration: options.configuration missing; falling back to registry lookup for modelId="${model.id}" modelName="${model.name}"`
        );
    }
    // No options.configuration at response time (the common case in VS
    // Code 1.120+). Fall back to the in-memory registry. The model id
    // VS Code hands back is the namespaced `<routing>/<raw>` form
    // produced by `LiteLLMProviderRegistry.toVSCodeInfo`; the registry
    // maps that id back to the {baseUrl, apiKey} of the backend that
    // produced it. The request builder extracts the raw model name
    // from `model.id` for `request.model`; the transport only needs
    // baseUrl + apiKey.
    const entry = deps.registry.lookup(model.id);
    if (entry) {
        Logger.trace(`getCallTimeConfiguration: registry HIT modelId="${model.id}" -> baseUrl="${entry.baseUrl}"`);
        // Same ergonomic-toggle merge as the options.configuration path above,
        // so /responses fallback + disableCaching work regardless of which
        // path resolved baseUrl/apiKey.
        return {
            baseUrl: entry.baseUrl,
            apiKey: entry.apiKey,
            allowChatCompletionsFallback: cfg.allowChatCompletionsFallback,
            disableCaching: cfg.disableCaching,
        };
    }
    Logger.warn(
        `getCallTimeConfiguration: registry MISS modelId="${model.id}" modelName="${model.name}" — request will fail with configuration error`
    );
    return undefined;
}
