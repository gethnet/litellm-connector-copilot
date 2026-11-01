import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { ConfigManager } from "../../config/configManager";
import { countOpenAIChatMessagesTokens, countTokens } from "../../adapters/tokenUtils";
import {
    getCalibrationFactor,
    recordCalibrationObservation,
    resetCalibration,
} from "../../adapters/tokenizers/tokenCalibration";
import { createMockModel, createMockSecrets, noop } from "../../test/utils/testMocks";
import { RequestBuilder } from "../base/requestBuilder";
import { LiteLLMChatProvider } from "../liteLLMChatProvider";
import type { LiteLLMProviderRegistry } from "../liteLLMProviderRegistry";
import type { OpenAIChatCompletionRequest } from "../../types";

const rawId = "anthropic/claude-fable-5-1";
const model = createMockModel({ id: `proxy.example/${rawId}`, maxInputTokens: 1021, maxOutputTokens: 128 });
const info = { max_input_tokens: 1021, max_output_tokens: 128, litellm_provider: "anthropic" };
const options = { tools: [], modelOptions: {} } as unknown as vscode.ProvideLanguageModelChatResponseOptions;

function calibrate(): void {
    recordCalibrationObservation(rawId, 4000, 1000);
    recordCalibrationObservation(rawId, 4000, 1000);
}

suite("Calibrated history regression", () => {
    let sandbox: sinon.SinonSandbox;
    let builder: RequestBuilder;
    setup(() => {
        resetCalibration();
        sandbox = sinon.createSandbox();
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
        sandbox.restore();
        resetCalibration();
    });

    test("uses the raw model calibration to trim old history before the wire guard", async () => {
        const messages = ["old", "middle", "new"].map((word) =>
            vscode.LanguageModelChatMessage.User(`${word} `.repeat(200))
        );
        calibrate();
        const request = await builder.buildOpenAIChatRequest(messages, model, options, info);
        assert.strictEqual(request.model, rawId);
        assert.ok(request.messages.length < messages.length);
        assert.ok(countOpenAIChatMessagesTokens(request.messages, rawId, info) <= 950);
        assert.strictEqual(getCalibrationFactor(model.id), 1);
    });

    test("reproduces issue 173 and retains the two newest messages after usage calibration", async () => {
        const id = "chatgpt/gpt-6.1-sol";
        const host = createMockModel({ id: `proxy.example/${id}`, maxInputTokens: 1000, maxOutputTokens: 128 });
        const card = { max_input_tokens: 1000, max_output_tokens: 128 };
        const messages = [
            vscode.LanguageModelChatMessage.User("a ".repeat(200)),
            vscode.LanguageModelChatMessage.Assistant("a ".repeat(200)),
            vscode.LanguageModelChatMessage.User("a ".repeat(200)),
        ];
        recordCalibrationObservation(id, 1560, 780);
        assert.strictEqual(getCalibrationFactor(id), 1.3);
        const request = await builder.buildOpenAIChatRequest(messages, host, options, card);
        assert.deepStrictEqual(
            request.messages.map((message) => message.role),
            ["assistant", "user"]
        );
        assert.strictEqual(request.model, id);
        assert.strictEqual(countOpenAIChatMessagesTokens(request.messages, id, card), 676);
        assert.strictEqual(request.max_tokens, 128);
    });

    test("still rejects a genuinely oversized protected input after calibration", async () => {
        const id = "chatgpt/gpt-6.1-sol";
        const host = createMockModel({ id: `proxy.example/${id}`, maxInputTokens: 1000, maxOutputTokens: 128 });
        const card = { max_input_tokens: 1000, max_output_tokens: 128 };
        recordCalibrationObservation(id, 1560, 780);
        const fitting = await builder.buildOpenAIChatRequest(
            [vscode.LanguageModelChatMessage.User("a ".repeat(561))],
            host,
            options,
            card
        );
        assert.ok(countOpenAIChatMessagesTokens(fitting.messages, id, card) <= 950);
        await assert.rejects(
            () =>
                builder.buildOpenAIChatRequest(
                    [vscode.LanguageModelChatMessage.User("a ".repeat(562))],
                    host,
                    options,
                    card
                ),
            /Message exceeds token limit/
        );
    });

    test("retains fitting media without applying text calibration to its cost", async () => {
        calibrate();
        const messages = [
            vscode.LanguageModelChatMessage.User([new vscode.LanguageModelDataPart(new Uint8Array(1), "image/png")]),
            vscode.LanguageModelChatMessage.User("a ".repeat(305)),
        ];
        const request = await builder.buildOpenAIChatRequest(messages, model, options, info);
        assert.strictEqual(request.messages.length, 2);
        assert.strictEqual(countTokens(messages[0], rawId, info), 86);
    });

    for (const fixture of [
        { id: "gemini/gemini-2.5-pro", provider: "gemini", max: 1000 },
        { id: "openai/gpt-6.1", provider: "openai", max: 1000 },
        { id: "bedrock/us.anthropic.claude-fable-5-1-v1:0", provider: "bedrock", max: 1021 },
    ]) {
        test(`${fixture.id} uses calibrated text and retains fitting PDF history`, async () => {
            const host = createMockModel({
                id: `proxy.example/${fixture.id}`,
                maxInputTokens: fixture.max,
                maxOutputTokens: 128,
            });
            const modelInfo = {
                max_input_tokens: fixture.max,
                max_output_tokens: 128,
                litellm_provider: fixture.provider,
            };
            recordCalibrationObservation(fixture.id, 4000, 1000);
            recordCalibrationObservation(fixture.id, 4000, 1000);
            const messages = [
                vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelDataPart(new Uint8Array(400), "application/pdf"),
                ]),
                vscode.LanguageModelChatMessage.User("a ".repeat(300)),
            ];
            const request = await builder.buildOpenAIChatRequest(messages, host, options, modelInfo);
            assert.strictEqual(request.model, fixture.id);
            assert.strictEqual(request.messages.length, 2);
            assert.strictEqual(countTokens(messages[0], fixture.id, modelInfo), 100);
        });
    }

    test("never leaves an orphaned tool result when calibrated history is trimmed", async () => {
        calibrate();
        const messages = [
            vscode.LanguageModelChatMessage.Assistant([
                new vscode.LanguageModelToolCallPart("call_1", "read_file", { text: "a ".repeat(250) }),
            ]),
            vscode.LanguageModelChatMessage.User([
                new vscode.LanguageModelToolResultPart("call_1", [new vscode.LanguageModelTextPart("short")]),
            ]),
            vscode.LanguageModelChatMessage.User("a ".repeat(150)),
        ];
        const request = await builder.buildOpenAIChatRequest(messages, model, options, info);
        assert.deepStrictEqual(
            request.messages.map((message) => message.role),
            ["user"]
        );
    });

    test("rejects an oversized newest tool exchange instead of orphaning its result", async () => {
        calibrate();
        const messages = [
            vscode.LanguageModelChatMessage.Assistant([
                new vscode.LanguageModelToolCallPart("call_1", "read_file", { text: "a ".repeat(400) }),
            ]),
            vscode.LanguageModelChatMessage.User([
                new vscode.LanguageModelToolResultPart("call_1", [new vscode.LanguageModelTextPart("short")]),
            ]),
        ];
        await assert.rejects(
            () => builder.buildOpenAIChatRequest(messages, model, options, info),
            /Message exceeds token limit/
        );
    });

    test("retains all consecutive results when a parallel tool exchange fits", async () => {
        calibrate();
        const messages = [
            vscode.LanguageModelChatMessage.Assistant([
                new vscode.LanguageModelToolCallPart("call_1", "read_file", { path: "a" }),
                new vscode.LanguageModelToolCallPart("call_2", "read_file", { path: "b" }),
            ]),
            vscode.LanguageModelChatMessage.User([
                new vscode.LanguageModelToolResultPart("call_1", [new vscode.LanguageModelTextPart("first")]),
            ]),
            vscode.LanguageModelChatMessage.User([
                new vscode.LanguageModelToolResultPart("call_2", [new vscode.LanguageModelTextPart("second")]),
            ]),
            vscode.LanguageModelChatMessage.User("continue with these results"),
        ];
        const request = await builder.buildOpenAIChatRequest(messages, model, options, info);
        assert.deepStrictEqual(
            request.messages.map((message) => message.role),
            ["assistant", "tool", "tool", "user"]
        );
    });

    test("multimodal usage cannot calibrate text estimates", async () => {
        sandbox.stub(ConfigManager.prototype, "getConfig").resolves({});
        const provider = new LiteLLMChatProvider(createMockSecrets(), "calibration-test");
        const access = provider as unknown as {
            _registry: LiteLLMProviderRegistry;
            getCallTimeConfiguration(): Promise<Record<string, unknown>>;
            sendRequestToLiteLLM(request: OpenAIChatCompletionRequest): Promise<ReadableStream<Uint8Array>>;
        };
        sandbox.stub(access, "getCallTimeConfiguration").resolves({});
        sandbox.stub(access, "sendRequestToLiteLLM").callsFake(async () => {
            const body =
                'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"usage":{"prompt_tokens":346,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
            return new ReadableStream<Uint8Array>({
                start: (controller) => {
                    controller.enqueue(new TextEncoder().encode(body));
                    controller.close();
                },
            });
        });
        const source = new vscode.CancellationTokenSource();
        try {
            await provider.provideLanguageModelChatResponse(
                model,
                [
                    vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelTextPart("a ".repeat(200)),
                        new vscode.LanguageModelDataPart(new Uint8Array(1), "image/png"),
                    ]),
                ],
                options,
                { report: noop },
                source.token
            );
            assert.strictEqual(getCalibrationFactor(rawId), 1);
        } finally {
            source.dispose();
            access._registry.dispose();
        }
    });

    test("overflow retry calibrates against the successful request instead of the original", async () => {
        sandbox.stub(ConfigManager.prototype, "getConfig").resolves({});
        const provider = new LiteLLMChatProvider(createMockSecrets(), "calibration-test");
        const access = provider as unknown as {
            _registry: LiteLLMProviderRegistry;
            getCallTimeConfiguration(): Promise<Record<string, unknown>>;
            sendRequestToLiteLLM(request: OpenAIChatCompletionRequest): Promise<ReadableStream<Uint8Array>>;
        };
        sandbox.stub(access, "getCallTimeConfiguration").resolves({});
        let attempts = 0;
        sandbox.stub(access, "sendRequestToLiteLLM").callsFake(async (request) => {
            attempts++;
            if (attempts === 1) {
                recordCalibrationObservation(rawId, 1560, 780);
                throw new Error("context length exceeded");
            }
            const estimate = countOpenAIChatMessagesTokens(request.messages, rawId, info);
            const body = `data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"usage":{"prompt_tokens":${estimate},"completion_tokens":1}}\n\ndata: [DONE]\n\n`;
            return new ReadableStream<Uint8Array>({
                start: (controller) => {
                    controller.enqueue(new TextEncoder().encode(body));
                    controller.close();
                },
            });
        });
        const source = new vscode.CancellationTokenSource();
        try {
            await provider.provideLanguageModelChatResponse(
                model,
                [
                    vscode.LanguageModelChatMessage.User("a ".repeat(200)),
                    vscode.LanguageModelChatMessage.Assistant("a ".repeat(200)),
                    vscode.LanguageModelChatMessage.User("a ".repeat(200)),
                ],
                options,
                { report: noop },
                source.token
            );
            assert.strictEqual(attempts, 2);
            assert.strictEqual(getCalibrationFactor(rawId), 1.3);
        } finally {
            source.dispose();
            access._registry.dispose();
        }
    });
});
