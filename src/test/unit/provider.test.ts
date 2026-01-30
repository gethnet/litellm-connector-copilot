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
});
