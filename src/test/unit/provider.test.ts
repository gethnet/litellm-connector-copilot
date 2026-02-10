import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { LiteLLMChatModelProvider } from "../../providers/liteLLMProvider";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { ResponsesClient } from "../../adapters/responsesClient";
import type { LiteLLMModelInfo } from "../../types";

suite("LiteLLM Provider Unit Tests", () => {
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

    test("clearModelCache resets model list and caches", () => {
        const provider = new LiteLLMChatModelProvider(mockSecrets, userAgent);

        // Seed caches
        (provider as unknown as { _modelInfoCache: Map<string, unknown> })._modelInfoCache.set("m1", { mode: "chat" });
        (provider as unknown as { _parameterProbeCache: Map<string, unknown> })._parameterProbeCache.set(
            "m1",
            new Set(["temperature"])
        );
        (provider as unknown as { _lastModelList: vscode.LanguageModelChatInformation[] })._lastModelList = [
            {
                id: "m1",
                name: "m1",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 1,
                maxOutputTokens: 1,
                capabilities: { toolCalling: true, imageInput: false },
            },
        ];

        provider.clearModelCache();
        assert.strictEqual(provider.getLastKnownModels().length, 0);
        assert.strictEqual((provider as unknown as { _modelInfoCache: Map<string, unknown> })._modelInfoCache.size, 0);
        assert.strictEqual(
            (provider as unknown as { _parameterProbeCache: Map<string, unknown> })._parameterProbeCache.size,
            0
        );
    });

    test("provideLanguageModelChatResponse uses modelIdOverride when present in config", async () => {
        const provider = new LiteLLMChatModelProvider(mockSecrets, userAgent);

        // Seed last model list with an override model.
        (provider as unknown as { _lastModelList: vscode.LanguageModelChatInformation[] })._lastModelList = [
            {
                id: "override-model",
                name: "override-model",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 100,
                maxOutputTokens: 100,
                capabilities: { toolCalling: true, imageInput: false },
            },
        ];

        // Stub ConfigManager to return a config with modelIdOverride.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const configManager = (provider as any)._configManager as {
            convertProviderConfiguration: (c: Record<string, unknown>) => unknown;
        };
        sandbox.stub(configManager, "convertProviderConfiguration").returns({
            url: "http://localhost:4000",
            key: "k",
            disableQuotaToolRedaction: false,
            disableCaching: true,
            inactivityTimeout: 60,
            modelOverrides: {},
            modelIdOverride: "override-model",
        });

        // Prevent network calls: stub the low-level client to return a minimal ReadableStream.
        // We only need to assert that the request model id is the override.
        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        chatStub.callsFake(async (...args: unknown[]) => {
            const requestBody = args[0] as { model: string };
            assert.strictEqual(requestBody.model, "override-model");

            const encoder = new TextEncoder();
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                },
            });
        });

        // Ensure we don't accidentally go down the /responses path in this test.
        sandbox.stub(ResponsesClient.prototype, "sendResponsesRequest").resolves();

        const modelSelected: vscode.LanguageModelChatInformation = {
            id: "selected-model",
            name: "selected-model",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 100,
            maxOutputTokens: 100,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        await provider.provideLanguageModelChatResponse(
            modelSelected,
            messages,
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                configuration: { baseUrl: "x" },
            },
            { report: () => {} },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(chatStub.called, true);
    });

    test("provideLanguageModelChatInformation returns array (no key -> empty)", async () => {
        const emptySecrets = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: (_listener: unknown) => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const provider = new LiteLLMChatModelProvider(emptySecrets, userAgent);
        const infos = await provider.provideLanguageModelChatInformation(
            { silent: true },
            new vscode.CancellationTokenSource().token
        );
        assert.ok(Array.isArray(infos));
        assert.strictEqual(infos.length, 0);
    });

    test("provideLanguageModelChatInformation handles missing URL", async () => {
        const emptySecrets = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: (_listener: unknown) => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const provider = new LiteLLMChatModelProvider(emptySecrets, userAgent);
        const infos = await provider.provideLanguageModelChatInformation(
            { silent: false },
            new vscode.CancellationTokenSource().token
        );
        assert.strictEqual(infos.length, 0, "Should return 0 models when URL is missing");
    });

    test("buildCapabilities maps model_info flags correctly", () => {
        const provider = new LiteLLMChatModelProvider(mockSecrets, userAgent);
        const buildCapabilities = (
            provider as unknown as {
                buildCapabilities: (modelInfo: unknown) => vscode.LanguageModelChatCapabilities;
            }
        ).buildCapabilities.bind(provider);

        assert.deepEqual(buildCapabilities({ supports_vision: true, supports_function_calling: true }), {
            toolCalling: true,
            imageInput: true,
        });

        assert.deepEqual(buildCapabilities({ supports_vision: false, supports_function_calling: true }), {
            toolCalling: true,
            imageInput: false,
        });

        assert.deepEqual(buildCapabilities(undefined), {
            toolCalling: true,
            imageInput: false,
        });
    });

    test("parseApiError extracts meaningful error messages", () => {
        const provider = new LiteLLMChatModelProvider(mockSecrets, userAgent);
        const parseApiError = (
            provider as unknown as {
                parseApiError: (statusCode: number, errorText: string) => string;
            }
        ).parseApiError.bind(provider);

        const jsonError = JSON.stringify({ error: { message: "Temperature not supported" } });
        assert.strictEqual(parseApiError(400, jsonError), "Temperature not supported");

        const longError = "x".repeat(300);
        assert.strictEqual(parseApiError(400, longError).length, 200);

        assert.strictEqual(parseApiError(400, ""), "API request failed with status 400");
    });

    test("getModelTags adds inline-completions for streaming chat models", () => {
        const provider = new LiteLLMChatModelProvider(mockSecrets, userAgent);

        interface ProviderForTagTesting {
            getModelTags: (
                modelId: string,
                modelInfo?: LiteLLMModelInfo,
                overrides?: Record<string, string[]>
            ) => string[];
        }
        const getModelTags = (provider as unknown as ProviderForTagTesting).getModelTags.bind(provider);

        const tags = getModelTags("test-model", {
            mode: "chat",
            supports_native_streaming: true,
        });
        assert.ok(tags.includes("inline-completions"), "Streaming chat models should have inline-completions tag");
    });

    test("getModelTags applies user overrides", () => {
        const provider = new LiteLLMChatModelProvider(mockSecrets, userAgent);

        interface ProviderForTagTesting {
            getModelTags: (
                modelId: string,
                modelInfo?: LiteLLMModelInfo,
                overrides?: Record<string, string[]>
            ) => string[];
        }
        const getModelTags = (provider as unknown as ProviderForTagTesting).getModelTags.bind(provider);

        const overrides = { "test-model": ["custom-tag"] };
        const tags = getModelTags("test-model", undefined, overrides);
        assert.ok(tags.includes("custom-tag"), "User-defined override tags should be included in result");
    });

    test("stripUnsupportedParametersFromRequest removes known unsupported params", () => {
        const provider = new LiteLLMChatModelProvider(mockSecrets, userAgent);
        const strip = (
            provider as unknown as {
                stripUnsupportedParametersFromRequest: (
                    requestBody: Record<string, unknown>,
                    modelInfo: unknown,
                    modelId?: string
                ) => void;
            }
        ).stripUnsupportedParametersFromRequest.bind(provider);

        const requestBody: Record<string, unknown> = {
            temperature: 0.9,
            stop: ["\n"],
            frequency_penalty: 0.5,
        };

        const modelInfo = { supported_openai_params: ["temperature", "stop", "frequency_penalty"] };
        strip(requestBody, modelInfo, "gpt-5.1-codex-mini");

        assert.strictEqual(requestBody.temperature, undefined);
        assert.strictEqual(requestBody.frequency_penalty, undefined);
        assert.deepStrictEqual(requestBody.stop, ["\n"]);
    });

    test("stripUnsupportedParametersFromRequest handles o1 models", () => {
        const provider = new LiteLLMChatModelProvider(mockSecrets, userAgent);
        const strip = (
            provider as unknown as {
                stripUnsupportedParametersFromRequest: (
                    requestBody: Record<string, unknown>,
                    modelInfo: unknown,
                    modelId?: string
                ) => void;
            }
        ).stripUnsupportedParametersFromRequest.bind(provider);

        const requestBody: Record<string, unknown> = {
            temperature: 1.0,
            top_p: 1.0,
            presence_penalty: 0.0,
            max_tokens: 1000,
        };

        // o1 models shouldn't have temperature, top_p, or penalties
        strip(requestBody, undefined, "o1-mini");

        assert.strictEqual(requestBody.temperature, undefined);
        assert.strictEqual(requestBody.top_p, undefined);
        assert.strictEqual(requestBody.presence_penalty, undefined);
        assert.strictEqual(requestBody.max_tokens, 1000);
    });

    test("detectQuotaToolRedaction removes failing tool when enabled", () => {
        const provider = new LiteLLMChatModelProvider(mockSecrets, userAgent);
        const detect = (
            provider as unknown as {
                detectQuotaToolRedaction: (
                    messages: readonly vscode.LanguageModelChatRequestMessage[],
                    tools: readonly vscode.LanguageModelChatTool[],
                    requestId: string,
                    modelId: string,
                    disableRedaction: boolean
                ) => { tools: readonly vscode.LanguageModelChatTool[] };
            }
        ).detectQuotaToolRedaction.bind(provider);

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("Free tier quota exceeded for insert_edit_into_file")],
            },
        ];
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "insert_edit_into_file", description: "", inputSchema: {} },
            { name: "replace_string_in_file", description: "", inputSchema: {} },
        ];

        const result = detect(messages, tools, "req-1", "model-1", false);
        assert.strictEqual(result.tools.length, 1);
        assert.strictEqual(result.tools[0].name, "replace_string_in_file");
    });

    test("detectQuotaToolRedaction does not remove tool when disabled", () => {
        const provider = new LiteLLMChatModelProvider(mockSecrets, userAgent);
        const detect = (
            provider as unknown as {
                detectQuotaToolRedaction: (
                    messages: readonly vscode.LanguageModelChatRequestMessage[],
                    tools: readonly vscode.LanguageModelChatTool[],
                    requestId: string,
                    modelId: string,
                    disableRedaction: boolean
                ) => { tools: readonly vscode.LanguageModelChatTool[] };
            }
        ).detectQuotaToolRedaction.bind(provider);

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("Free tier quota exceeded for insert_edit_into_file")],
            },
        ];
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "insert_edit_into_file", description: "", inputSchema: {} },
            { name: "replace_string_in_file", description: "", inputSchema: {} },
        ];

        const result = detect(messages, tools, "req-2", "model-1", true);
        assert.strictEqual(result.tools.length, 2);
        assert.strictEqual(result.tools[0].name, "insert_edit_into_file");
        assert.strictEqual(result.tools[1].name, "replace_string_in_file");
    });

    test("Configuration passed through options is preferred over secret storage", () => {
        // Create a config via convertProviderConfiguration
        const providerConfig = {
            baseUrl: "https://api.litellm.ai",
            apiKey: "sk-provider-key",
        };

        // This would be called internally when VS Code passes configuration through options
        // We're testing that the conversion works properly
        const provider = new LiteLLMChatModelProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const configManager = (provider as any)._configManager;
        const convertedConfig = configManager.convertProviderConfiguration(providerConfig);

        assert.strictEqual(convertedConfig.url, "https://api.litellm.ai");
        assert.strictEqual(convertedConfig.key, "sk-provider-key");
    });

    test("provideLanguageModelChatInformation includes tags in model info", async () => {
        const provider = new LiteLLMChatModelProvider(mockSecrets, userAgent);

        const mockData = [
            {
                model_name: "gpt-4",
                model_info: {
                    id: "gpt-4",
                    mode: "chat",
                    supports_native_streaming: true,
                    supports_function_calling: true,
                } as LiteLLMModelInfo,
            },
            {
                model_name: "claude-coder",
                model_info: {
                    id: "claude-coder",
                    mode: "chat",
                    supports_native_streaming: true,
                } as LiteLLMModelInfo,
            },
        ];

        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({ data: mockData });

        const infos = await provider.provideLanguageModelChatInformation({ silent: true }, {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose() {} }),
        } as vscode.CancellationToken);

        assert.strictEqual(infos.length, 2);

        // Model info with optional tags extension
        interface ModelInfoWithTags {
            tags?: string[];
        }

        // Check first model (gpt-4) has tools and completions tags
        const gpt4 = infos[0] as ModelInfoWithTags;
        const gpt4Tags = gpt4.tags || [];
        assert.ok(gpt4Tags.includes("tools"), "gpt-4 should have tools tag for function-calling capability");
        assert.ok(gpt4Tags.includes("inline-completions"), "gpt-4 should have inline-completions tag for streaming");

        // Check second model (claude-coder) has inline-edit tag
        const claude = infos[1] as ModelInfoWithTags;
        const claudeTags = claude.tags || [];
        assert.ok(
            claudeTags.includes("inline-edit"),
            "claude-coder should have inline-edit tag (name contains 'coder')"
        );
        assert.ok(
            claudeTags.includes("inline-completions"),
            "claude-coder should have inline-completions tag for streaming"
        );
    });

    test("provideLanguageModelChatInformation applies model overrides to tags", async () => {
        const provider = new LiteLLMChatModelProvider(mockSecrets, userAgent);

        const mockData = [
            {
                model_name: "gpt-4",
                model_info: {
                    id: "gpt-4",
                    mode: "chat",
                    supports_native_streaming: true,
                } as LiteLLMModelInfo,
            },
        ];

        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({ data: mockData });

        // Stub config manager to return model overrides
        interface ConfigManager {
            getConfig: () => Promise<{ url: string; modelOverrides: Record<string, string[]> }>;
        }
        interface ProviderWithConfigManager {
            _configManager: ConfigManager;
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            modelOverrides: {
                "gpt-4": ["scm-generator", "custom-tag"],
            },
        });

        const infos = await provider.provideLanguageModelChatInformation({ silent: true }, {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose() {} }),
        } as vscode.CancellationToken);

        assert.strictEqual(infos.length, 1);

        interface ModelInfoWithTags {
            tags?: string[];
        }
        const gpt4 = infos[0] as ModelInfoWithTags;
        const gpt4Tags = gpt4.tags || [];
        assert.ok(gpt4Tags.includes("scm-generator"), "Should include scm-generator override tag from config");
        assert.ok(gpt4Tags.includes("custom-tag"), "Should include custom-tag override tag from config");
    });
});
