import * as vscode from "vscode";
import * as sinon from "sinon";
import { RequestBuilder } from "../base/requestBuilder";
import { ConfigManager } from "../../config/configManager";
import type { LiteLLMModelInfo } from "../../types";

suite("RequestBuilder", () => {
    let sandbox: sinon.SinonSandbox;
    let configManager: sinon.SinonStubbedInstance<ConfigManager>;
    let builder: RequestBuilder;

    setup(() => {
        sandbox = sinon.createSandbox();
        configManager = sandbox.createStubInstance(ConfigManager);
        builder = new RequestBuilder({
            configManager,
            getReasoningEffort: () => undefined,
            detectQuotaToolRedaction: (messages, tools) => ({ tools, confidence: "none" as const }),
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: () => true,
            getTelemetryOptions: () => ({ caller: "test", justification: undefined, modelConfiguration: {} }),
            usageOptOutModels: new Set(),
            extractRawModelName: (id: string) => {
                // Test mirror of `LiteLLMProviderRegistry.extractRawName`:
                // strip everything up to and including the first `/`.
                const slash = id.indexOf("/");
                return slash < 0 ? id : id.slice(slash + 1);
            },
        });
    });

    teardown(() => sandbox.restore());

    test("buildOpenAIChatRequest caps max_tokens to model maxOutputTokens", async () => {
        configManager.getConfig.resolves({});
        const model = { id: "gpt-x", maxInputTokens: 100, maxOutputTokens: 50 } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        const req = await builder.buildOpenAIChatRequest(
            messages,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            undefined,
            "caller"
        );
        sinon.assert.match(req.max_tokens, 50);
        sinon.assert.match(req.stream, true);
    });

    test("buildV2ChatRequest preserves tool_choice", async () => {
        configManager.getConfig.resolves({});
        const model = { id: "gpt-v2", maxInputTokens: 100, maxOutputTokens: 20 } as vscode.LanguageModelChatInformation;
        const messages = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];
        const modelInfo = { mode: "chat" } as LiteLLMModelInfo;

        const req = await builder.buildV2ChatRequest(
            messages as never,
            model,
            {
                modelOptions: {},
                toolMode: vscode.LanguageModelChatToolMode.Required,
                tools: [{ name: "test_tool", description: "desc", inputSchema: {} }],
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            modelInfo,
            "caller"
        );

        sinon.assert.match(req.tool_choice, {
            type: "function",
            function: { name: "test_tool" },
        });
    });
});
