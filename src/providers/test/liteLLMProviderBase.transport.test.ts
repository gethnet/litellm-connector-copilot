import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { Transport } from "../base/transport";
import { ConfigManager } from "../../config/configManager";

suite("Transport", () => {
    let sandbox: sinon.SinonSandbox;
    let configManager: sinon.SinonStubbedInstance<ConfigManager>;
    let transport: Transport;

    setup(() => {
        sandbox = sinon.createSandbox();
        configManager = sandbox.createStubInstance(ConfigManager);
        transport = new Transport({
            configManager,
            userAgent: "ua",
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
        });
    });

    teardown(() => sandbox.restore());

    test("sendRequestWithRetry retries once on overflow", async () => {
        const token = new vscode.CancellationTokenSource().token;
        const progress = { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>;
        const overflow = new Error("context length exceeded");

        const sendStub = sandbox.stub(transport, "sendRequestToLiteLLM");
        sendStub.onCall(0).rejects(overflow);
        sendStub.onCall(1).resolves(new ReadableStream());

        const stream = await transport.sendRequestWithRetry({
            request: { model: "m", messages: [], stream: true, max_tokens: 100 },
            messages: [],
            model: { id: "m", maxInputTokens: 10, maxOutputTokens: 5 } as vscode.LanguageModelChatInformation,
            options: { modelOptions: {} } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            progress,
            token,
            caller: "test",
            modelInfo: { mode: "chat", max_input_tokens: 10 },
        });

        sinon.assert.match(stream, sinon.match.instanceOf(ReadableStream));
        sinon.assert.calledTwice(sendStub);
        sinon.assert.match(sendStub.secondCall.args[0].max_tokens, 5);
    });

    test("sendRequestToLiteLLM throws when no baseUrl in call-time configuration", async () => {
        const token = new vscode.CancellationTokenSource().token;
        const progress = { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>;
        const factoryCalls: { url: string; key?: string }[] = [];
        const factory = (backend: { url: string; key?: string }): sinon.SinonStub => {
            factoryCalls.push(backend);
            return sandbox.stub() as unknown as sinon.SinonStub;
        };
        const localTransport = new Transport({
            configManager,
            userAgent: "ua",
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
            liteLLMClientFactory: factory as never,
        });

        await assert.rejects(
            () =>
                localTransport.sendRequestToLiteLLM(
                    { model: "m", messages: [], stream: true, max_tokens: 100 },
                    progress,
                    token
                ),
            /No baseUrl/
        );
        assert.strictEqual(factoryCalls.length, 0, "factory must not be called when configuration is missing");
    });

    test("sendRequestToLiteLLM throws when apiKey is missing", async () => {
        const token = new vscode.CancellationTokenSource().token;
        const progress = { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>;
        const localTransport = new Transport({
            configManager,
            userAgent: "ua",
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
        });

        await assert.rejects(
            () =>
                localTransport.sendRequestToLiteLLM(
                    { model: "m", messages: [], stream: true, max_tokens: 100 },
                    progress,
                    token,
                    "test",
                    undefined,
                    { baseUrl: "https://example.com", apiKey: "" }
                ),
            /No apiKey/
        );
    });

    test("sendRequestToLiteLLM constructs a client with the call-time configuration", async () => {
        const token = new vscode.CancellationTokenSource().token;
        const progress = { report: () => {} } as vscode.Progress<vscode.LanguageModelResponsePart>;
        const factoryCalls: { url: string; key?: string }[] = [];
        const localTransport = new Transport({
            configManager,
            userAgent: "ua",
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} },
            liteLLMClientFactory: ((backend: { url: string; key?: string }) => {
                factoryCalls.push(backend);
                return { chat: () => new ReadableStream() } as never;
            }) as never,
        });

        const stream = await localTransport.sendRequestToLiteLLM(
            { model: "m", messages: [], stream: true, max_tokens: 100 },
            progress,
            token,
            "test",
            undefined,
            { baseUrl: "https://wolfram.example", apiKey: "sk-test" }
        );
        assert.ok(stream);
        assert.strictEqual(factoryCalls.length, 1);
        assert.strictEqual(factoryCalls[0].url, "https://wolfram.example");
        assert.strictEqual(factoryCalls[0].key, "sk-test");
    });
});
