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
            getDiscoveredModelBackend: () => undefined,
            getTransportModelId: (id) => id,
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
});
