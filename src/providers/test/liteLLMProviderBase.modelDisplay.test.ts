import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";

import { LiteLLMChatProvider } from "../";
import { LiteLLMClient } from "../../adapters/litellmClient";

suite("LiteLLM model display", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("uses backend:model as the user-facing `name` when models are namespaced", async () => {
        const mockSecrets: vscode.SecretStorage = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: (_listener: unknown) => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const provider = new LiteLLMChatProvider(mockSecrets, "test-agent");
        const token = new vscode.CancellationTokenSource().token;

        // Stub MultiBackendClient.prototype.getModelInfoAll to return test data
        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({
            data: [
                {
                    model_name: "gpt-4o",
                    model_info: {
                        key: "example/gpt-4o",
                        litellm_provider: "openai",
                        mode: "responses",
                        rawContextWindow: 8192,
                        maxOutputTokens: 4096,
                    },
                },
            ],
        });

        const models = await provider.discoverModels(
            {
                silent: true,
                // Routing identity is now derived from the URL hostname ("example"), not the
                // legacy `providerName: "cloud"` field. The `category.label` falls back to the
                // hostname when no `groupName` is provided.
                configuration: { baseUrl: "http://example", apiKey: "test-key" },
            },
            token
        );

        assert.strictEqual(models.length, 1);
        assert.strictEqual(models[0].id, "example/gpt-4o");
        assert.strictEqual(models[0].name, "gpt-4o");
        assert.strictEqual((models[0] as unknown as { vendor: string }).vendor, "openai");
        // Models must be flagged as user-selectable so they appear in the VS Code 1.120 model
        // picker dropdown. Without this, models only show in the "Manage Language Models" view.
        assert.strictEqual((models[0] as unknown as { isUserSelectable?: boolean }).isUserSelectable, true);
        // Each backend gets its own category heading in the picker so models from different
        // proxies are visually grouped. The label uses the user's backend name.
        assert.deepStrictEqual((models[0] as unknown as { category?: { label: string; order: number } }).category, {
            label: "example",
            order: 0,
        });
    });

    test("adds cache indicator to detail string for models with prompt caching support", async () => {
        const mockSecrets: vscode.SecretStorage = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: (_listener: unknown) => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const provider = new LiteLLMChatProvider(mockSecrets, "test-agent");
        const token = new vscode.CancellationTokenSource().token;

        // Stub MultiBackendClient.prototype.getModelInfoAll to return test data with cache support
        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({
            data: [
                {
                    model_name: "gpt-4",
                    model_info: {
                        key: "example/gpt-4",
                        litellm_provider: "openai",
                        supports_prompt_caching: true,
                        mode: "chat",
                        max_input_tokens: 128000,
                        max_output_tokens: 4096,
                        supports_system_messages: true,
                    },
                },
            ],
        });

        const models = await provider.discoverModels(
            {
                silent: true,
                configuration: { baseUrl: "http://example", apiKey: "test-key" },
            },
            token
        );

        assert.strictEqual(models.length, 1);
        const model = models[0];
        assert.strictEqual((model as unknown as { detail: string }).detail, "⚡ example");
        assert.strictEqual(
            (model as unknown as { tooltip?: string }).tooltip,
            "Provider: openai, Model: gpt-4 via example"
        );
    });

    test("does not add cache indicator to detail string for models without prompt caching support", async () => {
        const mockSecrets: vscode.SecretStorage = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: (_listener: unknown) => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const provider = new LiteLLMChatProvider(mockSecrets, "test-agent");
        const token = new vscode.CancellationTokenSource().token;

        // Stub MultiBackendClient.prototype.getModelInfoAll to return test data without cache support
        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({
            data: [
                {
                    model_name: "gpt-3.5-turbo",
                    model_info: {
                        key: "localhost:4000/gpt-3.5-turbo",
                        litellm_provider: "openai",
                        supports_prompt_caching: false,
                        mode: "chat",
                        max_input_tokens: 16385,
                        max_output_tokens: 2048,
                        supports_system_messages: true,
                    },
                },
            ],
        });

        const models = await provider.discoverModels(
            {
                silent: true,
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-key" },
            },
            token
        );

        assert.strictEqual(models.length, 1);
        const model = models[0];
        assert.strictEqual((model as unknown as { detail: string }).detail, "localhost:4000");
        assert.strictEqual(
            (model as unknown as { tooltip?: string }).tooltip,
            "Provider: openai, Model: gpt-3.5-turbo via localhost:4000"
        );
    });
});
