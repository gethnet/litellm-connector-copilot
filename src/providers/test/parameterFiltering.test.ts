import * as assert from "assert";
import type * as vscode from "vscode";
import { LiteLLMChatProvider } from "../";

suite("Regression: GPT-5 and O1 Parameter Filtering", () => {
    const mockSecrets: vscode.SecretStorage = {
        get: async (key: string) => {
            if (key === "litellm-connector.baseUrl") {
                return "http://localhost:4000";
            }
            if (key === "litellm-connector.apiKey") {
                return "test-api-key";
            }
            return undefined;
        },
        store: async () => {},
        delete: async () => {},
        onDidChange: (_listener: unknown) => ({ dispose() {} }),
    } as unknown as vscode.SecretStorage;

    const userAgent = "GitHubCopilotChat/test VSCode/test";

    test("should filter temperature for gpt-5.4", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const modelId = "gpt-5.4";

        // Access protected method via cast
        const isSupported = (
            provider as unknown as { isParameterSupported: (p: string, i: unknown, id: string) => boolean }
        ).isParameterSupported("temperature", undefined, modelId);
        assert.strictEqual(isSupported, false, "temperature should NOT be supported for gpt-5.4");
    });

    test("should filter temperature for o1-preview", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const modelId = "o1-preview";

        const isSupported = (
            provider as unknown as { isParameterSupported: (p: string, i: unknown, id: string) => boolean }
        ).isParameterSupported("temperature", undefined, modelId);
        assert.strictEqual(isSupported, false, "temperature should NOT be supported for o1-preview");
    });

    test("should filter temperature for o1-2024-12-17", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const modelId = "o1-2024-12-17";

        const isSupported = (
            provider as unknown as { isParameterSupported: (p: string, i: unknown, id: string) => boolean }
        ).isParameterSupported("temperature", undefined, modelId);
        assert.strictEqual(isSupported, false, "temperature should NOT be supported for o1-2024-12-17");
    });

    test("should filter temperature for gpt-5.1-codex", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const modelId = "gpt-5.1-codex";

        const isSupported = (
            provider as unknown as { isParameterSupported: (p: string, i: unknown, id: string) => boolean }
        ).isParameterSupported("temperature", undefined, modelId);
        assert.strictEqual(isSupported, false, "temperature should NOT be supported for gpt-5.1-codex");
    });
});
