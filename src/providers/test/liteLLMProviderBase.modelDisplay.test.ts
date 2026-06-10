import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";

import { LiteLLMChatProvider } from "../";
import { LiteLLMClient } from "../../adapters/litellmClient";

/**
 * Tests for the user-facing model display properties in the single-provider
 * architecture. The model id returned to VS Code is namespaced
 * `<routingIdentity>/<rawModelName>` so the response path can route
 * unambiguously. The `name` field shown to the user is the raw model
 * name only (no namespace leak). The picker groups models via
 * `category.label` which is the user-entered group name (or URL hostname
 * fallback).
 */
suite("LiteLLM model display", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("uses namespaced id, raw model_name as the user-facing name, URL hostname for category label", async () => {
        const mockSecrets: vscode.SecretStorage = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: (_listener: unknown) => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const provider = new LiteLLMChatProvider(mockSecrets, "test-agent");
        const token = new vscode.CancellationTokenSource().token;

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
                configuration: { baseUrl: "http://example", apiKey: "test-key" },
            },
            token
        );

        assert.strictEqual(models.length, 1);
        // The model id VS Code receives is namespaced
        // (`<routingIdentity>/<rawModelName>`) so the response path can
        // route unambiguously. The `name` is the raw model name only —
        // the user does not see the routing prefix in the picker.
        assert.strictEqual(models[0].id, "example/gpt-4o");
        assert.strictEqual(models[0].name, "gpt-4o");
        assert.strictEqual((models[0] as unknown as { vendor: string }).vendor, "openai");
        assert.strictEqual((models[0] as unknown as { isUserSelectable?: boolean }).isUserSelectable, true);
        // category.label is the URL hostname so the picker groups by backend.
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
        // detail = cacheIndicator + backendName
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
