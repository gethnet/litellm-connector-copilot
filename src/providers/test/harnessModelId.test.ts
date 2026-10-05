import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { ConfigManager } from "../../config/configManager";
import { LiteLLMClient } from "../../adapters/litellmClient";
import { transformToResponsesFormat } from "../../adapters/responsesAdapter";
import { countTokens } from "../../adapters/tokenUtils";
import { deriveCapabilitiesFromModelInfo } from "../../utils/modelCapabilities";
import { LiteLLMProviderRegistry } from "../liteLLMProviderRegistry";
import { LiteLLMChatProvider } from "../liteLLMChatProvider";
import { LiteLLMCommitMessageProvider } from "../liteLLMCommitProvider";
import { resolveCallTimeConfiguration } from "../base/callConfig";
import { createMockModel, createMockSecrets } from "../../test/utils/testMocks";
import { createTelemetryMocks } from "../../test/utils/telemetryMock";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../../types";

const raw = "azure_ai/claude-sonnet-5-5";
const canonical = `conduit.geth.cc/${raw}`;
const alias = `litellm-connector/Conduit/${canonical}`;
const modelInfo: LiteLLMModelInfo = {
    mode: "chat",
    max_input_tokens: 8192,
    max_output_tokens: 1024,
    supported_openai_params: ["max_tokens", "stream", "stream_options"],
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
};

interface RegistryInternals {
    setModelsForBackend: (
        baseUrl: string,
        apiKey: string,
        routingIdentity: string,
        models: vscode.LanguageModelChatInformation[]
    ) => void;
    modelInfoCache: Map<string, LiteLLMModelInfo | undefined>;
    derivedCapabilitiesCache: Map<string, ReturnType<typeof deriveCapabilitiesFromModelInfo>>;
}

interface ProviderInternals {
    _registry: LiteLLMProviderRegistry;
    buildOpenAIChatRequest: (
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        model: vscode.LanguageModelChatInformation,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        info?: LiteLLMModelInfo,
        caller?: string
    ) => Promise<OpenAIChatCompletionRequest>;
}

function registeredModel(id = canonical): vscode.LanguageModelChatInformation {
    return createMockModel({
        id,
        name: raw,
        family: `Conduit/${raw}`,
        version: "1.0",
        maxInputTokens: 8192,
        maxOutputTokens: 1024,
        capabilities: { toolCalling: true, imageInput: false },
    });
}

function seed(registry: LiteLLMProviderRegistry, id = canonical): void {
    const internals = registry as unknown as RegistryInternals;
    const routing = id.slice(0, id.indexOf("/"));
    internals.setModelsForBackend(`https://${routing}`, "test-key", routing, [registeredModel(id)]);
    internals.modelInfoCache.set(id, modelInfo);
    internals.derivedCapabilitiesCache.set(id, deriveCapabilitiesFromModelInfo(id, modelInfo));
}

function requestMessages(): vscode.LanguageModelChatRequestMessage[] {
    return [
        {
            role: vscode.LanguageModelChatMessageRole.User,
            name: undefined,
            content: [new vscode.LanguageModelTextPart("hi")],
        },
    ];
}

function requestOptions(configuration?: Record<string, unknown>): vscode.ProvideLanguageModelChatResponseOptions {
    return {
        modelOptions: {},
        tools: [],
        toolMode: vscode.LanguageModelChatToolMode.Auto,
        requestInitiator: "harness-model-id-test",
        ...(configuration ? { configuration } : {}),
    } as vscode.ProvideLanguageModelChatResponseOptions;
}

suite("Harness model ID registry and provider regression", () => {
    let sandbox: sinon.SinonSandbox;
    let configManager: sinon.SinonStubbedInstance<ConfigManager>;
    let registry: LiteLLMProviderRegistry;
    let telemetryMocks: ReturnType<typeof createTelemetryMocks>;

    setup(() => {
        sandbox = sinon.createSandbox();
        telemetryMocks = createTelemetryMocks(sandbox);
        telemetryMocks.setup();
        configManager = sandbox.createStubInstance(ConfigManager);
        configManager.getConfig.resolves({ allowChatCompletionsFallback: true, disableCaching: false });
        registry = new LiteLLMProviderRegistry({ configManager, userAgent: "harness-model-id-test" });
        seed(registry);
    });

    teardown(() => {
        registry.dispose();
        telemetryMocks.teardown();
        sandbox.restore();
    });

    test("reported alias shares routing metadata derived capabilities and raw model", () => {
        for (const id of [canonical, `litellm-connector/${canonical}`, alias]) {
            assert.strictEqual(registry.lookup(id), registry.lookup(canonical));
            assert.strictEqual(registry.getModelInfo(id), modelInfo);
            assert.strictEqual(registry.getDerivedCapabilities(id), registry.getDerivedCapabilities(canonical));
            assert.strictEqual(registry.extractRawName(id), raw);
        }
        assert.strictEqual(registry.lookup(alias)?.baseUrl, "https://conduit.geth.cc");
        assert.deepStrictEqual(
            registry.getAllModels().map((model) => model.id),
            [canonical]
        );
    });

    test("a canonical routing identity named like the vendor remains exact", () => {
        const id = `litellm-connector/${raw}`;
        seed(registry, id);
        assert.strictEqual(registry.lookup(id)?.rawModelName, raw);
        assert.strictEqual(registry.extractRawName(id), raw);
    });

    test("ambiguous and unknown wrapper reads miss harmlessly but raw extraction rejects", () => {
        seed(registry, `Dept/${canonical}`);
        for (const id of [`litellm-connector/Team/Dept/${canonical}`, `litellm-connector/Conduit/missing/${raw}`]) {
            assert.strictEqual(registry.lookup(id), undefined);
            assert.strictEqual(registry.getModelInfo(id), undefined);
            assert.strictEqual(registry.getDerivedCapabilities(id), undefined);
            assert.throws(
                () => registry.extractRawName(id),
                (error: unknown) => error instanceof vscode.LanguageModelError
            );
        }
    });

    test("legacy unwrapped raw fallback is intentionally unchanged", () => {
        for (const [id, expected] of [
            ["plain-model", "plain-model"],
            ["legacy/raw/nested", "raw/nested"],
            ["", ""],
        ]) {
            assert.strictEqual(registry.lookup(id), undefined);
            assert.strictEqual(registry.extractRawName(id), expected);
        }
        const prefixless = `Conduit/${canonical}`;
        assert.strictEqual(registry.lookup(prefixless), undefined);
        assert.strictEqual(registry.extractRawName(prefixless), canonical);
    });

    test("clear invalidates aliases without changing exact cache retention", () => {
        registry.clear();
        assert.strictEqual(registry.lookup(alias), undefined);
        assert.strictEqual(registry.getModelInfo(alias), undefined);
        assert.strictEqual(registry.getDerivedCapabilities(alias), undefined);
        assert.strictEqual(registry.getModelInfo(canonical), modelInfo);
        assert.throws(
            () => registry.extractRawName(alias),
            (error: unknown) => error instanceof vscode.LanguageModelError
        );
        registry.clearCaches();
        assert.strictEqual(registry.getModelInfo(canonical), undefined);
    });

    test("clearCaches preserves alias routing but removes metadata", () => {
        registry.clearCaches();
        assert.strictEqual(registry.lookup(alias)?.rawModelName, raw);
        assert.strictEqual(registry.extractRawName(alias), raw);
        assert.strictEqual(registry.getModelInfo(alias), undefined);
        assert.strictEqual(registry.getDerivedCapabilities(alias), undefined);
    });

    test("missing and empty call configuration use registered alias routing", async () => {
        for (const options of [requestOptions(), requestOptions({})]) {
            const configuration = await resolveCallTimeConfiguration(options, registeredModel(alias), {
                configManager,
                registry,
            });
            assert.deepStrictEqual(configuration, {
                baseUrl: "https://conduit.geth.cc",
                apiKey: "test-key",
                allowChatCompletionsFallback: true,
                disableCaching: false,
            });
        }
        assert.strictEqual(
            await resolveCallTimeConfiguration(
                requestOptions(),
                registeredModel("litellm-connector/Team/missing/model"),
                { configManager, registry }
            ),
            undefined
        );
    });

    test("valid explicit configuration wins without selecting credentials from group text", async () => {
        const configuration = await resolveCallTimeConfiguration(
            requestOptions({ baseUrl: "https://explicit.example", apiKey: "explicit-test-key" }),
            registeredModel(alias),
            { configManager, registry }
        );
        assert.strictEqual(configuration?.baseUrl, "https://explicit.example");
        assert.strictEqual(configuration?.apiKey, "explicit-test-key");
    });

    test("chat and retained commit providers share raw request construction for both endpoint shapes", async () => {
        sandbox.stub(ConfigManager.prototype, "getConfig").resolves({});
        const providers = [
            new LiteLLMChatProvider(createMockSecrets(), "harness-model-id-test"),
            new LiteLLMCommitMessageProvider(createMockSecrets(), "harness-model-id-test"),
        ];
        try {
            for (const provider of providers) {
                const internals = provider as unknown as ProviderInternals;
                seed(internals._registry);
                const request = await internals.buildOpenAIChatRequest(
                    requestMessages(),
                    registeredModel(alias),
                    requestOptions(),
                    internals._registry.getModelInfo(alias),
                    "test"
                );
                assert.strictEqual(request.model, raw);
                assert.strictEqual(transformToResponsesFormat(request).model, raw);
                assert.strictEqual(provider.getModelInfo(alias), modelInfo);
                await assert.rejects(
                    () =>
                        internals.buildOpenAIChatRequest(
                            requestMessages(),
                            registeredModel("litellm-connector/Team/missing/model"),
                            requestOptions({ baseUrl: "https://explicit.example", apiKey: "test-key" })
                        ),
                    (error: unknown) => error instanceof vscode.LanguageModelError
                );
            }
        } finally {
            for (const provider of providers) {
                (provider as unknown as ProviderInternals)._registry.dispose();
            }
        }
    });

    test("chat response uses registered alias routing and sends the actual raw model", async () => {
        sandbox.stub(ConfigManager.prototype, "getConfig").resolves({});
        const provider = new LiteLLMChatProvider(createMockSecrets(), "harness-model-id-test");
        const internals = provider as unknown as ProviderInternals;
        seed(internals._registry);
        const chat = sandbox.stub(LiteLLMClient.prototype, "chat").callsFake(async (request, mode, _token, info) => {
            assert.strictEqual(request.model, raw);
            assert.strictEqual(mode, "chat");
            assert.strictEqual(info, modelInfo);
            return new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        new TextEncoder().encode(
                            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
                        )
                    );
                    controller.close();
                },
            });
        });
        const tokenSource = new vscode.CancellationTokenSource();
        const parts: vscode.LanguageModelResponsePart[] = [];
        try {
            await provider.provideLanguageModelChatResponse(
                registeredModel(alias),
                requestMessages(),
                requestOptions(),
                { report: (part) => parts.push(part) },
                tokenSource.token
            );
            sinon.assert.calledOnce(chat);
            assert.ok(parts.some((part) => part instanceof vscode.LanguageModelTextPart && part.value === "ok"));
        } finally {
            tokenSource.dispose();
            internals._registry.dispose();
        }
    });

    test("remote token counting and local count use the registered raw model", async () => {
        sandbox.stub(ConfigManager.prototype, "getConfig").resolves({});
        const provider = new LiteLLMChatProvider(createMockSecrets(), "harness-model-id-test");
        const internals = provider as unknown as ProviderInternals;
        seed(internals._registry);
        const tokenSource = new vscode.CancellationTokenSource();
        let markCounterCalled: () => void = () => {};
        const counterCalled = new Promise<void>((resolve) => {
            markCounterCalled = resolve;
        });
        const counter = sandbox.stub(LiteLLMClient.prototype, "countTokens").callsFake(async (request) => {
            markCounterCalled();
            assert.strictEqual(request.model, raw);
            return { token_count: 321 };
        });
        try {
            const small = "small harness token fixture";
            assert.strictEqual(
                await provider.provideTokenCount(registeredModel(alias), small, tokenSource.token),
                countTokens(small, raw, modelInfo)
            );
            const large = "harness-registered-model-token-fixture ".repeat(30);
            const configuration = { baseUrl: "https://conduit.geth.cc", apiKey: "test-key" };
            await provider.provideTokenCount(registeredModel(alias), large, tokenSource.token, configuration);
            await counterCalled;
            sinon.assert.calledOnce(counter);
            assert.strictEqual(counter.firstCall.args[0].model, raw);
        } finally {
            tokenSource.dispose();
            internals._registry.dispose();
        }
    });
});
