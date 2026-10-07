import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { LiteLLMCommitMessageProvider } from "../liteLLMCommitProvider";
import { createMockSecrets } from "../../test/utils/testMocks";
import { deriveCapabilitiesFromModelInfo } from "../../utils/modelCapabilities";
import type { LiteLLMConfig, LiteLLMModelInfo } from "../../types";

suite("Legacy commit model limits (#159)", () => {
    test("resolver forwards raw cached limits without request arithmetic", async () => {
        const sandbox = sinon.createSandbox();
        const source = new vscode.CancellationTokenSource();
        try {
            const provider = new LiteLLMCommitMessageProvider(createMockSecrets(), "test");
            const access = provider as unknown as {
                _registry: {
                    getDerivedCapabilities(id: string): ReturnType<typeof deriveCapabilitiesFromModelInfo> | undefined;
                    getModelInfo(id: string): LiteLLMModelInfo | undefined;
                };
                registryEntries(
                    registry: unknown
                ): Iterable<[string, { baseUrl: string; apiKey: string; rawModelName: string }]>;
                resolveCommitModel(
                    config: LiteLLMConfig,
                    token: vscode.CancellationToken
                ): Promise<vscode.LanguageModelChatInformation | undefined>;
            };
            const info = Object.freeze({
                max_input_tokens: 229376,
                max_output_tokens: 32768,
                context_window_tokens: 262144,
            });
            sandbox
                .stub(access, "registryEntries")
                .returns([["backend/m", { baseUrl: "https://example.com", apiKey: "test-key", rawModelName: "m" }]]);
            sandbox.stub(access._registry, "getModelInfo").returns(info);
            sandbox
                .stub(access._registry, "getDerivedCapabilities")
                .returns(deriveCapabilitiesFromModelInfo("m", info));
            const model = await access.resolveCommitModel({ commitModelIdOverride: "m" }, source.token);
            assert.strictEqual(model?.maxInputTokens, 229376);
            assert.strictEqual(model?.maxOutputTokens, 32768);
            assert.strictEqual(model?.maxContextWindowTokens, 262144);
        } finally {
            source.dispose();
            sandbox.restore();
        }
    });
});
