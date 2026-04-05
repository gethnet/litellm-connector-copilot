import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { LiteLLMChatProvider } from "../";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { MultiBackendClient } from "../../adapters/multiBackendClient";
import { ResponsesClient } from "../../adapters/responsesClient";
import type { ConfigManager } from "../../config/configManager";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest, ResolvedBackend } from "../../types";

suite("LiteLLM Provider Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;
    let settingsMap: Map<string, unknown>;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    setup(() => {
        settingsMap = new Map<string, unknown>();
        // Default: no canonical baseUrl configured unless a test sets it explicitly.
        sandbox.stub(vscode.workspace, "getConfiguration").returns({
            get: (key: string, defaultValue?: unknown) => (settingsMap.has(key) ? settingsMap.get(key) : defaultValue),
            update: async (key: string, value: unknown) => {
                if (value === undefined) {
                    settingsMap.delete(key);
                } else {
                    settingsMap.set(key, value);
                }
            },
            has: (key: string) => settingsMap.has(key),
        } as unknown as vscode.WorkspaceConfiguration);
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

    test("buildOpenAIChatRequest respects sendDefaultParameters = false (default)", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const build = (provider as any).buildOpenAIChatRequest.bind(provider);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const configManager = (provider as any)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            sendDefaultParameters: false,
        });

        const model = {
            id: "gpt-4",
            maxInputTokens: 8192,
            maxOutputTokens: 4096,
        } as vscode.LanguageModelChatInformation;

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hello")],
                name: undefined,
            },
        ];

        const request = await build(messages, model, {
            modelOptions: {},
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions);
        assert.strictEqual(
            request.temperature,
            undefined,
            "Temperature should be undefined when sendDefaultParameters is false"
        );
        assert.strictEqual(
            request.frequency_penalty,
            undefined,
            "frequency_penalty should be undefined when sendDefaultParameters is false"
        );
        assert.strictEqual(
            request.presence_penalty,
            undefined,
            "presence_penalty should be undefined when sendDefaultParameters is false"
        );
    });

    test("buildOpenAIChatRequest respects sendDefaultParameters = true", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const build = (provider as any).buildOpenAIChatRequest.bind(provider);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const configManager = (provider as any)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            sendDefaultParameters: true,
        });

        const model = {
            id: "gpt-4",
            maxInputTokens: 8192,
            maxOutputTokens: 4096,
        } as vscode.LanguageModelChatInformation;

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hello")],
                name: undefined,
            },
        ];

        const request = await build(messages, model, {
            modelOptions: {},
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions);
        assert.strictEqual(request.temperature, 0.7, "Temperature should be 0.7 when sendDefaultParameters is true");
        assert.strictEqual(
            request.frequency_penalty,
            0.2,
            "frequency_penalty should be 0.2 when sendDefaultParameters is true"
        );
        assert.strictEqual(
            request.presence_penalty,
            0.1,
            "presence_penalty should be 0.1 when sendDefaultParameters is true"
        );
    });

    test("buildOpenAIChatRequest prefers modelOptions over defaults", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const build = (provider as any).buildOpenAIChatRequest.bind(provider);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const configManager = (provider as any)._configManager;
        sandbox.stub(configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            sendDefaultParameters: true,
        });

        const model = {
            id: "gpt-4",
            maxInputTokens: 8192,
            maxOutputTokens: 4096,
        } as vscode.LanguageModelChatInformation;

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hello")],
                name: undefined,
            },
        ];

        const request = await build(messages, model, {
            modelOptions: {
                temperature: 0.5,
                frequency_penalty: 0.8,
                presence_penalty: undefined,
            },
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions);
        assert.strictEqual(request.temperature, 0.5, "Should use provided temperature 0.5");
        assert.strictEqual(request.frequency_penalty, 0.8, "Should use provided frequency_penalty 0.8");
        assert.strictEqual(request.presence_penalty, 0.1, "Should use default presence_penalty 0.1");
    });

    test("clearModelCache resets model list and caches", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

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
                tags: ["tools"],
            } as unknown as vscode.LanguageModelChatInformation,
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
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        // Seed canonical baseUrl so provider does not fail early.
        await vscode.workspace
            .getConfiguration()
            .update("litellm-connector.baseUrl", "http://localhost:4000", vscode.ConfigurationTarget.Global);

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
                tags: ["tools"],
            } as unknown as vscode.LanguageModelChatInformation,
        ];

        // Stub ConfigManager to return a config with modelIdOverride.
        const configManager = (provider as unknown as { _configManager: unknown })._configManager as {
            getConfig: () => Promise<unknown>;
        };
        sandbox.stub(configManager, "getConfig").resolves({
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
        chatStub.callsFake(async (request: OpenAIChatCompletionRequest) => {
            const requestBody = request as { model: string };
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

        // Ensure canonical baseUrl exists so provider doesn't fail before applying model override.
        await vscode.workspace
            .getConfiguration()
            .update("litellm-connector.baseUrl", "http://example", vscode.ConfigurationTarget.Global);

        await provider.provideLanguageModelChatResponse(
            modelSelected,
            messages,
            {
                modelOptions: {},
                tools: [],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
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

        const provider = new LiteLLMChatProvider(emptySecrets, userAgent);
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

        const provider = new LiteLLMChatProvider(emptySecrets, userAgent);

        // When silent=false and baseUrl is missing, the provider should trigger the classic configuration flow.
        const execStub = sandbox.stub(vscode.commands, "executeCommand").resolves(undefined);

        const infos = await provider.provideLanguageModelChatInformation(
            { silent: false },
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(execStub.calledWith("litellm-connector.manage"), true);
        assert.strictEqual(infos.length, 0, "Should return 0 models when URL is missing and config not completed");
    });

    test("buildCapabilities maps model_info flags correctly", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
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
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
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
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

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
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

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
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
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
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
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

    test("stripUnsupportedParametersFromRequest handles gpt-5-mini models", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
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

        // gpt-5-mini models shouldn't have temperature, top_p, or penalties
        strip(requestBody, undefined, "gpt-5-mini");

        assert.strictEqual(requestBody.temperature, undefined);
        assert.strictEqual(requestBody.top_p, undefined);
        assert.strictEqual(requestBody.presence_penalty, undefined);
        assert.strictEqual(requestBody.max_tokens, 1000);
    });

    test("detectQuotaToolRedaction removes failing tool when enabled", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
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
                content: [new vscode.LanguageModelTextPart("429 rate limit exceeded for insert_edit_into_file")],
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
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
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
                content: [new vscode.LanguageModelTextPart("429 rate limit exceeded for insert_edit_into_file")],
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

    test("provideLanguageModelChatInformation includes tags in model info", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        // Seed canonical baseUrl so discovery proceeds.
        await vscode.workspace
            .getConfiguration()
            .update("litellm-connector.baseUrl", "http://localhost:4000", vscode.ConfigurationTarget.Global);

        const mockData = [
            {
                model_name: "gpt-4",
                model_info: {
                    id: "gpt-4",
                    mode: "chat",
                    supports_native_streaming: true,
                    supports_function_calling: true,
                    supported_openai_params: ["tools"],
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

        // Check second model (claude-coder) has inline-edit tag
        const claude = infos[1] as { tags?: string[] };
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
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

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

        // The provider now uses MultiBackendClient which calls getModelInfo on each backend
        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({ data: mockData });

        // Stub config manager to return model overrides with namespaced ID
        interface ConfigManager {
            getConfig: () => Promise<{ url: string; modelOverrides: Record<string, string[]> }>;
            resolveBackends: () => Promise<ResolvedBackend[]>;
        }
        interface ProviderWithConfigManager {
            _configManager: ConfigManager;
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox
            .stub(providerWithConfig._configManager, "resolveBackends")
            .resolves([{ name: "default", url: "http://localhost:4000", apiKey: "test-key", enabled: true }]);
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            modelOverrides: {
                "default/gpt-4": ["scm-generator", "custom-tag"],
            },
        } as unknown as { url: string; modelOverrides: Record<string, string[]> });

        const infos = await provider.provideLanguageModelChatInformation({ silent: true }, {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose() {} }),
        } as vscode.CancellationToken);

        assert.strictEqual(infos.length, 1);
        assert.strictEqual(infos[0].id, "default/gpt-4");

        interface ModelInfoWithTags {
            tags?: string[];
        }
        const gpt4 = infos[0] as ModelInfoWithTags;
        const gpt4Tags = gpt4.tags || [];
        assert.ok(gpt4Tags.includes("scm-generator"), "Should include scm-generator override tag from config");
        assert.ok(gpt4Tags.includes("custom-tag"), "Should include custom-tag override tag from config");
    });

    test("provideLanguageModelChatInformation returns empty when /model/info data is invalid", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({ data: undefined } as never);

        const infos = await provider.provideLanguageModelChatInformation({ silent: true }, {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose() {} }),
        } as vscode.CancellationToken);

        assert.ok(Array.isArray(infos));
        assert.strictEqual(infos.length, 0);
    });

    test("provideLanguageModelChatInformation returns empty when /model/info throws", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").rejects(new Error("network"));

        const infos = await provider.provideLanguageModelChatInformation({ silent: true }, {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose() {} }),
        } as vscode.CancellationToken);

        assert.ok(Array.isArray(infos));
        assert.strictEqual(infos.length, 0);
    });

    test("detectQuotaToolRedaction does not redact when quota tool is not present", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
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
                content: [new vscode.LanguageModelTextPart("quota exceeded for insert_edit_into_file")],
            },
        ];
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "replace_string_in_file", description: "", inputSchema: {} },
        ];

        const result = detect(messages, tools, "req-3", "model-1", false);
        assert.strictEqual(result.tools.length, 1);
        assert.strictEqual(result.tools[0].name, "replace_string_in_file");
    });

    test("detectQuotaToolRedaction does not redact when message has no text", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
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
                // Empty content -> collectMessageText returns "" -> branch continues
                content: [],
            },
        ];
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "insert_edit_into_file", description: "", inputSchema: {} },
        ];

        const result = detect(messages, tools, "req-4", "model-1", false);
        assert.strictEqual(result.tools.length, 1);
        assert.strictEqual(result.tools[0].name, "insert_edit_into_file");
    });

    test("detectQuotaToolRedaction does not redact when quota regex does not match", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
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
                content: [new vscode.LanguageModelTextPart("some other error insert_edit_into_file")],
            },
        ];
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "insert_edit_into_file", description: "", inputSchema: {} },
        ];

        const result = detect(messages, tools, "req-5", "model-1", false);
        assert.strictEqual(result.tools.length, 1);
        assert.strictEqual(result.tools[0].name, "insert_edit_into_file");
    });

    test("detectQuotaToolRedaction does not redact when tool regex does not match", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
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
                content: [new vscode.LanguageModelTextPart("quota exceeded for some_other_tool")],
            },
        ];
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "insert_edit_into_file", description: "", inputSchema: {} },
        ];

        const result = detect(messages, tools, "req-6", "model-1", false);
        assert.strictEqual(result.tools.length, 1);
        assert.strictEqual(result.tools[0].name, "insert_edit_into_file");
    });

    test("detectQuotaToolRedaction does not redact on echoed Copilot context without rate/quota signal", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
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

        const echoed =
            "<context>some huge context</context>\n" +
            "<editorContext>file stuff</editorContext>\n" +
            "tool insert_edit_into_file failed";

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: [new vscode.LanguageModelTextPart(echoed)],
            },
        ];
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "insert_edit_into_file", description: "", inputSchema: {} },
            { name: "replace_string_in_file", description: "", inputSchema: {} },
        ];

        const result = detect(messages, tools, "req-echo", "model-1", false);
        assert.strictEqual(result.tools.length, 2);
    });

    test("isParameterSupported returns false when parameter probe cache indicates unsupported", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const isSupported = (
            provider as unknown as {
                isParameterSupported: (param: string, modelInfo: unknown, modelId?: string) => boolean;
            }
        ).isParameterSupported.bind(provider);

        // Seed cache to indicate 'temperature' is unsupported.
        (provider as unknown as { _parameterProbeCache: Map<string, Set<string>> })._parameterProbeCache.set(
            "gpt-5.2",
            new Set(["temperature"])
        );

        assert.strictEqual(isSupported("temperature", { supported_openai_params: ["temperature"] }, "gpt-5.2"), false);
    });

    test("isParameterSupported returns false when modelId matches known model limitations substring", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const isSupported = (
            provider as unknown as {
                isParameterSupported: (param: string, modelInfo: unknown, modelId?: string) => boolean;
            }
        ).isParameterSupported.bind(provider);

        // Use a model id that should match a known limitations key via substring.
        assert.strictEqual(isSupported("temperature", undefined, "o1-preview"), false);
    });

    test("stripUnsupportedParametersFromRequest removes cache keys inside extra_body and deletes empty containers", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
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
            cache: { "no-cache": true },
            extra_body: { cache: { "no-cache": true, no_cache: true } },
        };

        strip(requestBody, undefined, "any");

        assert.ok(!("cache" in requestBody));
        assert.ok(!("extra_body" in requestBody));
    });

    test("provideTokenCount uses local counting for small strings", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const countTokensSpy = sandbox.spy(LiteLLMClient.prototype, "countTokens");

        const model = { id: "test-model" } as vscode.LanguageModelChatInformation;
        const text = "short text";
        const token = { isCancellationRequested: false } as vscode.CancellationToken;

        const count = await provider.provideTokenCount(model, text, token);

        assert.ok(count > 0);
        assert.strictEqual(countTokensSpy.called, false, "Should not call remote token counter for small strings");
    });

    test("provideTokenCount kicks off background refinement for large strings", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        sandbox.stub(provider as unknown as { _configManager: ConfigManager }, "_configManager").value({
            getConfig: async () => ({ url: "http://localhost:4000", modelOverrides: {} }),
            resolveBackends: async () => [
                { name: "default", url: "http://localhost:4000", apiKey: "test-key", enabled: true },
            ],
        });

        // Initialize multiBackendClient by calling discoverModels
        sandbox.stub(LiteLLMClient.prototype, "getModelInfo").resolves({ data: [] });
        await provider.provideLanguageModelChatInformation({ silent: true }, {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose() {} }),
        } as vscode.CancellationToken);

        const remoteCount = 123;
        const countTokensStub = sandbox
            .stub(MultiBackendClient.prototype, "countTokens")
            .resolves({ token_count: remoteCount });

        const model = { id: "default/test-model" } as vscode.LanguageModelChatInformation;
        const largeText = "a".repeat(600);
        const token = { isCancellationRequested: false } as vscode.CancellationToken;

        // First call - returns local count immediately, but kicks off background
        const count1 = await provider.provideTokenCount(model, largeText, token);
        assert.notStrictEqual(count1, remoteCount, "Should return local count immediately");

        // Wait for background debounce and execution
        await new Promise((resolve) => setTimeout(resolve, 600));

        assert.strictEqual(countTokensStub.callCount, 1, "Should have called remote counter in background");

        // Second call - should now return cached remote count
        const count2 = await provider.provideTokenCount(model, largeText, token);
        assert.strictEqual(count2, remoteCount, "Should return cached remote count on second call");
    });

    test("isParameterSupported returns true when parameter is explicitly supported and not blocked", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const isSupported = (
            provider as unknown as {
                isParameterSupported: (param: string, modelInfo: unknown, modelId?: string) => boolean;
            }
        ).isParameterSupported.bind(provider);

        const supported = isSupported("temperature", { supported_openai_params: ["temperature", "top_p"] }, "gpt-4.1");

        assert.strictEqual(supported, true);
    });

    test("stripUnsupportedParametersFromRequest preserves supported fields when model has no limitations", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
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
            temperature: 0.4,
            top_p: 0.9,
            frequency_penalty: 0.2,
        };

        strip(requestBody, { supported_openai_params: ["temperature", "top_p", "frequency_penalty"] }, "gpt-4.1");

        assert.deepStrictEqual(requestBody, {
            temperature: 0.4,
            top_p: 0.9,
            frequency_penalty: 0.2,
        });
    });

    test("provideTokenCount returns local estimate when cancellation is already requested", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const countTokensStub = sandbox.stub(MultiBackendClient.prototype, "countTokens");

        const token = {
            isCancellationRequested: true,
            onCancellationRequested: () => ({ dispose() {} }),
        } as vscode.CancellationToken;

        const count = await provider.provideTokenCount(
            { id: "default/test-model" } as vscode.LanguageModelChatInformation,
            "a".repeat(800),
            token
        );

        assert.ok(count > 0);
        assert.strictEqual(countTokensStub.called, false);
    });

    test("provideLanguageModelChatInformation returns empty when all resolved backends are disabled", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderWithConfigManager {
            _configManager: {
                getConfig: () => Promise<{ url: string; modelOverrides: Record<string, string[]> }>;
                resolveBackends: () => Promise<ResolvedBackend[]>;
            };
        }
        const providerWithConfig = provider as unknown as ProviderWithConfigManager;
        sandbox.stub(providerWithConfig._configManager, "getConfig").resolves({
            url: "http://localhost:4000",
            modelOverrides: {},
        } as unknown as { url: string; modelOverrides: Record<string, string[]> });
        sandbox.stub(providerWithConfig._configManager, "resolveBackends").resolves([]);

        const infos = await provider.provideLanguageModelChatInformation(
            { silent: true },
            new vscode.CancellationTokenSource().token
        );

        assert.deepStrictEqual(infos, []);
    });

    test("getModelTags does not add inline-completions when streaming is unsupported", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        interface ProviderForTagTesting {
            getModelTags: (
                modelId: string,
                modelInfo?: LiteLLMModelInfo,
                overrides?: Record<string, string[]>
            ) => string[];
        }
        const getModelTags = (provider as unknown as ProviderForTagTesting).getModelTags.bind(provider);

        const tags = getModelTags("plain-model", {
            mode: "chat",
            supports_native_streaming: false,
        });

        assert.strictEqual(tags.includes("inline-completions"), false);
    });

    test("discoverModels deduplicates in-flight requests", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        // Stub _doDiscoverModels to take some time
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doDiscoverStub = sandbox.stub(provider as any, "_doDiscoverModels").callsFake(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return [];
        });

        const p1 = provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        const p2 = provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);

        await Promise.all([p1, p2]);
        assert.strictEqual(doDiscoverStub.callCount, 1);
    });

    test("discoverModels respects TTL for silent requests", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (provider as any)._lastModelList = [{ id: "m1" }];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (provider as any)._modelListFetchedAtMs = Date.now();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doDiscoverStub = sandbox.stub(provider as any, "_doDiscoverModels");

        const models = await provider.discoverModels({ silent: true }, new vscode.CancellationTokenSource().token);
        assert.strictEqual(models.length, 1);
        assert.strictEqual(doDiscoverStub.called, false);
    });

    test("discoverModels bypasses TTL for non-silent requests", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (provider as any)._lastModelList = [{ id: "m1" }];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (provider as any)._modelListFetchedAtMs = Date.now();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doDiscoverStub = sandbox.stub(provider as any, "_doDiscoverModels").resolves([{ id: "m2" } as any]);

        const models = await provider.discoverModels({ silent: false }, new vscode.CancellationTokenSource().token);
        assert.strictEqual(models[0].id, "m2");
        assert.strictEqual(doDiscoverStub.calledOnce, true);
    });

    test("_doDiscoverModels triggers config flow when no backends configured and not silent", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const configManager = (provider as any)._configManager;
        sandbox.stub(configManager, "resolveBackends").resolves([]);
        const execStub = sandbox.stub(vscode.commands, "executeCommand").resolves(undefined);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const models = await (provider as any)._doDiscoverModels(
            { silent: false },
            new vscode.CancellationTokenSource().token
        );
        assert.strictEqual(execStub.calledWith("litellm-connector.manage"), true);
        assert.strictEqual(models.length, 0);
    });

    test("_doDiscoverModels handles error gracefully", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const configManager = (provider as any)._configManager;
        sandbox.stub(configManager, "getConfig").rejects(new Error("boom"));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const models = await (provider as any)._doDiscoverModels(
            { silent: true },
            new vscode.CancellationTokenSource().token
        );
        assert.strictEqual(models.length, 0);
    });

    test("getModelTags adds inline-edit for models containing 'coder' or 'code'", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const getModelTags = (provider as any).getModelTags.bind(provider);

        assert.ok(getModelTags("my-coder-model").includes("inline-edit"));
        assert.ok(getModelTags("cool-code-model").includes("inline-edit"));
    });

    test("getModelTags adds tools tag for function-calling or vision models", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const getModelTags = (provider as any).getModelTags.bind(provider);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assert.ok(getModelTags("m1", { supports_function_calling: true } as any).includes("tools"));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assert.ok(getModelTags("m2", { supports_vision: true } as any).includes("vision"));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assert.ok(getModelTags("m3", { supported_openai_params: ["tools"] } as any).includes("tools"));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assert.ok(getModelTags("m4", { supported_openai_params: ["tool_choice"] } as any).includes("tools"));
    });

    test("sanitizeErrorTextForLogs caps long text and removes prompt wrappers", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sanitize = (provider as any).sanitizeErrorTextForLogs.bind(provider);

        const input = "<context>Secret</context><editorContext>Code</editorContext>Some error";
        const output = sanitize(input);
        assert.ok(output.includes("<context>…</context>"));
        assert.ok(output.includes("<editorContext>…</editorContext>"));
        assert.ok(output.includes("Some error"));

        const longInput = "a".repeat(600);
        assert.strictEqual(sanitize(longInput).length, 501); // 500 chars + ellipsis
    });

    test("collectMessageText handles string content parts", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        const collect = (
            provider as unknown as { collectMessageText: (m: vscode.LanguageModelChatRequestMessage) => string }
        ).collectMessageText.bind(provider);

        const msg = {
            role: vscode.LanguageModelChatMessageRole.User,
            content: ["hello", new vscode.LanguageModelTextPart(" world")] as unknown as vscode.LanguageModelTextPart[],
        } as unknown as vscode.LanguageModelChatRequestMessage;

        assert.strictEqual(collect(msg), "hello world");
    });

    test("parseApiError handles non-JSON error text", () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parse = (provider as any).parseApiError.bind(provider);

        assert.strictEqual(parse(500, "Raw error message"), "Raw error message");
        assert.strictEqual(parse(500, ""), "API request failed with status 500");
    });
});
