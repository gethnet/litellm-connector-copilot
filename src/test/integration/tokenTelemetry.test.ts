import * as vscode from "vscode";
import * as assert from "assert";
import * as sinon from "sinon";
import { LiteLLMChatProvider } from "../../providers/liteLLMChatProvider";
import { LiteLLMCompletionProvider } from "../../providers/liteLLMCompletionProvider";
import { LiteLLMTelemetry } from "../../utils/telemetry";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { ResponsesClient } from "../../adapters/responsesClient";
import type { ConfigManager } from "../../config/configManager";

suite("Token Telemetry Regression Tests", () => {
    let sandbox: sinon.SinonSandbox;
    let reportMetricStub: sinon.SinonStub;

    const mockSecrets: vscode.SecretStorage = {
        get: async () => undefined,
        store: async () => {},
        delete: async () => {},
        keys: async () => [],
        onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
    };
    const userAgent = "test-ua";

    setup(() => {
        sandbox = sinon.createSandbox();
        reportMetricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");
    });

    teardown(() => {
        sandbox.restore();
    });

    test("LiteLLMChatProvider reports tokensIn and tokensOut on success", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        // Mock ConfigManager
        const providerAsAny = provider as unknown as { _configManager: ConfigManager };
        const configManager = providerAsAny._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://localhost:4000" });

        // Mock LiteLLMClient.chat
        const encoder = new TextEncoder();
        const mockStream = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello world"}}]}\n\n'));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            },
        });
        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(mockStream);
        sandbox.stub(ResponsesClient.prototype, "sendResponsesRequest").resolves();

        const model: vscode.LanguageModelChatInformation = {
            id: "gpt-4",
            name: "GPT-4",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 8192,
            maxOutputTokens: 4096,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("Say hello")],
            } as unknown as vscode.LanguageModelChatRequestMessage,
        ];

        const progress: vscode.Progress<vscode.LanguageModelResponsePart> = { report: () => {} };
        const token = new vscode.CancellationTokenSource().token;

        await provider.provideLanguageModelChatResponse(
            model,
            messages,
            { tools: [] } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            progress,
            token
        );

        assert.ok(reportMetricStub.calledOnce);
        const metric = reportMetricStub.firstCall.args[0];

        // "Say hello" is 9 chars -> ceil(9/4) = 3 tokens
        assert.strictEqual(metric.tokensIn, 3, "tokensIn should be calculated");
        // "Hello world" is 11 chars -> ceil(11/4) = 3 tokens
        assert.strictEqual(metric.tokensOut, 3, "tokensOut should be estimated from output");
        assert.strictEqual(metric.status, "success");
    });

    test("LiteLLMChatProvider reports tokensIn on failure", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        const providerAsAny = provider as unknown as { _configManager: ConfigManager };
        const configManager = providerAsAny._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://localhost:4000" });

        sandbox.stub(LiteLLMClient.prototype, "chat").rejects(new Error("LiteLLM API error\nSomething went wrong"));

        const model: vscode.LanguageModelChatInformation = {
            id: "gpt-4",
            name: "GPT-4",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 8192,
            maxOutputTokens: 4096,
            capabilities: { toolCalling: true, imageInput: false },
        };

        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("Failing request")],
            } as unknown as vscode.LanguageModelChatRequestMessage,
        ];

        try {
            await provider.provideLanguageModelChatResponse(
                model,
                messages,
                { tools: [] } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { report: () => {} },
                new vscode.CancellationTokenSource().token
            );
        } catch {
            // Expected
        }

        assert.ok(reportMetricStub.calledOnce);
        const metric = reportMetricStub.firstCall.args[0];
        assert.strictEqual(metric.tokensIn, 4, "tokensIn should be reported even on failure");
        assert.strictEqual(metric.status, "failure");
    });

    test("LiteLLMCompletionProvider reports tokensIn and tokensOut on success", async () => {
        const provider = new LiteLLMCompletionProvider(mockSecrets, userAgent);

        const providerAsAny = provider as unknown as {
            _configManager: ConfigManager;
            _lastModelList: vscode.LanguageModelChatInformation[];
        };
        const configManager = providerAsAny._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://localhost:4000" });

        // Setup model list for resolution
        providerAsAny._lastModelList = [
            {
                id: "gpt-4",
                name: "GPT-4",
                tooltip: "",
                family: "litellm",
                version: "1.0.0",
                maxInputTokens: 8192,
                maxOutputTokens: 4096,
                capabilities: { toolCalling: true, imageInput: false },
                tags: ["inline-completions"],
            } as unknown as vscode.LanguageModelChatInformation,
        ];

        const encoder = new TextEncoder();
        const mockStream = new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" completed"}}]}\n\n'));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            },
        });
        sandbox.stub(LiteLLMClient.prototype, "chat").resolves(mockStream);

        const token = new vscode.CancellationTokenSource().token;
        const result = await provider.provideTextCompletion("Prompt", {}, token);

        assert.strictEqual(result.insertText, " completed");
        assert.ok(reportMetricStub.calledOnce);
        const metric = reportMetricStub.firstCall.args[0];

        // "Prompt" is 6 chars -> 2 tokens
        assert.strictEqual(metric.tokensIn, 2);
        // " completed" is 10 chars -> 3 tokens
        assert.strictEqual(metric.tokensOut, 3);
        assert.strictEqual(metric.status, "success");
    });
});
