import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import * as tokenUtils from "../../adapters/tokenUtils";
import {
    getCalibrationFactor,
    recordCalibrationObservation,
    resetCalibration,
} from "../../adapters/tokenizers/tokenCalibration";
import { StreamTokenCapture } from "../../adapters/streaming/streamTokenCapture";
import { ConfigManager } from "../../config/configManager";
import { createMockModel, createMockSecrets, noop } from "../../test/utils/testMocks";
import { RequestBuilder } from "../base/requestBuilder";
import { LiteLLMChatProvider } from "../liteLLMChatProvider";
import { LiteLLMCommitMessageProvider } from "../liteLLMCommitProvider";
import type { LiteLLMProviderRegistry } from "../liteLLMProviderRegistry";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest, OpenAIUsagePayload } from "../../types";

const rawId = "chatgpt/gpt-6.1-sol";
const fullId = `proxy.example/${rawId}`;
const model = Object.freeze(createMockModel({ id: fullId, maxInputTokens: 1000, maxOutputTokens: 128 }));
const modelInfo: LiteLLMModelInfo = Object.freeze({ max_input_tokens: 1000, max_output_tokens: 128 });
const options = { modelOptions: {}, tools: [] } as unknown as vscode.ProvideLanguageModelChatResponseOptions;
const inputBudget = 950;

interface ProviderAccess {
    _registry: LiteLLMProviderRegistry;
    getCallTimeConfiguration(): Promise<Record<string, unknown>>;
    buildOpenAIChatRequest: RequestBuilder["buildOpenAIChatRequest"];
    sendRequestToLiteLLM(request: OpenAIChatCompletionRequest): Promise<ReadableStream<Uint8Array>>;
    sendRequestWithRetry(
        request: OpenAIChatCompletionRequest,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        host: vscode.LanguageModelChatInformation,
        requestOptions: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        info?: LiteLLMModelInfo,
        onRequestAttempt?: (request: OpenAIChatCompletionRequest) => void
    ): Promise<ReadableStream<Uint8Array>>;
    sendOnceWithOverflow(
        request: OpenAIChatCompletionRequest,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        host: vscode.LanguageModelChatInformation,
        requestOptions: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        info?: LiteLLMModelInfo
    ): Promise<ReadableStream<Uint8Array>>;
}

function history(): vscode.LanguageModelChatRequestMessage[] {
    return [
        vscode.LanguageModelChatMessage.User("a ".repeat(200)),
        vscode.LanguageModelChatMessage.Assistant("a ".repeat(200)),
        vscode.LanguageModelChatMessage.User("a ".repeat(200)),
    ];
}

function learnCalibration(id = rawId): void {
    recordCalibrationObservation(id, 4000, 1000);
    recordCalibrationObservation(id, 4000, 1000);
}

function usageStream(promptTokens?: number): ReadableStream<Uint8Array> {
    const usage =
        promptTokens === undefined
            ? ""
            : `data: ${JSON.stringify({ usage: { prompt_tokens: promptTokens, completion_tokens: 1 } })}\n\n`;
    const body = `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n${usage}data: [DONE]\n\n`;
    return new ReadableStream<Uint8Array>({
        start: (controller) => {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
        },
    });
}

suite("Request trimming uses the usage calibration key", () => {
    let sandbox: sinon.SinonSandbox;
    let builder: RequestBuilder;
    let registries: LiteLLMProviderRegistry[];

    setup(() => {
        resetCalibration();
        sandbox = sinon.createSandbox();
        registries = [];
        const configManager = sandbox.createStubInstance(ConfigManager);
        configManager.getConfig.resolves({});
        builder = new RequestBuilder({
            configManager,
            getReasoningEffort: () => undefined,
            detectQuotaToolRedaction: (_messages, tools) => ({ tools, confidence: "none" }),
            stripUnsupportedParametersFromRequest: noop,
            isParameterSupported: () => true,
            getTelemetryOptions: () => ({}),
            usageOptOutModels: new Set(),
            extractRawModelName: (id) => id.replace(/^proxy\.example\//, ""),
        });
    });

    teardown(() => {
        for (const registry of registries) {
            registry.dispose();
        }
        sandbox.restore();
        resetCalibration();
    });

    function createChatProvider(): {
        provider: LiteLLMChatProvider;
        access: ProviderAccess;
        callConfiguration: sinon.SinonStub<[], Promise<Record<string, unknown>>>;
    } {
        sandbox.stub(ConfigManager.prototype, "getConfig").resolves({});
        const provider = new LiteLLMChatProvider(createMockSecrets(), "calibration-test");
        const access = provider as unknown as ProviderAccess;
        registries.push(access._registry);
        const callConfiguration = sandbox.stub(access, "getCallTimeConfiguration").resolves({});
        return { provider, access, callConfiguration };
    }

    test("trims namespaced history using calibration learned from upstream usage", async () => {
        const messages = history();
        const initial = await builder.buildOpenAIChatRequest(messages, model, options, modelInfo);
        assert.strictEqual(initial.messages.length, 3);
        assert.strictEqual(tokenUtils.countOpenAIChatMessagesTokens(initial.messages, rawId, modelInfo), 780);

        const capture = new StreamTokenCapture(rawId, { report: noop }, modelInfo);
        capture.setEstimatedPromptTokens(780);
        capture.progress.report(
            new vscode.LanguageModelDataPart(
                new TextEncoder().encode(JSON.stringify({ prompt_tokens: 1560, completion_tokens: 1 })),
                "usage"
            )
        );
        assert.strictEqual(capture.getSnapshot().sawUpstreamUsage, true);
        assert.strictEqual(getCalibrationFactor(rawId), 1.3);
        assert.strictEqual(getCalibrationFactor(fullId), 1);
        const trim = sandbox.spy(tokenUtils, "trimMessagesToFitBudget");

        const request = await builder.buildOpenAIChatRequest(messages, model, options, modelInfo);

        assert.strictEqual(request.model, rawId);
        assert.strictEqual(request.messages.length, 2);
        assert.strictEqual(request.messages[0].content, "a ".repeat(200));
        assert.strictEqual(request.messages[1].role, "user");
        assert.strictEqual(request.messages[1].content, "a ".repeat(200));
        assert.strictEqual(tokenUtils.countOpenAIChatMessagesTokens(request.messages, rawId, modelInfo), 676);
        assert.strictEqual(trim.firstCall.args[2], model, "trim telemetry must retain the original model identity");
        assert.strictEqual(model.maxInputTokens, 1000);
        assert.strictEqual(request.max_tokens, 128);
        assert.strictEqual(getCalibrationFactor(fullId), 1);
    });

    test("chat skips multimodal usage calibration but learns from the next text-only turn", async () => {
        const { provider, access } = createChatProvider();
        let upstreamPromptTokens = 0;
        sandbox.stub(access, "sendRequestToLiteLLM").callsFake(async () => usageStream(upstreamPromptTokens));
        const text = "a ".repeat(200);
        const source = new vscode.CancellationTokenSource();
        try {
            for (const media of [
                { mime: "image/png", bytes: 1, cost: 86 },
                { mime: "application/pdf", bytes: 400, cost: 100 },
            ]) {
                resetCalibration();
                const messages = [
                    vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelTextPart(text),
                        new vscode.LanguageModelDataPart(new Uint8Array(media.bytes), media.mime),
                    ]),
                ];
                const send = () =>
                    provider.provideLanguageModelChatResponse(model, messages, options, { report: noop }, source.token);

                // Upstream = exact text estimate (260) + media: nothing to correct.
                upstreamPromptTokens = 260 + media.cost;
                await send();
                assert.strictEqual(getCalibrationFactor(rawId), 1, `${media.mime} must not inflate the text factor`);
                assert.strictEqual(tokenUtils.countTokens(text, rawId, modelInfo), 260);

                // Total usage cannot distinguish a text undercount from media cost.
                upstreamPromptTokens = 346 + media.cost;
                await send();
                assert.strictEqual(getCalibrationFactor(rawId), 1);
                assert.strictEqual(tokenUtils.countTokens(text, rawId, modelInfo), 260);

                upstreamPromptTokens = 346;
                await provider.provideLanguageModelChatResponse(
                    model,
                    [vscode.LanguageModelChatMessage.User(text)],
                    options,
                    { report: noop },
                    source.token
                );
                assert.strictEqual(tokenUtils.countTokens(text, rawId, modelInfo), 286);
            }
        } finally {
            source.dispose();
        }
    });

    for (const upstreamUsage of [true, false]) {
        test(`text-only overflow retry uses the successful attempt estimate for ${upstreamUsage ? "calibration" : "fallback usage"}`, async () => {
            const { provider, access } = createChatProvider();
            const attempts: number[] = [];
            const reportedUsage: OpenAIUsagePayload[] = [];
            sandbox.stub(access, "sendRequestToLiteLLM").callsFake(async (request) => {
                const estimate = tokenUtils.countOpenAIChatMessagesTokens(request.messages, rawId, modelInfo);
                attempts.push(estimate);
                if (attempts.length === 1) {
                    // A concurrent turn changes calibration while this attempt is pending.
                    recordCalibrationObservation(rawId, 1560, 780);
                    throw new Error("context length exceeded");
                }
                return usageStream(upstreamUsage ? estimate : undefined);
            });
            const source = new vscode.CancellationTokenSource();
            try {
                await provider.provideLanguageModelChatResponse(
                    model,
                    history(),
                    options,
                    {
                        report: (part) => {
                            if (part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage") {
                                reportedUsage.push(
                                    JSON.parse(Buffer.from(part.data).toString("utf8")) as OpenAIUsagePayload
                                );
                            }
                        },
                    },
                    source.token
                );
                assert.deepStrictEqual(attempts, [780, 676]);
                assert.strictEqual(reportedUsage.at(-1)?.prompt_tokens, 676);
                assert.strictEqual(getCalibrationFactor(rawId), 1.3);
            } finally {
                source.dispose();
            }
        });
    }

    test("captures the attempt estimate after asynchronous configuration resolution", async () => {
        const { provider, access, callConfiguration } = createChatProvider();
        callConfiguration.callsFake(async () => {
            recordCalibrationObservation(rawId, 800, 300);
            return {};
        });
        sandbox.stub(access, "sendRequestToLiteLLM").callsFake(async (request) => {
            const estimate = tokenUtils.countOpenAIChatMessagesTokens(request.messages, rawId, modelInfo);
            assert.strictEqual(estimate, 390);
            return usageStream(estimate);
        });
        const source = new vscode.CancellationTokenSource();
        try {
            await provider.provideLanguageModelChatResponse(
                model,
                [vscode.LanguageModelChatMessage.User("a ".repeat(200))],
                options,
                { report: noop },
                source.token
            );
            assert.strictEqual(getCalibrationFactor(rawId), 1.5);
        } finally {
            source.dispose();
        }
    });

    test("does not recount a sent prompt when another turn updates calibration before usage arrives", async () => {
        const { provider, access } = createChatProvider();
        sandbox.stub(access, "sendRequestToLiteLLM").callsFake(async () => {
            recordCalibrationObservation(rawId, 800, 300);
            return usageStream(260);
        });
        const source = new vscode.CancellationTokenSource();
        try {
            await provider.provideLanguageModelChatResponse(
                model,
                [vscode.LanguageModelChatMessage.User("a ".repeat(200))],
                options,
                { report: noop },
                source.token
            );
            assert.strictEqual(getCalibrationFactor(rawId), 1.5);
        } finally {
            source.dispose();
        }
    });

    test("concurrent turns keep their fallback usage estimates request-local", async () => {
        const { provider, access } = createChatProvider();
        let releaseFirst = noop;
        let signalFirstStarted = noop;
        const firstStarted = new Promise<void>((resolve) => {
            signalFirstStarted = resolve;
        });
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const send = sandbox.stub(access, "sendRequestToLiteLLM");
        send.onFirstCall().callsFake(async () => {
            signalFirstStarted();
            await firstGate;
            return usageStream();
        });
        send.onSecondCall().callsFake(async () => usageStream());
        const source = new vscode.CancellationTokenSource();
        const runTurn = async (words: number): Promise<number | undefined> => {
            let promptTokens: number | undefined;
            await provider.provideLanguageModelChatResponse(
                model,
                [vscode.LanguageModelChatMessage.User("a ".repeat(words))],
                options,
                {
                    report: (part) => {
                        if (part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage") {
                            const usage = JSON.parse(Buffer.from(part.data).toString("utf8")) as OpenAIUsagePayload;
                            promptTokens = usage.prompt_tokens;
                        }
                    },
                },
                source.token
            );
            return promptTokens;
        };
        const firstTurn = runTurn(200);
        try {
            await firstStarted;
            assert.strictEqual(await runTurn(400), 520);
            releaseFirst();
            assert.strictEqual(await firstTurn, 260);
            assert.strictEqual(getCalibrationFactor(rawId), 1);
        } finally {
            releaseFirst();
            await firstTurn;
            source.dispose();
        }
    });

    test("inaccurate image/PDF estimates preserve learned text calibration and full usage", async () => {
        const { provider, access } = createChatProvider();
        let upstreamPromptTokens = 0;
        const send = sandbox
            .stub(access, "sendRequestToLiteLLM")
            .callsFake(async () => usageStream(upstreamPromptTokens));
        const text = "a ".repeat(250);
        const source = new vscode.CancellationTokenSource();
        try {
            for (const media of [
                { mime: "application/pdf", bytes: 1600, cost: 400, actualCosts: [100, 1236] },
                { mime: "image/png", bytes: 1, cost: 86, actualCosts: [12, 1089] },
            ]) {
                for (const actualCost of media.actualCosts) {
                    resetCalibration();
                    recordCalibrationObservation(rawId, 800, 300);
                    assert.strictEqual(getCalibrationFactor(rawId), 1.5);
                    const messages = [
                        vscode.LanguageModelChatMessage.User([
                            new vscode.LanguageModelDataPart(new Uint8Array(media.bytes), media.mime),
                        ]),
                        vscode.LanguageModelChatMessage.User(text),
                    ];
                    assert.strictEqual(tokenUtils.countMessageMediaTokens(messages), media.cost);
                    upstreamPromptTokens = 488 + actualCost;
                    const usage: OpenAIUsagePayload[] = [];
                    await provider.provideLanguageModelChatResponse(
                        model,
                        messages,
                        options,
                        {
                            report: (part) => {
                                if (part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage") {
                                    usage.push(
                                        JSON.parse(Buffer.from(part.data).toString("utf8")) as OpenAIUsagePayload
                                    );
                                }
                            },
                        },
                        source.token
                    );
                    assert.strictEqual(send.lastCall.args[0].messages.length, 2);
                    assert.strictEqual(usage[usage.length - 1].prompt_tokens, upstreamPromptTokens);
                    assert.strictEqual(getCalibrationFactor(rawId), 1.5, `${media.mime}, actual cost ${actualCost}`);
                    assert.strictEqual(tokenUtils.countTokens(text, rawId, modelInfo), 488);
                }
            }
        } finally {
            source.dispose();
        }
    });

    for (const mediaRetainedInitially of [true, false]) {
        test(`multimodal calibration stays disabled when overflow retry ${mediaRetainedInitially ? "removes" : "restores"} an attachment`, async () => {
            const { provider, access } = createChatProvider();
            if (mediaRetainedInitially) {
                recordCalibrationObservation(rawId, 800, 300);
            } else {
                learnCalibration();
            }
            const messages = [
                vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelDataPart(new Uint8Array(1600), "application/pdf"),
                ]),
                vscode.LanguageModelChatMessage.User("a ".repeat(250)),
            ];
            const attempts: { textTokens: number; hasPDF: boolean }[] = [];
            sandbox.stub(access, "sendRequestToLiteLLM").callsFake(async (request) => {
                const attempt = {
                    textTokens: tokenUtils.countOpenAIChatMessagesTokens(request.messages, rawId, modelInfo),
                    hasPDF: request.messages.some(
                        (message) =>
                            Array.isArray(message.content) && message.content.some((part) => part.type === "file")
                    ),
                };
                attempts.push(attempt);
                if (attempts.length === 1) {
                    // Another request finishes while this attempt is pending. Recovery
                    // re-trims the original history using the updated shared factor.
                    if (mediaRetainedInitially) {
                        learnCalibration();
                    } else {
                        recordCalibrationObservation(rawId, 250, 1500);
                    }
                    throw new Error("context length exceeded");
                }
                // The attachment-free usage must move the factor below its ceiling if
                // learning accidentally runs, even after retry estimates are refreshed.
                return usageStream(attempt.hasPDF ? attempt.textTokens + 400 : 325);
            });
            const source = new vscode.CancellationTokenSource();
            try {
                await provider.provideLanguageModelChatResponse(
                    model,
                    messages,
                    options,
                    { report: noop },
                    source.token
                );
                const withPDF = { textTokens: 488, hasPDF: true };
                const withoutPDF = { textTokens: 650, hasPDF: false };
                assert.deepStrictEqual(
                    attempts,
                    mediaRetainedInitially ? [withPDF, withoutPDF] : [withoutPDF, withPDF]
                );
                assert.strictEqual(getCalibrationFactor(rawId), mediaRetainedInitially ? 2 : 1.5);
            } finally {
                source.dispose();
            }
        });
    }

    test("calibration recognizes empty and nested media but still learns from text/JSON data parts", async () => {
        const { provider, access } = createChatProvider();
        sandbox
            .stub(access, "sendRequestToLiteLLM")
            .callsFake(async (request) =>
                usageStream(2 * tokenUtils.countOpenAIChatMessagesTokens(request.messages, rawId, modelInfo))
            );
        const source = new vscode.CancellationTokenSource();
        try {
            for (const fixture of [
                { part: new vscode.LanguageModelDataPart(new Uint8Array(0), "image/png"), factor: 1 },
                { part: new vscode.LanguageModelDataPart(new Uint8Array(0), "application/pdf"), factor: 1 },
                {
                    part: new vscode.LanguageModelToolResultPart("call_1", [
                        new vscode.LanguageModelDataPart(new Uint8Array(1), "image/png"),
                    ]),
                    factor: 1,
                },
                { part: new vscode.LanguageModelDataPart(new Uint8Array([65]), "text/plain"), factor: 1.3 },
                {
                    part: new vscode.LanguageModelDataPart(new TextEncoder().encode("{}"), "application/json"),
                    factor: 1.3,
                },
                {
                    part: new vscode.LanguageModelDataPart(new Uint8Array([65]), "application/octet-stream"),
                    factor: 1.3,
                },
            ]) {
                resetCalibration();
                await provider.provideLanguageModelChatResponse(
                    model,
                    [
                        vscode.LanguageModelChatMessage.User([
                            new vscode.LanguageModelTextPart("a ".repeat(200)),
                            fixture.part,
                        ]),
                    ],
                    options,
                    { report: noop },
                    source.token
                );
                assert.strictEqual(getCalibrationFactor(rawId), fixture.factor);
            }
        } finally {
            source.dispose();
        }
    });

    test("accepts the exact calibrated input budget and rejects the next larger message", async () => {
        learnCalibration();
        const fitting = await builder.buildOpenAIChatRequest(
            [vscode.LanguageModelChatMessage.User("a ".repeat(365))],
            model,
            options,
            modelInfo
        );
        assert.strictEqual(tokenUtils.countOpenAIChatMessagesTokens(fitting.messages, rawId, modelInfo), inputBudget);
        assert.strictEqual(tokenUtils.countTokens("a ".repeat(366), rawId, modelInfo), 952);
        await assert.rejects(
            () =>
                builder.buildOpenAIChatRequest(
                    [vscode.LanguageModelChatMessage.User("a ".repeat(366))],
                    model,
                    options,
                    modelInfo
                ),
            /Message exceeds token limit\./
        );
    });

    test("preserves a calibrated system prompt and the newest message", async () => {
        learnCalibration();
        const system: vscode.LanguageModelChatRequestMessage = {
            role: 3 as vscode.LanguageModelChatMessageRole,
            content: [new vscode.LanguageModelTextPart("a ".repeat(200))],
            name: undefined,
        };
        // System 520 + newest 260 fits 950; an uncalibrated system cost of 260
        // would incorrectly admit another 260-token history turn before the wire guard.
        const messages = [
            system,
            vscode.LanguageModelChatMessage.User("a ".repeat(100)),
            vscode.LanguageModelChatMessage.Assistant("a ".repeat(100)),
            vscode.LanguageModelChatMessage.User("a ".repeat(100)),
        ];
        const request = await builder.buildOpenAIChatRequest(messages, model, options, modelInfo);
        assert.deepStrictEqual(
            request.messages.map((part) => part.role),
            ["system", "user"]
        );
        assert.strictEqual(request.messages[0].content, "a ".repeat(200));
        assert.strictEqual(tokenUtils.countOpenAIChatMessagesTokens(request.messages, rawId, modelInfo), 780);
    });

    for (const fixture of [
        { id: "anthropic/claude-fable-5-1", provider: "anthropic", inputMaximum: 1021 },
        { id: "bedrock/us.anthropic.claude-fable-5-1-v1:0", provider: "bedrock", inputMaximum: 1021 },
        { id: "gemini/gemini-2.5-pro", provider: "gemini", inputMaximum: 1000 },
        { id: rawId, provider: "chatgpt", inputMaximum: 1000 },
    ]) {
        test(`${fixture.id} trims calibrated text, retains fitting media and rejects genuine overflow`, async () => {
            // 1021 * 0.95 * 0.98 gives Fable the same 950-token budget without
            // bypassing its additional safety margin; other families use 1000 * 0.95.
            const host = Object.freeze({
                ...model,
                id: `proxy.example/${fixture.id}`,
                maxInputTokens: fixture.inputMaximum,
            });
            const info: LiteLLMModelInfo = Object.freeze({
                max_input_tokens: fixture.inputMaximum,
                max_output_tokens: 128,
                litellm_provider: fixture.provider,
            });
            learnCalibration(fixture.id);
            assert.strictEqual(getCalibrationFactor(fixture.id), 2);
            const textRequest = await builder.buildOpenAIChatRequest(history(), host, options, info);
            assert.strictEqual(textRequest.messages.length, 1);
            assert.strictEqual(tokenUtils.countOpenAIChatMessagesTokens(textRequest.messages, fixture.id, info), 520);
            for (const media of [
                { mime: "image/png", bytes: 1, words: 305, cost: 86 },
                { mime: "application/pdf", bytes: 400, words: 300, cost: 100 },
            ]) {
                const attachment = new vscode.LanguageModelDataPart(new Uint8Array(media.bytes), media.mime);
                const older = vscode.LanguageModelChatMessage.User([attachment]);
                const latest = vscode.LanguageModelChatMessage.User("a ".repeat(media.words));
                const messages = [older, latest];
                const trim = sandbox.spy(tokenUtils, "trimMessagesToFitBudget");
                try {
                    const request = await builder.buildOpenAIChatRequest(messages, host, options, info);
                    assert.deepStrictEqual(
                        trim.firstCall.returnValue,
                        messages,
                        "a fitting attachment must not be removed"
                    );
                    assert.strictEqual(trim.firstCall.args[4], inputBudget);
                    assert.strictEqual(request.model, fixture.id);
                    assert.strictEqual(request.messages.length, 2);
                    const content = request.messages[0].content;
                    assert.ok(Array.isArray(content));
                    assert.strictEqual(content[0].type, media.mime === "application/pdf" ? "file" : "image_url");
                    assert.strictEqual(tokenUtils.countMessageMediaTokens(messages), media.cost);
                    assert.strictEqual(
                        tokenUtils.countOpenAIChatMessagesTokens(request.messages, fixture.id, info) + media.cost,
                        880
                    );
                } finally {
                    trim.restore();
                }

                const oversized = vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelTextPart("a ".repeat(334)),
                    attachment,
                ]);
                assert.ok(tokenUtils.countTokens("a ".repeat(334), fixture.id, info) + media.cost > inputBudget);
                await assert.rejects(
                    () => builder.buildOpenAIChatRequest([oversized], host, options, info),
                    /Message exceeds token limit\./
                );
            }
        });
    }

    for (const Provider of [LiteLLMChatProvider, LiteLLMCommitMessageProvider]) {
        test(`${Provider.name} observes every finalized attempt across overflow and reasoning retries`, async () => {
            sandbox.stub(ConfigManager.prototype, "getConfig").resolves({});
            const access = new Provider(createMockSecrets(), "calibration-test") as unknown as ProviderAccess;
            registries.push(access._registry);
            const events: string[] = [];
            sandbox.stub(access, "getCallTimeConfiguration").callsFake(async () => {
                events.push("configuration");
                return {};
            });
            sandbox.stub(access, "buildOpenAIChatRequest").resolves({
                model: rawId,
                messages: [{ role: "user", content: "a ".repeat(100) }],
                max_tokens: 128,
            });
            const observed: { tokens: number; effort: unknown }[] = [];
            const sent: { tokens: number; effort: unknown }[] = [];
            const describe = (request: OpenAIChatCompletionRequest) => ({
                tokens: tokenUtils.countOpenAIChatMessagesTokens(request.messages, rawId, modelInfo),
                effort: request.reasoning_effort,
            });
            sandbox.stub(access, "sendRequestToLiteLLM").callsFake(async (request) => {
                events.push("send");
                sent.push(describe(request));
                if (sent.length === 1) {
                    throw new Error("context length exceeded");
                }
                if (sent.length === 2) {
                    throw Object.assign(new Error("reasoning_effort parameter is not supported"), { status: 400 });
                }
                return usageStream();
            });
            const request = await builder.buildOpenAIChatRequest(history(), model, options, modelInfo);
            request.reasoning_effort = "high";
            const source = new vscode.CancellationTokenSource();
            try {
                await access.sendRequestWithRetry(
                    request,
                    history(),
                    model,
                    options,
                    { report: noop },
                    source.token,
                    "calibration-test",
                    modelInfo,
                    (attempt) => {
                        events.push("observe");
                        observed.push(describe(attempt));
                    }
                );
                assert.deepStrictEqual(sent, [
                    { tokens: 780, effort: "high" },
                    { tokens: 130, effort: "high" },
                    { tokens: 780, effort: "medium" },
                ]);
                assert.deepStrictEqual(observed, sent);
                assert.deepStrictEqual(
                    events,
                    Array.from({ length: 3 }, () => ["configuration", "observe", "send"]).flat()
                );
            } finally {
                source.dispose();
            }
        });

        test(`${Provider.name} calibrates the hard-budget overflow trim before rebuilding and retrying`, async () => {
            sandbox.stub(ConfigManager.prototype, "getConfig").resolves({});
            const access = new Provider(createMockSecrets(), "calibration-test") as unknown as ProviderAccess;
            registries.push(access._registry);
            learnCalibration();
            sandbox.stub(access, "getCallTimeConfiguration").resolves({});
            const rebuild = sandbox.spy(access, "buildOpenAIChatRequest");
            const send = sandbox.stub(access, "sendRequestToLiteLLM");
            send.onFirstCall().rejects(new Error("context length exceeded"));
            const stream = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
            send.onSecondCall().resolves(stream);
            const messages = history();
            const source = new vscode.CancellationTokenSource();
            try {
                const result = await access.sendOnceWithOverflow(
                    { model: rawId, messages: [{ role: "user", content: "recent" }], max_tokens: 128 },
                    messages,
                    model,
                    options,
                    { report: noop },
                    source.token,
                    "calibration-test",
                    modelInfo
                );
                assert.strictEqual(result, stream);
                sinon.assert.calledTwice(send);
                assert.deepStrictEqual(rebuild.firstCall.args[0], [messages[2]]);
                assert.strictEqual(rebuild.firstCall.args[1], model);
                const retry = send.secondCall.args[0];
                assert.strictEqual(retry.messages.length, 1);
                assert.ok(tokenUtils.countOpenAIChatMessagesTokens(retry.messages, rawId, modelInfo) <= inputBudget);
            } finally {
                source.dispose();
            }
        });
    }
});
