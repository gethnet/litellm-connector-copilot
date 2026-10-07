import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { RequestBuilder } from "../base/requestBuilder";
import { LiteLLMChatProvider } from "../liteLLMChatProvider";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { ConfigManager } from "../../config/configManager";
import { createMockSecrets } from "../../test/utils/testMocks";
import { deriveCapabilitiesFromModelInfo } from "../../utils/modelCapabilities";
import { transformToResponsesFormat } from "../../adapters/responsesAdapter";
import {
    countTokens,
    estimateToolTokens,
    countOpenAIChatMessagesTokens,
    estimateMediaTokenCost,
} from "../../adapters/tokenUtils";
import { convertMessages } from "../../utils";
import type { LiteLLMModelInfo } from "../../types";

suite("Final request token limits (#159)", () => {
    let sandbox: sinon.SinonSandbox;
    let builder: RequestBuilder;
    setup(() => {
        sandbox = sinon.createSandbox();
        const configManager = sandbox.createStubInstance(ConfigManager);
        configManager.getConfig.resolves({});
        builder = new RequestBuilder({
            configManager,
            getReasoningEffort: () => undefined,
            detectQuotaToolRedaction: (_messages, tools) => ({ tools, confidence: "none" }),
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: () => true,
            getTelemetryOptions: () => ({}),
            usageOptOutModels: new Set(),
            extractRawModelName: (id) => id,
        });
    });
    teardown(() => sandbox.restore());
    const message = (text: string): vscode.LanguageModelChatRequestMessage => ({
        role: vscode.LanguageModelChatMessageRole.User,
        content: [new vscode.LanguageModelTextPart(text)],
        name: undefined,
    });
    const model = Object.freeze({
        id: "test-model",
        maxInputTokens: 1000,
        maxOutputTokens: 400,
    }) as vscode.LanguageModelChatInformation;
    const options = (
        cap: number,
        tools: vscode.LanguageModelChatTool[] = []
    ): vscode.ProvideLanguageModelChatResponseOptions =>
        ({
            modelOptions: { max_tokens: cap },
            tools,
            toolMode: vscode.LanguageModelChatToolMode.Auto,
        }) as unknown as vscode.ProvideLanguageModelChatResponseOptions;

    test("normal Claude legacy output metadata permits hi and retains input above 8192", async () => {
        const info = Object.freeze({ max_input_tokens: 200000, max_output_tokens: 8192, max_tokens: 8192 });
        const claude = {
            ...model,
            id: "claude-sonnet-test",
            maxInputTokens: 200000,
            maxOutputTokens: 8192,
            maxContextWindowTokens: 200000,
        };
        const defaults = { modelOptions: {}, tools: [] } as unknown as vscode.ProvideLanguageModelChatResponseOptions;
        const hi = await builder.buildOpenAIChatRequest([message("hi")], claude, defaults, info);
        assert.strictEqual(hi.max_tokens, 8192);
        const history = [message("a".repeat(40000)), message("recent")];
        assert.ok(countTokens(history, claude.id, info) > 8192);
        for (const cap of [8192, 4096]) {
            const request = await builder.buildOpenAIChatRequest(history, claude, options(cap), info);
            assert.strictEqual(request.messages.length, 2);
            assert.strictEqual(request.max_tokens, cap);
        }
    });
    test("legacy-only projection prepares a default request without inventing total", async () => {
        const info = Object.freeze({ max_tokens: 8192 });
        const caps = deriveCapabilitiesFromModelInfo("m", info);
        const request = await builder.buildOpenAIChatRequest(
            [message("hi")],
            { ...model, ...caps },
            { modelOptions: {} } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            info
        );
        assert.strictEqual(request.max_tokens, 16000);
    });
    test("missing raw metadata keeps connector input context fallback independent", async () => {
        const host = { ...model, maxInputTokens: 200000, maxOutputTokens: 8192, maxContextWindowTokens: 200000 };
        const history = [message("a".repeat(650000)), message("recent")];
        const historyTokens = countTokens(history, host.id);
        assert.ok(historyTokens <= host.maxInputTokens);
        assert.ok(historyTokens > (200000 - 8192) * 0.95);
        const request = await builder.buildOpenAIChatRequest(history, host, options(8192), undefined);
        assert.strictEqual(request.messages.length, 2);
    });
    test("request prep enforces raw ceilings despite larger valid host values", async () => {
        const info = Object.freeze({ max_input_tokens: 100, max_output_tokens: 50 });
        const request = await builder.buildOpenAIChatRequest([message("hi")], model, options(400), info);
        assert.strictEqual(request.max_tokens, 50);
        await assert.rejects(
            () => builder.buildOpenAIChatRequest([message("x".repeat(350))], model, options(400), info),
            /Message exceeds token limit/
        );
        for (const invalid of [0, -1, Number.NaN, Infinity, 0.5]) {
            await assert.rejects(
                () =>
                    builder.buildOpenAIChatRequest([message("hi")], model, options(100), { max_input_tokens: invalid }),
                /Invalid raw input token limit/
            );
            await assert.rejects(
                () =>
                    builder.buildOpenAIChatRequest([message("hi")], model, options(100), {
                        max_output_tokens: invalid,
                    }),
                /Invalid raw output token limit/
            );
        }
    });

    test("actual output cap controls only the explicit combined constraint", async () => {
        const history = [message("a".repeat(2100)), message("b".repeat(350))];
        const info = Object.freeze({ max_input_tokens: 1000, max_output_tokens: 400, context_window_tokens: 1000 });
        const small = await builder.buildOpenAIChatRequest(history, model, options(100), info);
        const large = await builder.buildOpenAIChatRequest(history, model, options(400), info);
        assert.strictEqual(small.messages.length, 2);
        assert.strictEqual(large.messages.length, 1);
        assert.strictEqual(small.max_tokens, 100);
        assert.strictEqual(large.max_tokens, 400);
        const independent = await builder.buildOpenAIChatRequest(history, model, options(400), {
            max_input_tokens: 1000,
        });
        assert.strictEqual(independent.messages.length, 2);
        assert.strictEqual(info.max_input_tokens, 1000);
        assert.strictEqual(model.maxInputTokens, 1000);
        assert.strictEqual(transformToResponsesFormat(large).max_output_tokens, 400);
    });
    test("tools consume the local input budget once", async () => {
        const tools = [{ name: "read", description: "d".repeat(300), inputSchema: {} }];
        const req = await builder.buildOpenAIChatRequest([message("x".repeat(2800))], model, options(400, tools), {
            max_input_tokens: 1000,
        });
        assert.strictEqual(req.messages.length, 1);
        assert.ok(countTokens("x".repeat(2800), model.id) + estimateToolTokens(req.tools) <= 950);
    });
    test("rejects oversized protected input and exhausted combined context before sending", async () => {
        await assert.rejects(
            () =>
                builder.buildOpenAIChatRequest([message("x".repeat(3501))], model, options(100), {
                    max_input_tokens: 1000,
                }),
            /Message exceeds token limit/
        );
        await assert.rejects(
            () => builder.buildOpenAIChatRequest([message("hi")], model, options(400), { context_window_tokens: 400 }),
            /Message exceeds token limit/
        );
        await assert.rejects(
            () => builder.buildOpenAIChatRequest([message("hi")], model, options(Number.NaN), {}),
            /Invalid request output token limit/
        );
    });
    test("media estimates remain part of the protected-message safety guard", async () => {
        const binary = {
            role: vscode.LanguageModelChatMessageRole.User,
            name: undefined,
            content: [new vscode.LanguageModelDataPart(new Uint8Array(8000), "application/pdf")],
        } as vscode.LanguageModelChatRequestMessage;
        assert.ok(countTokens(binary, model.id) > model.maxInputTokens);
        await assert.rejects(
            () => builder.buildOpenAIChatRequest([binary], model, options(100), {}),
            /Message exceeds token limit/
        );
    });
    test("final wire estimate adds disjoint media and normalized tool-result metadata", async () => {
        // Source: image 86 + result text 2 = 88. Wire: text 2 +
        // normalized 42-character tool ID 12 = 14. Each fits 95, sum 100 does not.
        const mixed: vscode.LanguageModelChatRequestMessage = {
            role: vscode.LanguageModelChatMessageRole.User,
            name: undefined,
            content: [
                new vscode.LanguageModelDataPart(new Uint8Array(1), "image/png"),
                new vscode.LanguageModelToolResultPart("call-a", [new vscode.LanguageModelTextPart("x")]),
            ],
        };
        const host = { ...model, maxInputTokens: 100 };
        const wire = convertMessages([mixed]);
        const sourceCost = countTokens([mixed], host.id);
        const transportCost = countOpenAIChatMessagesTokens(wire, host.id);
        const mediaCost = estimateMediaTokenCost("image/png", 1);
        assert.ok(sourceCost <= 95 && transportCost <= 95);
        assert.ok(transportCost + mediaCost > 95);
        await assert.rejects(
            () => builder.buildOpenAIChatRequest([mixed], host, options(100), { max_input_tokens: 100 }),
            /Message exceeds token limit/
        );
        const fitting = await builder.buildOpenAIChatRequest([mixed], { ...host, maxInputTokens: 110 }, options(100), {
            max_input_tokens: 110,
        });
        assert.strictEqual(fitting.messages.length, wire.length);
    });
    test("discovery/cache values survive requests with different output caps", async () => {
        const info: LiteLLMModelInfo = Object.freeze({
            max_input_tokens: 229376,
            max_output_tokens: 32768,
            context_window_tokens: 262144,
        });
        sandbox
            .stub(LiteLLMClient.prototype, "getModelInfo")
            .resolves({ data: [{ model_name: "test-model", model_info: info }] });
        const provider = new LiteLLMChatProvider(createMockSecrets(), "test");
        const tokenSource = new vscode.CancellationTokenSource();
        try {
            const discovered = await provider.discoverModels(
                { silent: true, configuration: { baseUrl: "https://proxy.example.com", apiKey: "test-key" } },
                tokenSource.token
            );
            const registered = discovered[0];
            assert.ok(registered);
            const registry = (
                provider as unknown as {
                    _registry: {
                        getModelInfo(id: string): LiteLLMModelInfo | undefined;
                        getDerivedCapabilities(
                            id: string
                        ): ReturnType<typeof deriveCapabilitiesFromModelInfo> | undefined;
                    };
                }
            )._registry;
            const raw = registry.getModelInfo(registered.id);
            const cached = registry.getDerivedCapabilities(registered.id);
            assert.ok(raw && cached);
            assert.strictEqual(registry.getModelInfo("test-model"), raw);
            const before = { ...cached };
            Object.freeze(raw);
            Object.freeze(cached);
            await builder.buildOpenAIChatRequest([message("hi")], registered, options(4096), raw);
            await builder.buildOpenAIChatRequest([message("hi")], registered, options(32768), raw);
            assert.strictEqual(registry.getDerivedCapabilities(registered.id), cached);
            assert.deepStrictEqual(cached, before);
            assert.strictEqual(cached.maxInputTokens, 229376);
            assert.strictEqual(raw.max_input_tokens, 229376);
        } finally {
            tokenSource.dispose();
            (provider as unknown as { _registry: { clear(): void } })._registry.clear();
        }
    });
});
