import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { LiteLLMChatProvider } from "../liteLLMChatProvider";
import { LiteLLMCommitMessageProvider } from "../liteLLMCommitProvider";
import { createMockSecrets } from "../../test/utils/testMocks";
import type { LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../../types";

interface RetryAccess {
    getCallTimeConfiguration(): Promise<Record<string, unknown>>;
    buildOpenAIChatRequest(
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        model: vscode.LanguageModelChatInformation,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        info?: LiteLLMModelInfo,
        caller?: string
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

suite("Shared provider overflow budgets (#159)", () => {
    for (const Provider of [LiteLLMChatProvider, LiteLLMCommitMessageProvider]) {
        test(`${Provider.name} preserves hard-budget retry and charges tools/output once`, async () => {
            const sandbox = sinon.createSandbox();
            const source = new vscode.CancellationTokenSource();
            try {
                const provider = new Provider(createMockSecrets(), "test");
                const access = provider as unknown as RetryAccess;
                sandbox.stub(access, "getCallTimeConfiguration").resolves({});
                const build = sandbox
                    .stub(access, "buildOpenAIChatRequest")
                    .resolves({ model: "m", messages: [{ role: "user", content: "recent" }], max_tokens: 400 });
                const send = sandbox.stub(access, "sendRequestToLiteLLM");
                send.onFirstCall().rejects(new Error("context length exceeded"));
                send.onSecondCall().resolves(new ReadableStream());
                const message = (text: string): vscode.LanguageModelChatRequestMessage => ({
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart(text)],
                });
                const model = Object.freeze({
                    id: "m",
                    maxInputTokens: 1000,
                    maxOutputTokens: 400,
                }) as vscode.LanguageModelChatInformation;
                const info = Object.freeze({ max_input_tokens: 1000, context_window_tokens: 1000 });
                const tools = [{ name: "read", description: "d".repeat(300), inputSchema: {} }];
                // Messages 420 + tools 96 fit 600; duplicate tool charging
                // leaves only 408, incorrectly dropping the older message.
                const history = [message("a".repeat(1120)), message("b".repeat(350))];
                await access.sendOnceWithOverflow(
                    { model: "m", messages: [], max_tokens: 400 },
                    history,
                    model,
                    {
                        tools,
                        modelOptions: { max_tokens: 100 },
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    { report: () => {} },
                    source.token,
                    "test",
                    info
                );
                assert.strictEqual(build.firstCall.args[0].length, 2);
                assert.strictEqual((build.firstCall.args[2].modelOptions as Record<string, unknown>).max_tokens, 400);
                assert.strictEqual(model.maxInputTokens, 1000);
                assert.strictEqual(info.context_window_tokens, 1000);
                sinon.assert.calledTwice(send);
                send.resetHistory();
                send.onFirstCall().rejects(new Error("context length exceeded"));
                send.onSecondCall().resolves(new ReadableStream());
                build.resetHistory();
                await access.sendOnceWithOverflow(
                    { model: "m", messages: [], max_tokens: 400 },
                    [message("a".repeat(2100)), message("b".repeat(350))],
                    model,
                    {
                        tools: [],
                        modelOptions: { max_tokens: 100 },
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    { report: () => {} },
                    source.token,
                    "test",
                    info
                );
                assert.strictEqual(build.firstCall.args[0].length, 1);
            } finally {
                source.dispose();
                sandbox.restore();
            }
        });
    }
});
