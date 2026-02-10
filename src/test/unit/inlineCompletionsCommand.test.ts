import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";

import { registerSelectInlineCompletionModelCommand } from "../../commands/inlineCompletions";
import type { LiteLLMChatProvider } from "../../providers";
import { LiteLLMTelemetry } from "../../utils/telemetry";

suite("InlineCompletions Command Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("registerSelectInlineCompletionModelCommand registers the command", () => {
        const registerStub = sandbox.stub(vscode.commands, "registerCommand");
        const provider = { getLastKnownModels: () => [] } as unknown as LiteLLMChatProvider;

        registerSelectInlineCompletionModelCommand(provider);

        assert.strictEqual(registerStub.calledWith("litellm-connector.inlineCompletions.selectModel"), true);
    });

    test("handler reports failure when no models available", async () => {
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        const infoStub = sandbox.stub(vscode.window, "showInformationMessage");

        const provider = {
            getLastKnownModels: () => [],
            provideLanguageModelChatInformation: sandbox.stub().resolves([]),
        } as unknown as LiteLLMChatProvider;

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.inlineCompletions.selectModel") {
                handler = cb as () => Promise<void>;
            }
            return { dispose() {} } as vscode.Disposable;
        });

        registerSelectInlineCompletionModelCommand(provider);
        await handler?.();

        assert.strictEqual(infoStub.calledOnce, true);
        assert.strictEqual(
            metricStub.calledWithMatch(
                sinon.match({
                    status: "failure",
                    error: "no_models",
                    caller: "inline-completions.selectModel",
                })
            ),
            true
        );
    });

    test("handler reports cancelled when picker dismissed", async () => {
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");
        sandbox.stub(vscode.window, "showQuickPick").resolves(undefined);

        const provider = {
            getLastKnownModels: () => [
                {
                    id: "m1",
                    name: "m1",
                    tooltip: "t",
                },
            ],
        } as unknown as LiteLLMChatProvider;

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.inlineCompletions.selectModel") {
                handler = cb as () => Promise<void>;
            }
            return { dispose() {} } as vscode.Disposable;
        });

        registerSelectInlineCompletionModelCommand(provider);
        await handler?.();

        assert.strictEqual(
            metricStub.calledWithMatch(
                sinon.match({
                    status: "failure",
                    error: "cancelled",
                    caller: "inline-completions.selectModel.cancelled",
                })
            ),
            true
        );
    });

    test("handler updates configuration when model is selected", async () => {
        const updateStub = sandbox.stub().resolves();
        sandbox.stub(vscode.workspace, "getConfiguration").returns({ update: updateStub } as never);
        sandbox.stub(vscode.window, "showQuickPick").resolves({ label: "m2" } as never);
        sandbox.stub(vscode.window, "showInformationMessage");
        const metricStub = sandbox.stub(LiteLLMTelemetry, "reportMetric");

        const provider = {
            getLastKnownModels: () => [
                {
                    id: "m2",
                    name: "m2",
                    tooltip: "t",
                },
            ],
        } as unknown as LiteLLMChatProvider;

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.inlineCompletions.selectModel") {
                handler = cb as () => Promise<void>;
            }
            return { dispose() {} } as vscode.Disposable;
        });

        registerSelectInlineCompletionModelCommand(provider);
        await handler?.();

        assert.strictEqual(
            updateStub.calledWith(
                "litellm-connector.inlineCompletions.modelId",
                "m2",
                vscode.ConfigurationTarget.Global
            ),
            true
        );
        assert.strictEqual(
            metricStub.calledWithMatch(
                sinon.match({
                    status: "success",
                    model: "m2",
                    caller: "inline-completions.selectModel.selected",
                })
            ),
            true
        );
    });
});
