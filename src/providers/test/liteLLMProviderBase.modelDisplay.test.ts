import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";

import { LiteLLMChatProvider } from "../";
import { LiteLLMClient } from "../../adapters/litellmClient";
import type { LiteLLMConfig } from "../../types";

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
        // NEW: family now carries "<backendName>/<modelName>" so third-party
        // consumers (Cline et al.) that only see vendor/family can distinguish
        // BOTH backends AND individual models within them. vendor stays as
        // litellm_provider for native picker grouping.
        assert.strictEqual(models[0].family, "example/gpt-4o");
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

    test("populates pricing fields when backend returns pricing and displayPricingInPicker is enabled", async () => {
        const mockSecrets: vscode.SecretStorage = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: (_listener: unknown) => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const provider = new LiteLLMChatProvider(mockSecrets, "test-agent");

        // Force config defaults to include displayPricingInPicker: true
        const providerAny = provider as unknown as {
            _configManager: { getConfig: () => Promise<unknown> };
        };
        sandbox.stub(providerAny._configManager, "getConfig").resolves({
            inactivityTimeout: 60,
            disableCaching: true,
            disableQuotaToolRedaction: false,
            enableModelOverrides: true,
            modelCapabilitiesOverrides: {},
            forceResponsesEndpoint: false,
            allowChatCompletionsFallback: false,
            displayPricingInPicker: true,
        });

        const token = new vscode.CancellationTokenSource().token;

        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({
            data: [
                {
                    model_name: "priced-model",
                    model_info: {
                        key: "example/priced-model",
                        litellm_provider: "openai",
                        mode: "responses",
                        max_output_tokens: 4096,
                        max_input_tokens: 8192,
                        // Pricing (per-token) — will be scaled to per-1M for VS Code fields
                        input_cost_per_token: 0.000001,
                        output_cost_per_token: 0.000005,
                        cache_read_input_token_cost: 0.0000001,
                        cache_creation_input_token_cost: 0.00000125,
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
        const info = models[0] as unknown as {
            pricing?: string;
            inputCost?: number;
            outputCost?: number;
            cacheCost?: number;
            cacheWriteCost?: number;
            priceCategory?: string;
            category?: string;
            detail?: string;
            multiplierNumeric?: number;
            tooltip?: string;
            warningText?: Record<string, string>;
            infoText?: Record<string, string>;
        };

        // Per-1M scaling expectations
        assert.strictEqual(info.inputCost, 1); // $0.000001 * 1_000_000
        assert.strictEqual(info.outputCost, 5); // $0.000005 * 1_000_000
        assert.strictEqual(info.cacheCost, 0.1); // $0.0000001 * 1_000_000
        assert.strictEqual(info.cacheWriteCost, 1.25); // $0.00000125 * 1_000_000
        assert.strictEqual(info.priceCategory, "low");

        // VS Code renders `pricing` inline in its native model dropdown. Keep that
        // row focused on the model identity while preserving pricing in every other
        // picker surface and native cost metadata.
        assert.strictEqual(info.pricing, undefined);
        assert.strictEqual(info.detail, "example • $1.00/1M inp • $5.00/1M out");
        assert.strictEqual(
            info.tooltip,
            "Provider: openai, Model: priced-model via example\n" +
                "Input: $1.00/1M tokens\n" +
                "Output: $5.00/1M tokens\n" +
                "Cache read: $0.10/1M tokens\n" +
                "Cache write: $1.25/1M tokens\n" +
                "Limits: input 4,096 tokens, output 4,096 tokens"
        );
        assert.strictEqual(info.multiplierNumeric, 5);
        assert.strictEqual(info.warningText, undefined);

        // Category must remain a string to avoid picker crash
        assert.strictEqual(typeof info.category, "string");
    });

    test("emits factual optional picker metadata for a priced reasoning model", async () => {
        const mockSecrets = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: (_listener: unknown) => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;
        const provider = new LiteLLMChatProvider(mockSecrets, "test-agent");

        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({
            data: [
                {
                    model_name: "reasoning-coder",
                    model_info: {
                        key: "example/reasoning-coder",
                        litellm_provider: "anthropic",
                        mode: "responses",
                        max_input_tokens: 128000,
                        max_output_tokens: 16000,
                        supports_reasoning: true,
                        supports_function_calling: true,
                        input_cost_per_token: 0.000003,
                        output_cost_per_token: 0.000015,
                    },
                },
            ],
        });

        const models = await provider.discoverModels(
            {
                silent: true,
                configuration: { baseUrl: "https://proxy.example.com", apiKey: "test-key" },
            },
            new vscode.CancellationTokenSource().token
        );
        const info = models[0] as unknown as {
            isBYOK?: boolean;
            multiplierNumeric?: number;
            statusIcon?: vscode.ThemeIcon;
            warningText?: Record<string, string>;
            infoText?: Record<string, string>;
            requiresAuthorization?: unknown;
            isDefault?: unknown;
            targetChatSessionType?: unknown;
            promo?: unknown;
        };

        assert.strictEqual(info.isBYOK, true);
        assert.strictEqual(info.multiplierNumeric, 15);
        assert.strictEqual(info.statusIcon, undefined);
        assert.strictEqual(info.warningText, undefined);
        assert.deepStrictEqual(info.infoText, {
            routing: "Routes via LiteLLM → anthropic (proxy.example.com).",
        });
        assert.strictEqual(info.requiresAuthorization, undefined);
        assert.strictEqual(info.isDefault, undefined);
        assert.strictEqual(info.targetChatSessionType, undefined);
        assert.strictEqual(info.promo, undefined);
    });

    test("uses a tools icon and omits price metadata when only tool capability is known", async () => {
        const mockSecrets = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: (_listener: unknown) => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;
        const provider = new LiteLLMChatProvider(mockSecrets, "test-agent");

        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({
            data: [
                {
                    model_name: "tool-model",
                    model_info: {
                        key: "example/tool-model",
                        litellm_provider: "openai",
                        mode: "chat",
                        max_input_tokens: 32000,
                        max_output_tokens: 4096,
                        supports_function_calling: true,
                    },
                },
            ],
        });

        const models = await provider.discoverModels(
            {
                silent: true,
                configuration: { baseUrl: "https://proxy.example.com", apiKey: "test-key" },
            },
            new vscode.CancellationTokenSource().token
        );
        const info = models[0] as unknown as { multiplierNumeric?: number; statusIcon?: vscode.ThemeIcon };

        assert.strictEqual(info.statusIcon, undefined);
        assert.strictEqual(info.multiplierNumeric, undefined);
    });

    test("emits separate warnings for an active override and a LiteLLM-blocked model", async () => {
        const mockSecrets: vscode.SecretStorage = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: (_listener: unknown) => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;
        const provider = new LiteLLMChatProvider(mockSecrets, "test-agent");
        const providerInternals = provider as unknown as {
            _configManager: { getConfig: () => Promise<unknown> };
        };

        sandbox.stub(providerInternals._configManager, "getConfig").resolves({
            enableModelOverrides: true,
            modelCapabilitiesOverrides: {},
            displayPricingInPicker: true,
            discoveryCacheTtlMs: 0,
        });
        sandbox.stub(vscode.workspace, "getConfiguration").callsFake(() => {
            return {
                get: <T>(key: string, defaultValue?: T): T => {
                    if (key === "litellm-connector.enableModelOverrides") {
                        return true as T;
                    }
                    if (key === "litellm-connector.modelOverrides") {
                        return [{ match: "^blocked-model$", notes: "test override" }] as T;
                    }
                    return defaultValue as T;
                },
            } as vscode.WorkspaceConfiguration;
        });
        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({
            data: [
                {
                    model_name: "blocked-model",
                    litellm_params: { provider: "azure", blocked: true },
                    model_info: {
                        key: "example/blocked-model",
                        provider: "anthropic",
                        litellm_provider: "openai",
                        mode: "chat",
                        max_input_tokens: 32000,
                        max_output_tokens: 4096,
                    },
                },
                {
                    model_name: "card-blocked-model",
                    model_info: {
                        provider: "anthropic",
                        mode: "chat",
                        blocked: true,
                        max_input_tokens: 32000,
                        max_output_tokens: 4096,
                    },
                },
            ],
        });

        const models = await provider.discoverModels(
            {
                silent: true,
                configuration: { baseUrl: "https://proxy.example.com", apiKey: "test-key" },
            },
            new vscode.CancellationTokenSource().token
        );
        const info = models[0] as unknown as {
            vendor?: string;
            warningText?: Record<string, string>;
            infoText?: Record<string, string>;
            statusIcon?: vscode.ThemeIcon;
        };

        assert.strictEqual(info.vendor, "anthropic");
        assert.deepStrictEqual(info.warningText, {
            model_override: "A configured model override is active for this model.",
            model_blocked: "This model is blocked by the LiteLLM backend.",
        });
        assert.deepStrictEqual(info.infoText, {
            routing: "Routes via LiteLLM → anthropic (proxy.example.com).",
        });
        assert.strictEqual(info.statusIcon?.id, "circle-slash");

        const cardBlockedInfo = models[1] as unknown as {
            warningText?: Record<string, string>;
            statusIcon?: vscode.ThemeIcon;
        };
        assert.deepStrictEqual(cardBlockedInfo.warningText, {
            model_blocked: "This model is blocked by the LiteLLM backend.",
        });
        assert.strictEqual(cardBlockedInfo.statusIcon?.id, "circle-slash");
    });

    test("omits warning and status icon for an ordinary model and prefers provider over litellm_provider", async () => {
        const mockSecrets: vscode.SecretStorage = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: (_listener: unknown) => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;
        const provider = new LiteLLMChatProvider(mockSecrets, "test-agent");
        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({
            data: [
                {
                    model_name: "ordinary-model",
                    model_info: {
                        provider: "openai-compatible",
                        litellm_provider: "openai",
                        mode: "chat",
                        max_input_tokens: 32000,
                        max_output_tokens: 4096,
                    },
                },
            ],
        });

        const models = await provider.discoverModels(
            {
                silent: true,
                configuration: { baseUrl: "https://proxy.example.com", apiKey: "test-key" },
            },
            new vscode.CancellationTokenSource().token
        );
        const info = models[0] as unknown as {
            vendor?: string;
            warningText?: Record<string, string>;
            statusIcon?: vscode.ThemeIcon;
        };

        assert.strictEqual(info.vendor, "openai-compatible");
        assert.strictEqual(info.warningText, undefined);
        assert.strictEqual(info.statusIcon, undefined);
    });

    test("passes configured edit tools through discovery without guessing a default", async () => {
        const mockSecrets = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: (_listener: unknown) => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;
        const provider = new LiteLLMChatProvider(mockSecrets, "test-agent");
        const providerInternals = provider as unknown as {
            _configManager: { getConfig: () => Promise<LiteLLMConfig> };
        };
        sandbox.stub(providerInternals._configManager, "getConfig").resolves({
            displayPricingInPicker: true,
            discoveryCacheTtlMs: 0,
            modelCapabilitiesOverrides: {
                "coder-model": { editTools: ["apply-patch", "find-replace"] },
            },
        } as LiteLLMConfig);
        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({
            data: [
                {
                    model_name: "coder-model",
                    model_info: {
                        key: "example/coder-model",
                        litellm_provider: "openai",
                        mode: "chat",
                        max_input_tokens: 32000,
                        max_output_tokens: 4096,
                    },
                },
            ],
        });

        const models = await provider.discoverModels(
            {
                silent: true,
                configuration: { baseUrl: "https://proxy.example.com", apiKey: "test-key" },
            },
            new vscode.CancellationTokenSource().token
        );
        const capabilities = models[0].capabilities as unknown as { editTools?: string[] };

        assert.deepStrictEqual(capabilities.editTools, ["apply-patch", "find-replace"]);
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

    test("family mirrors the backend display name (distinguishable for third-party LM consumers)", async () => {
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
                        key: "localhost:4000/gpt-4o",
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
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-key" },
            },
            token
        );

        assert.strictEqual(models.length, 1);
        // family = "<backendName>/<modelName>" — embeds both the backend hostname
        // AND the model name so third-party consumers (Cline, etc.) display each
        // model uniquely. deriveGroupNameFromUrl keeps the non-default port,
        // so "http://localhost:4000" -> "localhost:4000".
        assert.strictEqual(models[0].family, "localhost:4000/gpt-4o");
        // vendor stays as the upstream litellm_provider so the native picker's
        // (vendor, groupName) grouping is preserved.
        assert.strictEqual((models[0] as unknown as { vendor: string }).vendor, "openai");
        // The backend display name is also surfaced via detail/tooltip (unchanged).
        assert.strictEqual((models[0] as unknown as { detail: string }).detail, "localhost:4000");
    });

    test("family mirrors a user-supplied group name when present", async () => {
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
                        key: "localhost:4000/gpt-4o",
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
                // groupName is surfaced by VS Code 1.120's group picker; when
                // present it takes precedence over the hostname-derived label.
                groupName: "Staging Proxy",
                configuration: { baseUrl: "http://localhost:4000", apiKey: "test-key" },
            },
            token
        );

        assert.strictEqual(models.length, 1);
        // The user-entered group name becomes backendName; combined with model name
        // to make the family value uniquely labeled.
        assert.strictEqual(models[0].family, "Staging Proxy/gpt-4o");
        assert.strictEqual((models[0] as unknown as { vendor: string }).vendor, "openai");
    });
});
