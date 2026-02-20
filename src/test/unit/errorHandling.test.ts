import * as assert from "assert";
import * as vscode from "vscode";
import { LiteLLMChatProvider } from "../../providers";
import { LiteLLMClient } from "../../adapters/litellmClient";
import * as sinon from "sinon";

suite("LiteLLM Error Handling Unit Tests", () => {
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
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("provideLanguageModelChatResponse retries without parameters on unsupported parameter error", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        const errorText = JSON.stringify({
            error: {
                message: "Unsupported parameter: temperature",
                type: "invalid_request_error",
            },
        });
        const apiError = new Error(`LiteLLM API error: 400 Bad Request\n${errorText}`);

        const chatStub = sandbox.stub(LiteLLMClient.prototype, "chat");
        chatStub.onFirstCall().rejects(apiError);
        chatStub.onSecondCall().resolves(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(
                        new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Success after retry"}}]}\n\n')
                    );
                    controller.close();
                },
            })
        );

        const model: vscode.LanguageModelChatInformation = {
            id: "test-model",
            name: "Test Model",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 4096,
            maxOutputTokens: 1024,
            capabilities: { toolCalling: true, imageInput: false },
            tooltip: "test",
        };

        const messages = [new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, "Hello")];

        const options: vscode.ProvideLanguageModelChatResponseOptions = {
            modelOptions: { temperature: 0.5 },
            toolMode: vscode.LanguageModelChatToolMode.Auto,
        };

        const reportedParts: vscode.LanguageModelResponsePart[] = [];
        const progress: vscode.Progress<vscode.LanguageModelResponsePart> = {
            report: (part) => reportedParts.push(part),
        };

        await provider.provideLanguageModelChatResponse(
            model,
            messages,
            options,
            progress,
            new vscode.CancellationTokenSource().token
        );

        assert.strictEqual(chatStub.callCount, 2);
        // Check that the second call didn't have temperature
        const secondCallArgs = chatStub.getCall(1).args[0];
        assert.strictEqual(secondCallArgs.temperature, undefined);

        const textParts = reportedParts.filter((p) => p instanceof vscode.LanguageModelTextPart);
        assert.ok(textParts.some((p) => p.value === "Success after retry"));
    });

    test("provideLanguageModelChatResponse handles unsupported parameter error from LiteLLM (when retry also fails)", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        // Mock LiteLLMClient.chat to throw an error
        const errorText = JSON.stringify({
            error: {
                message: "Unsupported parameter: temperature",
                type: "invalid_request_error",
                param: "temperature",
                code: "unsupported_parameter",
            },
        });
        const apiError = new Error(`LiteLLM API error: 400 Bad Request\n${errorText}`);

        sandbox.stub(LiteLLMClient.prototype, "chat").rejects(apiError);

        const model: vscode.LanguageModelChatInformation = {
            id: "test-model",
            name: "Test Model",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 4096,
            maxOutputTokens: 1024,
            capabilities: { toolCalling: true, imageInput: false },
            tooltip: "test",
        };

        const messages = [new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, "Hello")];

        const options: vscode.ProvideLanguageModelChatResponseOptions = {
            modelOptions: { temperature: 0.5 },
            toolMode: vscode.LanguageModelChatToolMode.Auto, // LanguageModelChatToolMode.Auto
        };

        const progress: vscode.Progress<vscode.LanguageModelResponsePart> = {
            report: () => {},
        };

        const token = new vscode.CancellationTokenSource().token;

        try {
            await provider.provideLanguageModelChatResponse(model, messages, options, progress, token);
            assert.fail("Should have thrown an error");
        } catch (err) {
            const error = err as Error;
            assert.ok(error.message.includes("LiteLLM Error (test-model)"));
            assert.ok(error.message.includes("Unsupported parameter: temperature"));
            assert.ok(error.message.includes("This model may not support certain parameters like temperature"));
        }
    });

    test("provideLanguageModelChatResponse handles generic 400 error", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        const apiError = new Error(`LiteLLM API error: 400 Bad Request\nSomething went wrong`);
        sandbox.stub(LiteLLMClient.prototype, "chat").rejects(apiError);

        const model: vscode.LanguageModelChatInformation = {
            id: "test-model",
            name: "Test Model",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 4096,
            maxOutputTokens: 1024,
            capabilities: { toolCalling: true, imageInput: false },
            tooltip: "test",
        };

        const progress: vscode.Progress<vscode.LanguageModelResponsePart> = {
            report: () => {},
        };

        try {
            const dummyMessages = [
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, "Hello"),
            ];
            await provider.provideLanguageModelChatResponse(
                model,
                dummyMessages,
                { toolMode: vscode.LanguageModelChatToolMode.Auto },
                progress,
                new vscode.CancellationTokenSource().token
            );
            assert.fail("Should have thrown an error");
        } catch (err) {
            const error = err as Error;
            assert.ok(error.message.includes("LiteLLM Error (test-model)"));
            assert.ok(error.message.includes("Something went wrong"));
        }
    });

    test("provideLanguageModelChatResponse preserves LiteLLM Error wrapper when already decorated", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        const apiError = new Error("LiteLLM Error (test-model): LiteLLM API error\nSomething went wrong");
        sandbox.stub(LiteLLMClient.prototype, "chat").rejects(apiError);

        const model: vscode.LanguageModelChatInformation = {
            id: "test-model",
            name: "Test Model",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 4096,
            maxOutputTokens: 1024,
            capabilities: { toolCalling: true, imageInput: false },
            tooltip: "test",
        };

        const progress: vscode.Progress<vscode.LanguageModelResponsePart> = {
            report: () => {},
        };

        try {
            const dummyMessages = [
                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, "Hello"),
            ];
            await provider.provideLanguageModelChatResponse(
                model,
                dummyMessages,
                { toolMode: vscode.LanguageModelChatToolMode.Auto },
                progress,
                new vscode.CancellationTokenSource().token
            );
            assert.fail("Should have thrown an error");
        } catch (err) {
            const error = err as Error;
            assert.ok(error.message.includes("LiteLLM Error (test-model)"));
            assert.ok(error.message.includes("Something went wrong"));
        }
    });
});
