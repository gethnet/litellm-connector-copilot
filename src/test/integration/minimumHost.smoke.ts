import * as assert from "assert";
import { readFileSync } from "fs";
import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";
import { LiteLLMChatProvider } from "../../providers";
import { createMockSecrets } from "../utils/testMocks";

suite("Minimum VS Code host smoke", () => {
    test("runs on the requested host and activates the installed extension", async () => {
        const expectedVersion = process.env.VSCODE_TEST_VERSION;
        assert.ok(expectedVersion, "VSCODE_TEST_VERSION must specify the host under test");
        assert.strictEqual(vscode.version, expectedVersion, "the executable must match the requested version");
        const manifest = JSON.parse(readFileSync(path.resolve(__dirname, "../../../../package.json"), "utf8")) as {
            engines: { vscode: string };
        };
        assert.strictEqual(
            manifest.engines.vscode,
            `^${expectedVersion}`,
            "update the test host when the declared floor changes"
        );

        const extension = vscode.extensions.getExtension("GethNet.litellm-connector-copilot");
        assert.ok(extension, "VS Code must discover the extension under development");
        await extension.activate();
        assert.strictEqual(extension.isActive, true, "VS Code must successfully activate the extension");

        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes("litellm-connector.reloadModels"), "activation must register the reload command");
        await vscode.commands.executeCommand("litellm-connector.reloadModels");
    });

    test("discovers a model and streams a response using minimum-host API objects", async () => {
        const server = http.createServer((request, response) => {
            if (request.url === "/model/info") {
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(
                    JSON.stringify({
                        data: [
                            {
                                model_name: "smoke-model",
                                model_info: {
                                    mode: "chat",
                                    max_input_tokens: 8192,
                                    max_output_tokens: 1024,
                                },
                            },
                        ],
                    })
                );
            } else if (request.url === "/chat/completions" && request.method === "POST") {
                response.writeHead(200, { "Content-Type": "text/event-stream" });
                response.end(
                    'data: {"choices":[{"delta":{"content":"hello from proxy"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
                );
            } else {
                response.writeHead(404);
                response.end();
            }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const configuration = { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test-key" };
        const provider = new LiteLLMChatProvider(createMockSecrets(), "minimum-host-smoke");
        const tokenSource = new vscode.CancellationTokenSource();
        try {
            // This invokes the real provider in the host, but does not configure
            // a VS Code-managed model group or exercise host picker routing.
            const models = await provider.provideLanguageModelChatInformation(
                { silent: true, configuration } as vscode.PrepareLanguageModelChatModelOptions,
                tokenSource.token
            );
            assert.strictEqual(models.length, 1);
            assert.strictEqual((models[0] as unknown as { isUserSelectable?: boolean }).isUserSelectable, true);
            const parts: vscode.LanguageModelResponsePart[] = [];
            await provider.provideLanguageModelChatResponse(
                models[0],
                [new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, "Hello")],
                { modelOptions: {}, configuration } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { report: (part) => parts.push(part) },
                tokenSource.token
            );
            assert.ok(
                parts.some(
                    (part) => part instanceof vscode.LanguageModelTextPart && part.value.includes("hello from proxy")
                )
            );
        } finally {
            tokenSource.dispose();
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        }
    });
});
