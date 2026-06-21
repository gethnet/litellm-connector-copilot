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

    test("uses namespaced id, raw model_name as the user-facing name, vendor field for picker grouping", async () => {
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

        // Picker grouping driver: the upstream chat picker (`ModelPickerWidget`
        // in `src/vs/workbench/contrib/chat/browser/widget/input/chatModelPicker.ts`)
        // groups models by `(vendor, groupName)` resolved through the
        // `ILanguageModelsService.getLanguageModelGroups()` lookup, NOT by
        // reading `metadata.category`. We assert on `vendor` here because
        // that's the field the picker actually reads. The user-visible
        // identifier of the backend is also surfaced via `detail` and
        // `tooltip` for the hover/tooltip experience.
        assert.strictEqual((models[0] as unknown as { detail: string }).detail, "example");
        assert.strictEqual(
            (models[0] as unknown as { tooltip?: string }).tooltip,
            "Provider: openai, Model: gpt-4o via example"
        );

        // Regression guard: `category` MUST be a string literal or `undefined`
        // for the picker not to crash on `getCategoryLabel`. Anything else
        // (object, null, number) triggers `TypeError: a.charAt is not a function`.
        // See `.investigate/vscode-picker-charAt-bug.md`.
        const category = (models[0] as unknown as { category?: unknown }).category;
        assert.ok(
            category === undefined || typeof category === "string",
            `category must be string | undefined, got ${typeof category}`
        );
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

    test("sets string category 'versatile' on models with tools and vision (balanced)", async () => {
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
                    model_name: "balanced-model",
                    model_info: {
                        key: "example/balanced-model",
                        litellm_provider: "openai",
                        mode: "chat",
                        max_input_tokens: 128000,
                        max_output_tokens: 4096,
                        // supports_function_calling drives supportsTools=true;
                        // supports_vision drives supportsVision=true.
                        supports_function_calling: true,
                        supports_vision: true,
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
        // The picker reads `category` via getCategoryLabel and crashes on
        // non-string values. We MUST return one of the three recognized
        // literals (or undefined).
        const info = models[0] as unknown as { category?: unknown };
        assert.strictEqual(typeof info.category, "string", "category must be a string, never undefined or null");
        assert.strictEqual(info.category, "versatile");
    });

    test("sets string category 'powerful' on reasoning-capable models", async () => {
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
                    model_name: "reasoning-model",
                    model_info: {
                        key: "example/reasoning-model",
                        litellm_provider: "openai",
                        mode: "responses",
                        max_input_tokens: 200000,
                        max_output_tokens: 16000,
                        supports_reasoning: true,
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
        const info = models[0] as unknown as { category?: unknown };
        assert.strictEqual(info.category, "powerful");
    });

    test("sets string category 'lightweight' on small models without tools/vision/reasoning", async () => {
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
                    model_name: "small-model",
                    model_info: {
                        key: "example/small-model",
                        litellm_provider: "openai",
                        mode: "chat",
                        max_input_tokens: 8000,
                        max_output_tokens: 2000,
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
        const info = models[0] as unknown as { category?: unknown };
        assert.strictEqual(info.category, "lightweight");
    });

    test("the 'unknown model_name' fallback is filtered out before reaching VS Code (picker safety net)", async () => {
        const mockSecrets: vscode.SecretStorage = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: (_listener: unknown) => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const provider = new LiteLLMChatProvider(mockSecrets, "test-agent");
        const token = new vscode.CancellationTokenSource().token;

        // Backend returns an entry with NO model_name — registry short-circuits
        // to the "unknown" fallback path with `isUserSelectable: false`. That
        // model is filtered out by discoverFromSession before reaching VS Code,
        // so the picker can never see it. This guards the indirect crash
        // vector: a non-string `category` on a filtered-out model cannot
        // reach the picker regardless of whether we tag the fallback.
        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({
            data: [
                {
                    // model_name intentionally missing
                    model_info: { litellm_provider: "openai" },
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

        assert.strictEqual(
            models.length,
            0,
            "the unknown-model fallback is not user-selectable and must be filtered before reaching VS Code"
        );
    });
});
