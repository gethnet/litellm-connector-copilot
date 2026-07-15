import * as vscode from "vscode";
import * as sinon from "sinon";
import * as assert from "assert";
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

    test("buildOpenAIChatRequest serializes an explicitly selected none effort", async () => {
        configManager.getConfig.resolves({});
        const noneBuilder = new RequestBuilder({
            configManager,
            getReasoningEffort: () => "none",
            detectQuotaToolRedaction: (messages, tools) => ({ tools, confidence: "none" as const }),
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: (param: string) => param === "reasoning_effort",
            getTelemetryOptions: () => ({ caller: "test", justification: undefined, modelConfiguration: {} }),
            usageOptOutModels: new Set(),
            extractRawModelName: (id: string) => id,
        });
        const model = { id: "gpt-5", maxInputTokens: 100, maxOutputTokens: 50 } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        const request = await noneBuilder.buildOpenAIChatRequest(
            messages,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            { supported_openai_params: ["reasoning_effort"] },
            "test"
        );

        assert.strictEqual(request.reasoning_effort, "none");
    });

    test("buildV2ChatRequest omits none when reasoning_effort is unsupported", async () => {
        configManager.getConfig.resolves({});
        const noneBuilder = new RequestBuilder({
            configManager,
            getReasoningEffort: () => "none",
            detectQuotaToolRedaction: (messages, tools) => ({ tools, confidence: "none" as const }),
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: (param: string) => param !== "reasoning_effort",
            getTelemetryOptions: () => ({ caller: "test", justification: undefined, modelConfiguration: {} }),
            usageOptOutModels: new Set(),
            extractRawModelName: (id: string) => id,
        });
        const model = { id: "gpt-5", maxInputTokens: 100, maxOutputTokens: 50 } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("hi")],
                name: undefined,
            },
        ];

        const request = await noneBuilder.buildV2ChatRequest(
            messages as never,
            model,
            { modelOptions: {} } as vscode.ProvideLanguageModelChatResponseOptions,
            { supported_openai_params: ["stream"] },
            "test"
        );

        assert.strictEqual(request.reasoning_effort, undefined);
    });

    test("buildOpenAIChatRequest omits tool_choice when not supported by model", async () => {
        // Create a builder where isParameterSupported returns false for tool_choice
        const builderWithGating = new RequestBuilder({
            configManager,
            getReasoningEffort: () => undefined,
            detectQuotaToolRedaction: (messages, tools) => ({ tools, confidence: "none" as const }),
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: (param: string) => param !== "tool_choice", // tool_choice not supported
            getTelemetryOptions: () => ({ caller: "test", justification: undefined, modelConfiguration: {} }),
            usageOptOutModels: new Set(),
            extractRawModelName: (id: string) => {
                const slash = id.indexOf("/");
                return slash < 0 ? id : id.slice(slash + 1);
            },
        });

        configManager.getConfig.resolves({});
        const model = {
            id: "azure/gpt-5.6",
            maxInputTokens: 100000,
            maxOutputTokens: 4096,
        } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("test")],
                name: undefined,
            },
        ];
        const modelInfo = { model: "gpt-5.6", supported_openai_params: ["tools"] } as LiteLLMModelInfo;

        const req = await builderWithGating.buildOpenAIChatRequest(
            messages,
            model,
            {
                tools: [{ name: "tool1", description: "test", inputSchema: {} }],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                modelOptions: {},
                requestInitiator: "test",
            } as vscode.ProvideLanguageModelChatResponseOptions,
            modelInfo,
            "test"
        );

        // tool_choice should be undefined when not supported by model
        assert.strictEqual(req.tool_choice, undefined);
    });

    test("buildOpenAIChatRequest adds tool_choice: auto when supported and tools present", async () => {
        configManager.getConfig.resolves({});
        const model = {
            id: "openai/gpt-4",
            maxInputTokens: 100000,
            maxOutputTokens: 4096,
        } as vscode.LanguageModelChatInformation;
        const messages: vscode.LanguageModelChatRequestMessage[] = [
            {
                role: vscode.LanguageModelChatMessageRole.User,
                content: [new vscode.LanguageModelTextPart("test")],
                name: undefined,
            },
        ];
        const modelInfo = { model: "gpt-4", supported_openai_params: ["tools", "tool_choice"] } as LiteLLMModelInfo;

        const req = await builder.buildOpenAIChatRequest(
            messages,
            model,
            {
                tools: [{ name: "tool1", description: "test", inputSchema: {} }],
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                modelOptions: {},
                requestInitiator: "test",
            } as vscode.ProvideLanguageModelChatResponseOptions,
            modelInfo,
            "test"
        );

        // tool_choice should be "auto" when model supports it and tools are present
        assert.strictEqual(req.tool_choice, "auto");
    });
});
