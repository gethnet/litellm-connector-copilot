import * as assert from "assert";
import * as sinon from "sinon";
import type * as vscode from "vscode";
import { LiteLLMProviderRegistry } from "../liteLLMProviderRegistry";
import { ConfigManager } from "../../config/configManager";
import { deriveCapabilitiesFromModelInfo } from "../../utils/modelCapabilities";
import type { LiteLLMModelInfo } from "../../types";

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
