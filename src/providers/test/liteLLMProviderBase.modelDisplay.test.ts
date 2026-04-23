import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";

import { LiteLLMChatProvider } from "../";
import { MultiBackendClient } from "../../adapters/multiBackendClient";

suite("LiteLLM model display", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("uses backend:model as the user-facing `name` when models are namespaced", async () => {
        const mockSecrets: vscode.SecretStorage = {
            get: async () => undefined,
            store: async () => {},
            delete: async () => {},
            onDidChange: (_listener: unknown) => ({ dispose() {} }),
        } as unknown as vscode.SecretStorage;

        const provider = new LiteLLMChatProvider(mockSecrets, "test-agent");
        const token = new vscode.CancellationTokenSource().token;

        // Stub MultiBackendClient.prototype.getModelInfoAll to return test data
        sandbox.stub(MultiBackendClient.prototype, "getModelInfoAll").resolves({
            data: [
                {
                    backendName: "cloud",
                    namespacedId: "cloud/gpt-4o",
                    model_name: "gpt-4o",
                    model_info: {
                        key: "cloud/gpt-4o",
                        litellm_provider: "openai",
                        mode: "responses",
                        rawContextWindow: 8192,
                        maxOutputTokens: 4096,
                    },
                },
            ],
        });

        // Stub config manager to return a backend
        const configManager = (provider as unknown as { _configManager: { resolveBackends: () => Promise<unknown> } })
            ._configManager;
        sandbox
            .stub(configManager, "resolveBackends")
            .resolves([{ name: "cloud", url: "http://example", enabled: true }]);

        const models = await (
            provider as unknown as {
                _doDiscoverModels: (
                    options: { silent: boolean },
                    t: vscode.CancellationToken
                ) => Promise<vscode.LanguageModelChatInformation[]>;
            }
        )._doDiscoverModels({ silent: true }, token);

        assert.strictEqual(models.length, 1);
        assert.strictEqual(models[0].id, "cloud/gpt-4o");
        assert.strictEqual(models[0].name, "Open AI:GPT 4o");
    });
});
