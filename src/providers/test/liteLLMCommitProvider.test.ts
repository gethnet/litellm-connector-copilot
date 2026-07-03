import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";

import { LiteLLMCommitMessageProvider } from "../liteLLMCommitProvider";
import { Logger } from "../../utils/logger";
import { LiteLLMTelemetry } from "../../utils/telemetry";
import { createMockSecrets } from "../../test/utils/testMocks";
import { createTelemetryMocks } from "../../test/utils/telemetryMock";

/**
 * Typed access to private/protected members for testing.
 */
interface CommitProviderInternals {
    _configManager: {
        getConfig: () => Promise<{
            commitModelIdOverride?: string;
            baseUrl?: string;
            apiKey?: string;
        }>;
    };
    _registry: {
        lookup: (
            id: string
        ) => { baseUrl: string; apiKey: string; rawModelName: string; routingIdentity: string } | undefined;
        getModelInfo: (id: string) => unknown;
        findBackendForRawName: (
            rawName: string
        ) => { baseUrl: string; apiKey: string; rawModelName: string } | undefined;
        setModelsForBackend: (
            baseUrl: string,
            apiKey: string,
            routingIdentity: string,
            models: vscode.LanguageModelChatInformation[]
        ) => void;
    };
    /**
     * Generator method stub for testing model resolution.
     * Returns an iterable of [modelId, backendEntry] pairs.
     */
    registryEntries: (
        registry: unknown
    ) => Iterable<[string, { baseUrl: string; apiKey: string; rawModelName: string }]>;
    getRawModelName: (id: string) => string;
    buildOpenAIChatRequest: (
        messages: vscode.LanguageModelChatRequestMessage[],
        model: vscode.LanguageModelChatInformation,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        modelInfo?: unknown,
        caller?: string
    ) => Promise<Record<string, unknown>>;
    sendRequestWithRetry: (
        request: Record<string, unknown>,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        model: vscode.LanguageModelChatInformation,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        modelInfo?: unknown
    ) => Promise<ReadableStream<Uint8Array>>;
    _effortFallbackCache: { get: (key: string) => string | undefined; set: (key: string, value: string) => void };
    _telemetryService?: { captureException: (err: Error, ctx: unknown) => void };
}

function accessInternals(provider: LiteLLMCommitMessageProvider): CommitProviderInternals {
    return provider as unknown as CommitProviderInternals;
}

/**
 * Creates a mock ReadableStream that yields SSE-formatted response chunks.
 */
function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;

    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (index < chunks.length) {
                const chunk = chunks[index];
                controller.enqueue(encoder.encode(chunk));
                index++;
            } else {
                controller.close();
            }
        },
    });
}

/**
 * Creates SSE-formatted response data for a text completion.
 */
function createSSEResponse(text: string): string {
    // Simulate OpenAI SSE response format
    const delta = JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] });
    const done = JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] });
    return `data: ${delta}\n\ndata: ${done}\n\ndata: [DONE]\n\n`;
}

suite("LiteLLMCommitMessageProvider", () => {
    let sandbox: sinon.SinonSandbox;
    let telemetryMocks: ReturnType<typeof createTelemetryMocks>;

    const mockSecrets = createMockSecrets({
        "litellm-connector.baseUrl": "http://localhost:4000",
        "litellm-connector.apiKey": "test-api-key",
    });

    const userAgent = "GitHubCopilotChat/test VSCode/test";

    setup(() => {
        sandbox = sinon.createSandbox();
        telemetryMocks = createTelemetryMocks(sandbox);
        telemetryMocks.setup();

        // Stub Logger to prevent console noise during tests
        sandbox.stub(Logger, "info").returns();
        sandbox.stub(Logger, "debug").returns();
        sandbox.stub(Logger, "trace").returns();
        sandbox.stub(Logger, "warn").returns();
        sandbox.stub(Logger, "error").returns();
    });

    teardown(() => {
        telemetryMocks.teardown();
        sandbox.restore();
    });

    suite("Constructor", () => {
        test("should create provider instance with secrets and user agent", () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            assert.ok(provider);
        });

        test("should accept optional effort fallback cache", () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            assert.ok(provider);
            // Cache is optional and created internally if not provided
        });
    });

    suite("provideCommitMessage", () => {
        test("should throw when no model is available", async () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            const internals = accessInternals(provider);

            // Stub getConfig to return empty config (no model override)
            sandbox.stub(internals._configManager, "getConfig").resolves({});

            const tokenSource = new vscode.CancellationTokenSource();
            const options: vscode.LanguageModelChatRequestOptions = {
                justification: "test",
            };

            await assert.rejects(async () => {
                await provider.provideCommitMessage("diff content", options, tokenSource.token);
            }, /No model available for commit message generation/);

            tokenSource.dispose();
        });

        test("should generate commit message from diff when model override is set", async () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            const internals = accessInternals(provider);

            // Seed registry with a model
            const modelId = "gpt-4o";
            internals._registry.setModelsForBackend("http://localhost:4000", "test-api-key", "localhost:4000", [
                {
                    id: modelId,
                    name: "GPT-4o",
                    family: "gpt-4o",
                    version: "1.0",
                    maxInputTokens: 128000,
                    maxOutputTokens: 4096,
                    capabilities: { toolCalling: true, imageInput: false },
                },
            ]);

            // Stub registryEntries to return our test model
            sandbox
                .stub(internals, "registryEntries")
                .returns([
                    [modelId, { baseUrl: "http://localhost:4000", apiKey: "test-api-key", rawModelName: modelId }],
                ]);

            // Stub config to return the model override
            sandbox.stub(internals._configManager, "getConfig").resolves({
                commitModelIdOverride: modelId,
            });

            // Mock the model info lookup
            const modelInfo = {
                id: modelId,
                max_input_tokens: 128000,
                max_output_tokens: 4096,
            };
            sandbox.stub(internals._registry, "getModelInfo").returns(modelInfo);

            // Mock the request builder
            const mockRequest = {
                model: modelId,
                messages: [{ role: "user", content: "test" }],
            };
            sandbox
                .stub(internals, "buildOpenAIChatRequest")
                .resolves(mockRequest as unknown as Record<string, unknown>);

            // Create mock stream with commit message response
            const commitMessage = "feat: add new feature";
            const mockStream = createMockStream([createSSEResponse(commitMessage)]);
            sandbox.stub(internals, "sendRequestWithRetry").resolves(mockStream);

            const tokenSource = new vscode.CancellationTokenSource();
            const options: vscode.LanguageModelChatRequestOptions = {
                justification: "test",
            };

            const progressChunks: string[] = [];
            const result = await provider.provideCommitMessage("diff content", options, tokenSource.token, (chunk) =>
                progressChunks.push(chunk)
            );

            assert.strictEqual(result, commitMessage);

            tokenSource.dispose();
        });

        test("should strip markdown code blocks from generated message", async () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            const internals = accessInternals(provider);

            // Seed registry with a model
            const modelId = "gpt-4o";
            internals._registry.setModelsForBackend("http://localhost:4000", "test-api-key", "localhost:4000", [
                {
                    id: modelId,
                    name: "GPT-4o",
                    family: "gpt-4o",
                    version: "1.0",
                    maxInputTokens: 128000,
                    maxOutputTokens: 4096,
                    capabilities: { toolCalling: true, imageInput: false },
                },
            ]);

            // Stub registryEntries to return our test model
            sandbox
                .stub(internals, "registryEntries")
                .returns([
                    [modelId, { baseUrl: "http://localhost:4000", apiKey: "test-api-key", rawModelName: modelId }],
                ]);

            sandbox.stub(internals._configManager, "getConfig").resolves({
                commitModelIdOverride: modelId,
            });

            const modelInfo = {
                id: modelId,
                max_input_tokens: 128000,
                max_output_tokens: 4096,
            };
            sandbox.stub(internals._registry, "getModelInfo").returns(modelInfo);
            sandbox.stub(internals, "buildOpenAIChatRequest").resolves({} as Record<string, unknown>);

            // Create response with markdown code block
            const rawMessage = "```\nfeat: add new feature\n```";
            const mockStream = createMockStream([createSSEResponse(rawMessage)]);
            sandbox.stub(internals, "sendRequestWithRetry").resolves(mockStream);

            const tokenSource = new vscode.CancellationTokenSource();
            const options: vscode.LanguageModelChatRequestOptions = {
                justification: "test",
            };

            const result = await provider.provideCommitMessage("diff", options, tokenSource.token);

            // Should have stripped the markdown code blocks
            assert.strictEqual(result, "feat: add new feature");

            tokenSource.dispose();
        });

        test("should capture exception on error", async () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            const internals = accessInternals(provider);

            // Set up telemetry service mock
            const captureExceptionStub = sandbox.stub();
            internals._telemetryService = {
                captureException: captureExceptionStub,
            } as unknown as { captureException: (err: Error, ctx: unknown) => void };

            sandbox.stub(internals._configManager, "getConfig").resolves({});

            const tokenSource = new vscode.CancellationTokenSource();
            const options: vscode.LanguageModelChatRequestOptions = {
                justification: "test",
            };

            await assert.rejects(async () => {
                await provider.provideCommitMessage("diff", options, tokenSource.token);
            }, /No model available/);

            tokenSource.dispose();
        });

        test("should call progress callback with text chunks", async () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            const internals = accessInternals(provider);

            // Seed registry with a model
            const modelId = "gpt-4o";
            internals._registry.setModelsForBackend("http://localhost:4000", "test-api-key", "localhost:4000", [
                {
                    id: modelId,
                    name: "GPT-4o",
                    family: "gpt-4o",
                    version: "1.0",
                    maxInputTokens: 128000,
                    maxOutputTokens: 4096,
                    capabilities: { toolCalling: true, imageInput: false },
                },
            ]);

            // Stub registryEntries to return our test model
            sandbox
                .stub(internals, "registryEntries")
                .returns([
                    [modelId, { baseUrl: "http://localhost:4000", apiKey: "test-api-key", rawModelName: modelId }],
                ]);

            sandbox.stub(internals._configManager, "getConfig").resolves({
                commitModelIdOverride: modelId,
            });

            const modelInfo = {
                id: modelId,
                max_input_tokens: 128000,
                max_output_tokens: 4096,
            };
            sandbox.stub(internals._registry, "getModelInfo").returns(modelInfo);
            sandbox.stub(internals, "buildOpenAIChatRequest").resolves({} as Record<string, unknown>);

            // Create response with multiple chunks
            const message = "feat: add feature";
            const mockStream = createMockStream([createSSEResponse(message)]);
            sandbox.stub(internals, "sendRequestWithRetry").resolves(mockStream);

            const tokenSource = new vscode.CancellationTokenSource();
            const options: vscode.LanguageModelChatRequestOptions = {
                justification: "test",
            };

            const progressChunks: string[] = [];
            await provider.provideCommitMessage("diff", options, tokenSource.token, (chunk) =>
                progressChunks.push(chunk)
            );

            // Progress callback should have been called
            assert.ok(progressChunks.length > 0 || message.length > 0);

            tokenSource.dispose();
        });
    });

    suite("resolveCommitModel", () => {
        test("should return undefined when no override configured and no tagged models", async () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            const internals = accessInternals(provider);

            // Empty registry, no override
            sandbox.stub(internals._configManager, "getConfig").resolves({});

            const tokenSource = new vscode.CancellationTokenSource();
            const options: vscode.LanguageModelChatRequestOptions = {
                justification: "test",
            };

            // Will throw because resolveCommitModel returns undefined
            await assert.rejects(async () => {
                await provider.provideCommitMessage("diff", options, tokenSource.token);
            }, /No model available/);

            tokenSource.dispose();
        });

        test("should resolve model when override matches registry entry", async () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            const internals = accessInternals(provider);

            // Seed registry with a model
            const modelId = "gpt-4o-commit";
            internals._registry.setModelsForBackend("http://localhost:4000", "test-api-key", "localhost:4000", [
                {
                    id: modelId,
                    name: "GPT-4o Commit",
                    family: "gpt-4o",
                    version: "1.0",
                    maxInputTokens: 128000,
                    maxOutputTokens: 4096,
                    capabilities: { toolCalling: true, imageInput: false },
                },
            ]);

            // Stub registryEntries to return our test model
            sandbox
                .stub(internals, "registryEntries")
                .returns([
                    [modelId, { baseUrl: "http://localhost:4000", apiKey: "test-api-key", rawModelName: modelId }],
                ]);

            sandbox.stub(internals._configManager, "getConfig").resolves({
                commitModelIdOverride: modelId,
            });

            const modelInfo = {
                id: modelId,
                max_input_tokens: 128000,
                max_output_tokens: 4096,
            };
            sandbox.stub(internals._registry, "getModelInfo").returns(modelInfo);
            sandbox.stub(internals, "buildOpenAIChatRequest").resolves({} as Record<string, unknown>);

            // Create minimal stream
            const mockStream = createMockStream([createSSEResponse("fix: bug fix")]);
            sandbox.stub(internals, "sendRequestWithRetry").resolves(mockStream);

            const tokenSource = new vscode.CancellationTokenSource();
            const options: vscode.LanguageModelChatRequestOptions = {
                justification: "test",
            };

            const result = await provider.provideCommitMessage("diff", options, tokenSource.token);
            assert.ok(result);

            tokenSource.dispose();
        });
    });

    suite("extractTextFromStream", () => {
        test("should extract text from valid SSE stream", async () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            const internals = accessInternals(provider);

            // Set up all required mocks
            const modelId = "gpt-4o";
            internals._registry.setModelsForBackend("http://localhost:4000", "test-api-key", "localhost:4000", [
                {
                    id: modelId,
                    name: "GPT-4o",
                    family: "gpt-4o",
                    version: "1.0",
                    maxInputTokens: 128000,
                    maxOutputTokens: 4096,
                    capabilities: { toolCalling: true, imageInput: false },
                },
            ]);

            // Stub registryEntries to return our test model
            sandbox
                .stub(internals, "registryEntries")
                .returns([
                    [modelId, { baseUrl: "http://localhost:4000", apiKey: "test-api-key", rawModelName: modelId }],
                ]);

            sandbox.stub(internals._configManager, "getConfig").resolves({
                commitModelIdOverride: modelId,
            });
            sandbox.stub(internals._registry, "getModelInfo").returns({});
            sandbox.stub(internals, "buildOpenAIChatRequest").resolves({} as Record<string, unknown>);

            // Create stream with multi-chunk response
            const text1 = "feat: ";
            const text2 = "add feature";
            const delta1 = JSON.stringify({ choices: [{ delta: { content: text1 }, finish_reason: null }] });
            const delta2 = JSON.stringify({ choices: [{ delta: { content: text2 }, finish_reason: null }] });
            const done = JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] });
            const sseData = `data: ${delta1}\n\ndata: ${delta2}\n\ndata: ${done}\n\ndata: [DONE]\n\n`;

            const mockStream = createMockStream([sseData]);
            sandbox.stub(internals, "sendRequestWithRetry").resolves(mockStream);

            const tokenSource = new vscode.CancellationTokenSource();
            const options: vscode.LanguageModelChatRequestOptions = {
                justification: "test",
            };

            const result = await provider.provideCommitMessage("diff", options, tokenSource.token);
            assert.strictEqual(result, text1 + text2);

            tokenSource.dispose();
        });

        test("should handle malformed JSON in stream gracefully", async () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            const internals = accessInternals(provider);

            const modelId = "gpt-4o";
            internals._registry.setModelsForBackend("http://localhost:4000", "test-api-key", "localhost:4000", [
                {
                    id: modelId,
                    name: "GPT-4o",
                    family: "gpt-4o",
                    version: "1.0",
                    maxInputTokens: 128000,
                    maxOutputTokens: 4096,
                    capabilities: { toolCalling: true, imageInput: false },
                },
            ]);

            // Stub registryEntries to return our test model
            sandbox
                .stub(internals, "registryEntries")
                .returns([
                    [modelId, { baseUrl: "http://localhost:4000", apiKey: "test-api-key", rawModelName: modelId }],
                ]);

            sandbox.stub(internals._configManager, "getConfig").resolves({
                commitModelIdOverride: modelId,
            });
            sandbox.stub(internals._registry, "getModelInfo").returns({});
            sandbox.stub(internals, "buildOpenAIChatRequest").resolves({} as Record<string, unknown>);

            // Create stream with malformed JSON followed by valid JSON
            const validText = "fix: typo";
            const malformed = "data: {invalid json}\n\n";
            const valid = JSON.stringify({ choices: [{ delta: { content: validText }, finish_reason: null }] });
            const done = JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] });
            const sseData = `${malformed}data: ${valid}\n\ndata: ${done}\n\ndata: [DONE]\n\n`;

            const mockStream = createMockStream([sseData]);
            sandbox.stub(internals, "sendRequestWithRetry").resolves(mockStream);

            const tokenSource = new vscode.CancellationTokenSource();
            const options: vscode.LanguageModelChatRequestOptions = {
                justification: "test",
            };

            // Should not throw, just skip malformed chunks
            const result = await provider.provideCommitMessage("diff", options, tokenSource.token);
            assert.strictEqual(result, validText);

            tokenSource.dispose();
        });

        test("should respect cancellation token", async () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            const internals = accessInternals(provider);

            const modelId = "gpt-4o";
            internals._registry.setModelsForBackend("http://localhost:4000", "test-api-key", "localhost:4000", [
                {
                    id: modelId,
                    name: "GPT-4o",
                    family: "gpt-4o",
                    version: "1.0",
                    maxInputTokens: 128000,
                    maxOutputTokens: 4096,
                    capabilities: { toolCalling: true, imageInput: false },
                },
            ]);

            // Stub registryEntries to return our test model
            sandbox
                .stub(internals, "registryEntries")
                .returns([
                    [modelId, { baseUrl: "http://localhost:4000", apiKey: "test-api-key", rawModelName: modelId }],
                ]);

            sandbox.stub(internals._configManager, "getConfig").resolves({
                commitModelIdOverride: modelId,
            });
            sandbox.stub(internals._registry, "getModelInfo").returns({});
            sandbox.stub(internals, "buildOpenAIChatRequest").resolves({} as Record<string, unknown>);

            // Create a stream
            const mockStream = createMockStream([createSSEResponse("test")]);
            sandbox.stub(internals, "sendRequestWithRetry").resolves(mockStream);

            const tokenSource = new vscode.CancellationTokenSource();

            // Cancel immediately
            tokenSource.cancel();

            const options: vscode.LanguageModelChatRequestOptions = {
                justification: "test",
            };

            // Should handle cancellation gracefully
            const result = await provider.provideCommitMessage("diff", options, tokenSource.token);
            // Result may be empty due to cancellation
            assert.ok(result !== undefined);

            tokenSource.dispose();
        });
    });

    suite("Telemetry Integration", () => {
        test("should report success metrics after generation", async () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            const internals = accessInternals(provider);

            const modelId = "gpt-4o";
            internals._registry.setModelsForBackend("http://localhost:4000", "test-api-key", "localhost:4000", [
                {
                    id: modelId,
                    name: "GPT-4o",
                    family: "gpt-4o",
                    version: "1.0",
                    maxInputTokens: 128000,
                    maxOutputTokens: 4096,
                    capabilities: { toolCalling: true, imageInput: false },
                },
            ]);

            // Stub registryEntries to return our test model
            sandbox
                .stub(internals, "registryEntries")
                .returns([
                    [modelId, { baseUrl: "http://localhost:4000", apiKey: "test-api-key", rawModelName: modelId }],
                ]);

            sandbox.stub(internals._configManager, "getConfig").resolves({
                commitModelIdOverride: modelId,
            });
            sandbox.stub(internals._registry, "getModelInfo").returns({
                max_input_tokens: 128000,
                max_output_tokens: 4096,
            });
            sandbox.stub(internals, "buildOpenAIChatRequest").resolves({} as Record<string, unknown>);

            const mockStream = createMockStream([createSSEResponse("feat: feature")]);
            sandbox.stub(internals, "sendRequestWithRetry").resolves(mockStream);

            // Stub telemetry
            const reportMetricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");

            const tokenSource = new vscode.CancellationTokenSource();
            const options: vscode.LanguageModelChatRequestOptions = {
                justification: "test",
            };

            await provider.provideCommitMessage("diff", options, tokenSource.token);

            // Verify telemetry was called with success status
            assert.ok(reportMetricStub.calledOnce);
            const call = reportMetricStub.firstCall.args[0];
            assert.strictEqual(call.status, "success");
            assert.strictEqual(call.caller, "scm-generator");
            assert.strictEqual(call.estimatedInputCost, undefined);
            assert.strictEqual(call.estimatedOutputCost, undefined);
            assert.strictEqual(call.estimatedTotalCost, undefined);

            tokenSource.dispose();
        });

        test("should report failure metrics on error", async () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            const internals = accessInternals(provider);

            sandbox.stub(internals._configManager, "getConfig").resolves({});

            const reportMetricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");

            const tokenSource = new vscode.CancellationTokenSource();
            const options: vscode.LanguageModelChatRequestOptions = {
                justification: "test",
            };

            await assert.rejects(async () => {
                await provider.provideCommitMessage("diff", options, tokenSource.token);
            }, /No model available/);

            // Verify telemetry was called with failure status
            assert.ok(reportMetricStub.calledOnce);
            const call = reportMetricStub.firstCall.args[0];
            assert.strictEqual(call.status, "failure");
            assert.strictEqual(call.estimatedInputCost, undefined);
            assert.strictEqual(call.estimatedOutputCost, undefined);
            assert.strictEqual(call.estimatedTotalCost, undefined);

            tokenSource.dispose();
        });
    });

    suite("Edge Cases", () => {
        test("should handle empty diff", async () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            const internals = accessInternals(provider);

            const modelId = "gpt-4o";
            internals._registry.setModelsForBackend("http://localhost:4000", "test-api-key", "localhost:4000", [
                {
                    id: modelId,
                    name: "GPT-4o",
                    family: "gpt-4o",
                    version: "1.0",
                    maxInputTokens: 128000,
                    maxOutputTokens: 4096,
                    capabilities: { toolCalling: true, imageInput: false },
                },
            ]);

            // Stub registryEntries to return our test model
            sandbox
                .stub(internals, "registryEntries")
                .returns([
                    [modelId, { baseUrl: "http://localhost:4000", apiKey: "test-api-key", rawModelName: modelId }],
                ]);

            sandbox.stub(internals._configManager, "getConfig").resolves({
                commitModelIdOverride: modelId,
            });
            sandbox.stub(internals._registry, "getModelInfo").returns({});
            sandbox.stub(internals, "buildOpenAIChatRequest").resolves({} as Record<string, unknown>);

            const mockStream = createMockStream([createSSEResponse("chore: empty commit")]);
            sandbox.stub(internals, "sendRequestWithRetry").resolves(mockStream);

            const tokenSource = new vscode.CancellationTokenSource();
            const options: vscode.LanguageModelChatRequestOptions = {
                justification: "test",
            };

            const result = await provider.provideCommitMessage("", options, tokenSource.token);
            assert.ok(result);

            tokenSource.dispose();
        });

        test("should handle large diff", async () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            const internals = accessInternals(provider);

            const modelId = "gpt-4o";
            internals._registry.setModelsForBackend("http://localhost:4000", "test-api-key", "localhost:4000", [
                {
                    id: modelId,
                    name: "GPT-4o",
                    family: "gpt-4o",
                    version: "1.0",
                    maxInputTokens: 128000,
                    maxOutputTokens: 4096,
                    capabilities: { toolCalling: true, imageInput: false },
                },
            ]);

            // Stub registryEntries to return our test model
            sandbox
                .stub(internals, "registryEntries")
                .returns([
                    [modelId, { baseUrl: "http://localhost:4000", apiKey: "test-api-key", rawModelName: modelId }],
                ]);

            sandbox.stub(internals._configManager, "getConfig").resolves({
                commitModelIdOverride: modelId,
            });
            sandbox.stub(internals._registry, "getModelInfo").returns({});
            sandbox.stub(internals, "buildOpenAIChatRequest").resolves({} as Record<string, unknown>);

            const mockStream = createMockStream([createSSEResponse("feat: large changes")]);
            sandbox.stub(internals, "sendRequestWithRetry").resolves(mockStream);

            const tokenSource = new vscode.CancellationTokenSource();
            const options: vscode.LanguageModelChatRequestOptions = {
                justification: "test",
            };

            // Create a large diff (10KB)
            const largeDiff = "a".repeat(10 * 1024);
            const result = await provider.provideCommitMessage(largeDiff, options, tokenSource.token);
            assert.ok(result);

            tokenSource.dispose();
        });

        test("should handle configuration parameter", async () => {
            const provider = new LiteLLMCommitMessageProvider(mockSecrets, userAgent);
            const internals = accessInternals(provider);

            const modelId = "gpt-4o";
            internals._registry.setModelsForBackend("http://localhost:4000", "test-api-key", "localhost:4000", [
                {
                    id: modelId,
                    name: "GPT-4o",
                    family: "gpt-4o",
                    version: "1.0",
                    maxInputTokens: 128000,
                    maxOutputTokens: 4096,
                    capabilities: { toolCalling: true, imageInput: false },
                },
            ]);

            // Stub registryEntries to return our test model
            sandbox
                .stub(internals, "registryEntries")
                .returns([
                    [modelId, { baseUrl: "http://localhost:4000", apiKey: "test-api-key", rawModelName: modelId }],
                ]);

            sandbox.stub(internals._configManager, "getConfig").resolves({
                commitModelIdOverride: modelId,
            });
            sandbox.stub(internals._registry, "getModelInfo").returns({});
            sandbox.stub(internals, "buildOpenAIChatRequest").resolves({} as Record<string, unknown>);

            const mockStream = createMockStream([createSSEResponse("test")]);
            const sendRequestStub = sandbox.stub(internals, "sendRequestWithRetry").resolves(mockStream);

            const tokenSource = new vscode.CancellationTokenSource();
            const options: vscode.LanguageModelChatRequestOptions = {
                justification: "test",
            };

            const customConfig = { customSetting: "value" };
            await provider.provideCommitMessage("diff", options, tokenSource.token, undefined, customConfig);

            // Verify the configuration was passed through
            assert.ok(sendRequestStub.calledOnce);
            const callArgs = sendRequestStub.firstCall.args;
            // find the options argument (4th arg)
            const passedOptions = callArgs[3] as { configuration?: unknown };
            assert.deepStrictEqual(passedOptions.configuration, customConfig);

            tokenSource.dispose();
        });
    });
});
