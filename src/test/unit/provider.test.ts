import * as assert from "assert";
import * as vscode from "vscode";
import { LiteLLMChatModelProvider } from "../../providers/liteLLMProvider";

suite("LiteLLM Provider Unit Tests", () => {
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
});
