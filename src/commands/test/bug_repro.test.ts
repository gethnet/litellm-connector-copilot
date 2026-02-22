import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { registerShowModelsCommand } from "../manageConfig";
import type { LiteLLMChatProvider } from "../../providers/liteLLMChatProvider";

suite("Regression: Model ID Copy Bug", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("showModels: quick pick copies full model id including provider prefix", async () => {
        const fullModelId = "vertex/gemini-3-flash-preview";
        const provider = {
            getLastKnownModels: () => [
                {
                    id: fullModelId,
                    name: "gemini-3-flash-preview",
                    tooltip: "LiteLLM (chat)",
                    family: "litellm",
                    version: "1.0.0",
                    maxInputTokens: 1,
                    maxOutputTokens: 1,
                    capabilities: { toolCalling: true, imageInput: false },
                    tags: [],
                },
            ],
        } as unknown as LiteLLMChatProvider;

        // Stub showQuickPick to return the item with the full ID
        const qpStub = sandbox.stub(vscode.window, "showQuickPick").resolves({
            label: fullModelId,
        } as vscode.QuickPickItem);

        const clipStub = sandbox.stub();
        sandbox.stub(vscode.env, "clipboard").value({ writeText: clipStub } as unknown as vscode.Clipboard);
        sandbox.stub(vscode.window, "showInformationMessage");

        let handler: (() => Promise<void>) | undefined;
        sandbox.stub(vscode.commands, "registerCommand").callsFake((id, cb) => {
            if (id === "litellm-connector.showModels") {
                handler = cb as () => Promise<void>;
            }
            return { dispose: () => {} } as vscode.Disposable;
        });

        registerShowModelsCommand(provider);

        if (!handler) {
            throw new Error("Command handler not registered");
        }

        await handler();

        assert.strictEqual(qpStub.calledOnce, true);
        // This is where it would fail if the bug was in the command itself
        assert.strictEqual(
            clipStub.calledWith(fullModelId),
            true,
            `Expected to copy ${fullModelId} but copied something else`
        );
    });
});
