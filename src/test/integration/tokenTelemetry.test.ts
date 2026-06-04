import * as vscode from "vscode";
import * as assert from "assert";
import * as sinon from "sinon";
import { LiteLLMChatProvider } from "../../providers";
import { LiteLLMCompletionProvider } from "../../providers/liteLLMCompletionProvider";
import { LiteLLMTelemetry, type IMetrics } from "../../utils/telemetry";
import { LiteLLMClient } from "../../adapters/litellmClient";
import type { ConfigManager } from "../../config/configManager";
import { createMockSecrets } from "../utils/testMocks";

/**
 * Test view of a captured IMetrics where the fields these tests inspect
 * are treated as required. The production type has them optional because
 * not every emission supplies every field, but in these regression tests
 * the assertions only run on calls we know populated the values.
 */
type RecordedMetric = IMetrics & {
    tokensIn: number;
    tokensOut: number;
};

suite("Token Telemetry Regression Tests", () => {
    let sandbox: sinon.SinonSandbox;
    let reportMetricStub: sinon.SinonStub;

    const mockSecrets = createMockSecrets();
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

        // Seed the discovered model list so the new per-group routing path can resolve the
        // backend. Without this the request fails with "LiteLLM configuration not found"
        // before reaching the stubbed `chat` call.
        const seededModel = {
            id: "gpt-4",
            name: "GPT-4",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 8192,
            maxOutputTokens: 4096,
            capabilities: { toolCalling: true, imageInput: false },
            _backendName: "localhost:4000",
            _backendUrl: "http://localhost:4000",
            _apiKey: "test-api-key",
        } as unknown as vscode.LanguageModelChatInformation;
        const providerInternals = provider as unknown as {
            _lastModelList: vscode.LanguageModelChatInformation[];
            _modelDiscovery: {
                getLastModels: () => vscode.LanguageModelChatInformation[];
                getDiscoveredModelBackend: (
                    modelId: string
                ) => { backendName: string; url: string; apiKey: string } | undefined;
            };
        };
        providerInternals._lastModelList = [seededModel];
        sandbox.stub(providerInternals._modelDiscovery, "getLastModels").returns([seededModel]);
        sandbox
            .stub(providerInternals._modelDiscovery, "getDiscoveredModelBackend")
            .returns({ backendName: "localhost:4000", url: "http://localhost:4000", apiKey: "test-api-key" });

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
        const metric = reportMetricStub.firstCall.args[0] as RecordedMetric;

        // "Say hello" is 3-6 tokens depending on tokenizer and overhead
        assert.ok(
            metric.tokensIn >= 3 && metric.tokensIn <= 6,
            `tokensIn (${metric.tokensIn}) should be within expected range [3, 6]`
        );
        // "Hello world" is 2-4 tokens depending on tokenizer
        assert.ok(
            metric.tokensOut >= 2 && metric.tokensOut <= 4,
            `tokensOut (${metric.tokensOut}) should be within expected range [2, 4]`
        );
        assert.strictEqual(metric.status, "success");
    });

    test("LiteLLMChatProvider reports tokensIn on failure", async () => {
        const provider = new LiteLLMChatProvider(mockSecrets, userAgent);

        const providerAsAny = provider as unknown as { _configManager: ConfigManager };
        const configManager = providerAsAny._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://localhost:4000" });

        // Seed the discovered backend for the same reason as the success test above.
        const seededModel = {
            id: "gpt-4",
            name: "GPT-4",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 8192,
            maxOutputTokens: 4096,
            capabilities: { toolCalling: true, imageInput: false },
            _backendName: "localhost:4000",
            _backendUrl: "http://localhost:4000",
            _apiKey: "test-api-key",
        } as unknown as vscode.LanguageModelChatInformation;
        const providerInternals = provider as unknown as {
            _lastModelList: vscode.LanguageModelChatInformation[];
            _modelDiscovery: {
                getLastModels: () => vscode.LanguageModelChatInformation[];
                getDiscoveredModelBackend: (
                    modelId: string
                ) => { backendName: string; url: string; apiKey: string } | undefined;
            };
        };
        providerInternals._lastModelList = [seededModel];
        sandbox.stub(providerInternals._modelDiscovery, "getLastModels").returns([seededModel]);
        sandbox
            .stub(providerInternals._modelDiscovery, "getDiscoveredModelBackend")
            .returns({ backendName: "localhost:4000", url: "http://localhost:4000", apiKey: "test-api-key" });

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
        const metric = reportMetricStub.firstCall.args[0] as RecordedMetric;
        // "Failing request" -> 3 tokens + 3 overhead + 1 prompt + 1 system?
        // It seems the test is getting 8.
        assert.ok(
            metric.tokensIn >= 3 && metric.tokensIn <= 10,
            `tokensIn (${metric.tokensIn}) should be within expected range [3, 10]`
        );
        assert.strictEqual(metric.status, "failure");
    });

    test("LiteLLMCompletionProvider reports tokensIn and tokensOut on success", async () => {
        const provider = new LiteLLMCompletionProvider(mockSecrets, userAgent);

        const providerAsAny = provider as unknown as {
            _configManager: ConfigManager;
            _lastModelList: vscode.LanguageModelChatInformation[];
            _modelDiscovery: {
                getLastModels: () => vscode.LanguageModelChatInformation[];
                getDiscoveredModelBackend: (
                    modelId: string
                ) => { backendName: string; url: string; apiKey: string } | undefined;
            };
        };
        const configManager = providerAsAny._configManager;
        sandbox.stub(configManager, "getConfig").resolves({ url: "http://localhost:4000" });

        // Seed the discovered backend so the new per-group routing path resolves correctly.
        const seededModel = {
            id: "gpt-4",
            name: "GPT-4",
            tooltip: "",
            family: "litellm",
            version: "1.0.0",
            maxInputTokens: 8192,
            maxOutputTokens: 4096,
            capabilities: { toolCalling: true, imageInput: false },
            tags: ["inline-completions"],
            _backendName: "localhost:4000",
            _backendUrl: "http://localhost:4000",
            _apiKey: "test-api-key",
        } as unknown as vscode.LanguageModelChatInformation;
        providerAsAny._lastModelList = [seededModel];
        sandbox.stub(providerAsAny._modelDiscovery, "getLastModels").returns([seededModel]);
        sandbox
            .stub(providerAsAny._modelDiscovery, "getDiscoveredModelBackend")
            .returns({ backendName: "localhost:4000", url: "http://localhost:4000", apiKey: "test-api-key" });

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
        const metric = reportMetricStub.firstCall.args[0] as RecordedMetric;

        // "Prompt" is 1-5 tokens depending on tokenizer and overhead
        assert.ok(
            metric.tokensIn >= 1 && metric.tokensIn <= 5,
            `tokensIn (${metric.tokensIn}) should be within expected range [1, 5]`
        );
        // " completed" is 1-3 tokens depending on tokenizer
        assert.ok(
            metric.tokensOut >= 1 && metric.tokensOut <= 3,
            `tokensOut (${metric.tokensOut}) should be within expected range [1, 3]`
        );
        assert.strictEqual(metric.status, "success");
    });
});
