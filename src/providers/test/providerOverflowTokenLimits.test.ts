import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { LiteLLMChatProvider } from "../liteLLMChatProvider";
import { LiteLLMCommitMessageProvider } from "../liteLLMCommitProvider";
import { createMockSecrets } from "../../test/utils/testMocks";
import { countOpenAIChatMessagesTokens, estimateToolTokens, isContextOverflowError } from "../../adapters/tokenUtils";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../../types";

interface RetryAccess {
    _registry: { dispose(): void };
    getCallTimeConfiguration(): Promise<Record<string, unknown>>;
    buildOpenAIChatRequest(
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        model: vscode.LanguageModelChatInformation,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        info?: LiteLLMModelInfo
    ): Promise<OpenAIChatCompletionRequest>;
    sendRequestToLiteLLM(request: OpenAIChatCompletionRequest): Promise<ReadableStream<Uint8Array>>;
    sendOnceWithOverflow(
        request: OpenAIChatCompletionRequest,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        model: vscode.LanguageModelChatInformation,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        caller?: string,
        info?: LiteLLMModelInfo
    ): Promise<ReadableStream<Uint8Array>>;
}

const message = (text: string): vscode.LanguageModelChatRequestMessage => ({
    role: vscode.LanguageModelChatMessageRole.User,
    name: undefined,
    content: [new vscode.LanguageModelTextPart(text)],
});

suite("Shared provider overflow budgets (#180)", () => {
    test("internal budget and preserve options never leak into the wire body", async () => {
        const sandbox = sinon.createSandbox();
        const provider = new LiteLLMChatProvider(createMockSecrets(), "test");
        const access = provider as unknown as RetryAccess;
        try {
            sandbox.stub(provider.getConfigManager(), "getConfig").resolves({});
            const model = {
                id: "m",
                maxInputTokens: 1000,
                maxOutputTokens: 400,
            } as vscode.LanguageModelChatInformation;
            const options = {
                modelOptions: {
                    max_tokens: 400,
                    litellm_connector_preserve_messages: true,
                    litellm_connector_input_budget: 500,
                },
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions;
            const body = await access.buildOpenAIChatRequest(
                [message("instruction"), message("+small")],
                model,
                options,
                { max_input_tokens: 1000 } as LiteLLMModelInfo
            );
            assert.strictEqual(body.messages.length, 2);
            assert.strictEqual(body.max_tokens, 400);
            for (const key of ["litellm_connector_preserve_messages", "litellm_connector_input_budget"]) {
                assert.strictEqual(JSON.stringify(body).includes(key), false);
            }
        } finally {
            access._registry.dispose();
            sandbox.restore();
        }
    });

    test("preserve messages is not a finalized input-guard bypass", async () => {
        const sandbox = sinon.createSandbox();
        const provider = new LiteLLMChatProvider(createMockSecrets(), "test");
        const access = provider as unknown as RetryAccess;
        try {
            sandbox.stub(provider.getConfigManager(), "getConfig").resolves({});
            const model = {
                id: "m",
                maxInputTokens: 1000,
                maxOutputTokens: 400,
            } as vscode.LanguageModelChatInformation;
            await assert.rejects(
                () =>
                    access.buildOpenAIChatRequest(
                        [message("instruction"), message("x".repeat(4000))],
                        model,
                        {
                            modelOptions: { max_tokens: 400, litellm_connector_preserve_messages: true },
                        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                        { max_input_tokens: 1000 } as LiteLLMModelInfo
                    ),
                /Message exceeds token limit/
            );
        } finally {
            access._registry.dispose();
            sandbox.restore();
        }
    });

    for (const Provider of [LiteLLMChatProvider, LiteLLMCommitMessageProvider]) {
        for (const scenario of [
            "shrink",
            "sole",
            "preserve",
            "cancel",
            "non-overflow",
            "tool-exchange",
            "output-invalid",
        ] as const) {
            test(`${Provider.name}: ${scenario} uses real finalized bodies`, async () => {
                const sandbox = sinon.createSandbox();
                const source = new vscode.CancellationTokenSource();
                const provider = new Provider(createMockSecrets(), "test");
                const access = provider as unknown as RetryAccess;
                try {
                    sandbox.stub(provider.getConfigManager(), "getConfig").resolves({});
                    sandbox.stub(access, "getCallTimeConfiguration").resolves({});
                    const send = sandbox.stub(access, "sendRequestToLiteLLM");
                    const failure = new Error(
                        scenario === "non-overflow"
                            ? "quota exceeded"
                            : scenario === "output-invalid"
                              ? "max_tokens invalid: too many tokens requested for output"
                              : "prompt is too long: 1115674 tokens > 1000000 maximum"
                    );
                    send.onFirstCall().callsFake(async () => {
                        if (scenario === "cancel") {
                            source.cancel();
                        }
                        throw failure;
                    });
                    send.onSecondCall().resolves(new ReadableStream());
                    const model = Object.freeze({
                        id: "m",
                        maxInputTokens: 1000,
                        maxOutputTokens: 400,
                    }) as vscode.LanguageModelChatInformation;
                    const info = Object.freeze({
                        max_input_tokens: 1000,
                        max_output_tokens: 400,
                    });
                    const tools = [{ name: "read", description: "d".repeat(120), inputSchema: {} }];
                    let history: vscode.LanguageModelChatRequestMessage[] = [
                        message("a".repeat(1400)),
                        message("b".repeat(700)),
                    ];
                    if (scenario === "sole") {
                        history = [message("b".repeat(1400))];
                    }
                    if (scenario === "tool-exchange") {
                        history = [
                            message("old".repeat(150)),
                            {
                                role: vscode.LanguageModelChatMessageRole.Assistant,
                                name: undefined,
                                content: [new vscode.LanguageModelToolCallPart("call-a", "read", {})],
                            },
                            {
                                role: vscode.LanguageModelChatMessageRole.User,
                                name: undefined,
                                content: [
                                    new vscode.LanguageModelToolResultPart("call-a", [
                                        new vscode.LanguageModelTextPart("result".repeat(40)),
                                    ]),
                                ],
                            },
                        ];
                    }
                    const options = {
                        tools,
                        modelOptions: {
                            max_tokens: 400,
                            litellm_connector_preserve_messages: scenario === "preserve",
                        },
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions;
                    const request = await access.buildOpenAIChatRequest(history, model, options, info);
                    const before = JSON.stringify(request);
                    const invoke = () =>
                        access.sendOnceWithOverflow(
                            request,
                            history,
                            model,
                            options,
                            { report: () => undefined },
                            source.token,
                            "test",
                            info
                        );
                    if (
                        scenario === "sole" ||
                        scenario === "preserve" ||
                        scenario === "cancel" ||
                        scenario === "non-overflow" ||
                        scenario === "output-invalid"
                    ) {
                        await assert.rejects(invoke, (error: unknown) => error === failure);
                        assert.strictEqual(send.callCount, 1);
                    } else {
                        await invoke();
                        assert.strictEqual(send.callCount, 2);
                        const first = send.firstCall.args[0] as OpenAIChatCompletionRequest;
                        const second = send.secondCall.args[0] as OpenAIChatCompletionRequest;
                        const cost = (body: OpenAIChatCompletionRequest): number =>
                            countOpenAIChatMessagesTokens(body.messages, "m", info) + estimateToolTokens(body.tools);
                        assert.ok(cost(second) < cost(first));
                        assert.strictEqual(second.max_tokens, 400);
                        assert.deepStrictEqual(second.tools, first.tools);
                        if (scenario === "tool-exchange") {
                            assert.ok(
                                second.messages.some(
                                    (m) => Array.isArray(m.tool_calls) || typeof m.tool_call_id === "string"
                                ),
                                "tool result retained"
                            );
                        } else {
                            assert.strictEqual(second.messages[second.messages.length - 1].content, "b".repeat(700));
                        }
                    }
                    assert.strictEqual(JSON.stringify(request), before);
                    assert.strictEqual(model.maxInputTokens, 1000);
                    assert.strictEqual(info.max_input_tokens, 1000);
                } finally {
                    access._registry.dispose();
                    source.dispose();
                    sandbox.restore();
                }
            });
        }
    }

    test("input overflow classifier handles cyclic cause chain without looping", () => {
        const cyclic: { message: string; cause?: unknown } = { message: "unrelated" };
        cyclic.cause = cyclic;
        assert.strictEqual(isContextOverflowError(cyclic), false);
    });
});
