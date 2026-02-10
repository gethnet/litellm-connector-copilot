import * as assert from "assert";
import type * as vscode from "vscode";
import * as sinon from "sinon";
import { LiteLLMChatProvider } from "../../providers";
import type { LiteLLMModelInfo } from "../../types";

/**
 * Test helper interface for accessing private getModelTags method.
 * This provides clear typing for the reflection-based access pattern.
 */
interface ProviderWithGetModelTags {
    getModelTags: (modelId: string, modelInfo?: LiteLLMModelInfo, overrides?: Record<string, string[]>) => string[];
}

/**
 * Helper function to call private getModelTags method via type-safe reflection.
 * Explains the intent: we're testing a private method that calculates model capability tags.
 */
function callGetModelTags(
    provider: LiteLLMChatProvider,
    modelId: string,
    modelInfo?: LiteLLMModelInfo,
    overrides?: Record<string, string[]>
): string[] {
    return (provider as unknown as ProviderWithGetModelTags).getModelTags(modelId, modelInfo, overrides);
}

suite("Model Tags Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

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

    test("getModelTags adds inline-completions for chat models with streaming", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        const modelInfo: LiteLLMModelInfo = {
            mode: "chat",
            supports_native_streaming: true,
        };

        const tags = callGetModelTags(provider, "gpt-4", modelInfo);

        assert.ok(tags.includes("inline-completions"));
        assert.ok(tags.includes("terminal-chat"));
    });

    test("getModelTags adds inline-edit for coder models", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        const modelInfo: LiteLLMModelInfo = {
            mode: "chat",
            supports_native_streaming: true,
        };

        const tags = callGetModelTags(provider, "claude-coder", modelInfo);

        assert.ok(tags.includes("inline-edit"));
    });

    test("getModelTags adds tools tag for function-calling models", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        const modelInfo: LiteLLMModelInfo = {
            mode: "chat",
            supports_function_calling: true,
        };

        const tags = callGetModelTags(provider, "gpt-4", modelInfo);

        assert.ok(tags.includes("tools"));
    });

    test("getModelTags adds tools tag for vision-capable models", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        const modelInfo: LiteLLMModelInfo = {
            mode: "chat",
            supports_vision: true,
        };

        const tags = callGetModelTags(provider, "gpt-4-vision", modelInfo);

        assert.ok(tags.includes("tools"));
    });

    test("getModelTags applies user overrides", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        const modelInfo: LiteLLMModelInfo = {
            mode: "chat",
            supports_native_streaming: true,
        };

        const overrides = {
            "gpt-4": ["scm-generator", "inline-edit", "custom-tag"],
        };

        const tags = callGetModelTags(provider, "gpt-4", modelInfo, overrides);

        assert.ok(tags.includes("scm-generator"));
        assert.ok(tags.includes("inline-edit"));
        assert.ok(tags.includes("custom-tag"));
    });

    test("getModelTags returns empty for non-streaming models", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        const modelInfo: LiteLLMModelInfo = {
            mode: "chat",
            supports_native_streaming: false,
        };

        const tags = callGetModelTags(provider, "gpt-4", modelInfo);

        assert.strictEqual(tags.length, 0);
    });

    test("getModelTags handles models with no info", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        const tags = callGetModelTags(provider, "unknown-model");

        assert.strictEqual(tags.length, 0);
    });

    test("getModelTags combines defaults with overrides", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        const modelInfo: LiteLLMModelInfo = {
            mode: "chat",
            supports_native_streaming: true,
            supports_function_calling: true,
        };

        const overrides = {
            "coder-model": ["scm-generator"],
        };

        const tags = callGetModelTags(provider, "coder-model", modelInfo, overrides);

        assert.ok(tags.includes("inline-edit"));
        assert.ok(tags.includes("tools"));
        assert.ok(tags.includes("inline-completions"));
        assert.ok(tags.includes("scm-generator"));
    });
});
