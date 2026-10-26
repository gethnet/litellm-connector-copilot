import * as assert from "assert";
import * as sinon from "sinon";
import type * as vscode from "vscode";
import { LiteLLMProviderRegistry } from "../liteLLMProviderRegistry";
import { ConfigManager } from "../../config/configManager";
import { deriveCapabilitiesFromModelInfo } from "../../utils/modelCapabilities";
import type { LiteLLMModelInfo, LiteLLMModelInfoResponse } from "../../types";

interface RegistrySeed {
    setModelsForBackend(
        baseUrl: string,
        apiKey: string,
        routingIdentity: string,
        models: vscode.LanguageModelChatInformation[]
    ): void;
    modelInfoCache: Map<string, LiteLLMModelInfo | undefined>;
}

suite("Registry token metadata provenance (#159)", () => {
    test("native provider provenance survives discovery for a model alias", () => {
        const sandbox = sinon.createSandbox();
        const configManager = sandbox.createStubInstance(ConfigManager);
        configManager.getConfig.resolves({});
        const registry = new LiteLLMProviderRegistry({ configManager, userAgent: "test" });
        try {
            const seam = registry as unknown as {
                toVSCodeInfo(
                    entry: LiteLLMModelInfoResponse["data"][number],
                    name: string,
                    backend: { url: string },
                    displayLabel: string,
                    routingIdentity: string
                ): vscode.LanguageModelChatInformation;
                modelInfoCache: Map<string, LiteLLMModelInfo>;
            };
            const model = seam.toVSCodeInfo(
                {
                    model_name: "private-alias",
                    model_info: { mode: "responses" },
                    litellm_params: { provider: "chatgpt" },
                },
                "test",
                { url: "https://proxy.example" },
                "test",
                "test-group"
            );
            assert.strictEqual(seam.modelInfoCache.get(model.id)?.provider, "chatgpt");

            // custom_llm_provider feeds native detection only; the picker vendor must not move.
            const bridged = seam.toVSCodeInfo(
                {
                    model_name: "qwen-alias",
                    model_info: { mode: "responses" },
                    litellm_params: { custom_llm_provider: "openai" },
                },
                "test",
                { url: "https://proxy.example" },
                "test",
                "test-group"
            );
            assert.strictEqual(seam.modelInfoCache.get(bridged.id)?.provider, "openai");
            assert.strictEqual((bridged as unknown as { vendor: string }).vendor, "litellm");
        } finally {
            registry.dispose();
            sandbox.restore();
        }
    });

    test("unique raw-name metadata resolves; ambiguity and cleared cache do not invent totals", () => {
        const sandbox = sinon.createSandbox();
        const configManager = sandbox.createStubInstance(ConfigManager);
        configManager.getConfig.resolves({});
        const registry = new LiteLLMProviderRegistry({ configManager, userAgent: "test" });
        try {
            const seam = registry as unknown as RegistrySeed;
            const info = Object.freeze({ max_input_tokens: 200000, max_output_tokens: 8192, max_tokens: 8192 });
            const seed = (routing: string): string => {
                const id = `${routing}/claude-test`;
                const caps = deriveCapabilitiesFromModelInfo("claude-test", info);
                const model = {
                    id,
                    name: "claude-test",
                    family: "claude",
                    version: "1",
                    maxInputTokens: caps.maxInputTokens,
                    maxOutputTokens: caps.maxOutputTokens,
                    maxContextWindowTokens: caps.rawContextWindow,
                } as vscode.LanguageModelChatInformation;
                seam.setModelsForBackend(`https://${routing}`, "test-key", routing, [model]);
                seam.modelInfoCache.set(id, info);
                return id;
            };

            const canonical = seed("one.example");
            assert.strictEqual(registry.getModelInfo("claude-test"), info);
            assert.strictEqual(registry.getModelInfo(canonical), info);
            registry.clearCaches();
            assert.strictEqual(registry.getModelInfo("claude-test"), undefined);

            seam.modelInfoCache.set(canonical, info);
            seed("two.example");
            assert.strictEqual(registry.getModelInfo("claude-test"), undefined);
            assert.strictEqual(registry.getModelInfo(canonical), info);
        } finally {
            registry.dispose();
            sandbox.restore();
        }
    });
});
