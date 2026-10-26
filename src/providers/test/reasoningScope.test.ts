import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { LiteLLMChatProvider } from "../liteLLMChatProvider";
import { ConfigManager } from "../../config/configManager";
import type { ReasoningScope } from "../../adapters/reasoningContinuity";
import { createMockSecrets } from "../../test/utils/testMocks";

interface ScopeTestAccess {
    getReasoningScope(
        options: vscode.ProvideLanguageModelChatResponseOptions,
        model: vscode.LanguageModelChatInformation
    ): Promise<ReasoningScope | undefined>;
    _registry: {
        lookup(id: string): { baseUrl: string; apiKey: string; rawModelName: string; routingIdentity: string };
        dispose(): void;
    };
}

/** Replay provenance must follow the credentials transport actually uses, without storing them. */
suite("Reasoning scope from call-time configuration", () => {
    const baseUrl = "https://proxy.example/team";
    const model = { id: "proxy.example/chatgpt/test-model" } as vscode.LanguageModelChatInformation;
    let sandbox: sinon.SinonSandbox;
    let access: ScopeTestAccess;
    const created: ScopeTestAccess[] = [];

    function provider(): ScopeTestAccess {
        const instance = new LiteLLMChatProvider(createMockSecrets(), "test") as unknown as ScopeTestAccess;
        sandbox.stub(instance._registry, "lookup").returns({
            baseUrl,
            apiKey: "ACCOUNT_A",
            rawModelName: "chatgpt/test-model",
            routingIdentity: "proxy.example",
        });
        created.push(instance);
        return instance;
    }

    function options(apiKey?: string): vscode.ProvideLanguageModelChatResponseOptions {
        const base = { toolMode: vscode.LanguageModelChatToolMode.Auto, requestInitiator: "test" };
        // Per-group configuration is supplied by VS Code but absent from the declared type.
        const withConfig = { ...base, configuration: { baseUrl, apiKey } };
        return apiKey ? withConfig : base;
    }

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(ConfigManager.prototype, "getConfig").resolves({});
        access = provider();
    });

    teardown(() => {
        created.splice(0).forEach((instance) => instance._registry.dispose());
        sandbox.restore();
    });

    test("is stable for one account across config sources and host-wrapped IDs", async () => {
        const direct = await access.getReasoningScope(options("ACCOUNT_A"), model);
        assert.ok(direct);
        assert.ok(!JSON.stringify(direct).includes("ACCOUNT_A"), "credentials never enter history");
        assert.deepStrictEqual(await access.getReasoningScope(options(" ACCOUNT_A "), model), direct);
        assert.deepStrictEqual(await access.getReasoningScope(options(), model), direct);
        const wrapped = { ...model, id: `litellm-connector/Team/${model.id}` };
        assert.deepStrictEqual(await access.getReasoningScope(options("ACCOUNT_A"), wrapped), direct);
    });

    test("differs per account and per provider session", async () => {
        const first = await access.getReasoningScope(options("ACCOUNT_A"), model);
        assert.notDeepStrictEqual(await access.getReasoningScope(options("ACCOUNT_B"), model), first);
        assert.notDeepStrictEqual(await provider().getReasoningScope(options("ACCOUNT_A"), model), first);
    });
});
