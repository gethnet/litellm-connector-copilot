import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { createReasoningScope, RESPONSES_REASONING_METADATA } from "../../../adapters/reasoningContinuity";
import { countOpenAIChatMessagesTokens, countTokens, trimMessagesToFitBudget } from "../../../adapters/tokenUtils";
import { ConfigManager } from "../../../config/configManager";
import { createMockSecrets } from "../../../test/utils/testMocks";
import type { LiteLLMModelInfo, ResponsesReasoningItem } from "../../../types";
import { convertMessages } from "../../../utils";
import { RequestBuilder } from "../requestBuilder";
import type { RequestBuilderDeps } from "../types";

/** The trimmer and the final transport guard must charge native summaries identically. */
suite("Native reasoning token budget", () => {
    const model = {
        id: "openai/gpt-5.4",
        maxInputTokens: 1000,
        maxOutputTokens: 100,
    } as vscode.LanguageModelChatInformation;
    const scope = createReasoningScope(model.id, "https://proxy.example", undefined, "session")!;
    const item: ResponsesReasoningItem = {
        type: "reasoning",
        id: "rs_native_budget",
        summary: [{ type: "summary_text", text: "Summary that must consume the input budget." }],
        encrypted_content: "x".repeat(5000),
    };

    function text(role: vscode.LanguageModelChatMessageRole, value: string): vscode.LanguageModelChatRequestMessage {
        return { role, name: undefined, content: [new vscode.LanguageModelTextPart(value)] };
    }

    /** Hosts may keep display deltas separate or merge them into the metadata carrier. */
    function assistant(value: string | string[] = "", withDelta = false, reasoning = item) {
        const carrier = {
            id: reasoning.id,
            value,
            metadata: { [RESPONSES_REASONING_METADATA]: { version: 1, source: scope, item: reasoning } },
        } as vscode.LanguageModelThinkingPart;
        const delta = { id: reasoning.id, value: "Display delta ".repeat(20) } as vscode.LanguageModelThinkingPart;
        return {
            role: vscode.LanguageModelChatMessageRole.Assistant,
            name: undefined,
            content: [...(withDelta ? [delta] : []), carrier, new vscode.LanguageModelTextPart("Answer")],
        } as vscode.LanguageModelChatRequestMessage;
    }

    const transportTokens = (messages: readonly vscode.LanguageModelChatRequestMessage[]) =>
        countOpenAIChatMessagesTokens(
            convertMessages(messages, { nativeResponses: true, reasoningScope: scope }),
            model.id
        );

    test("every host representation counts the summary once and never the ciphertext", () => {
        const expected = countTokens(item.summary[0].text, model.id) + countTokens("Answer", model.id);
        for (const message of [assistant(), assistant("", true), assistant("Merged text"), assistant(["A", "B"])]) {
            assert.strictEqual(countTokens([message], model.id), expected);
            assert.strictEqual(transportTokens([message]), expected);
        }
    });

    test("trimming drops a native summary that the final guard would otherwise reject", () => {
        const system = text(3 as vscode.LanguageModelChatMessageRole, "System");
        const latest = text(vscode.LanguageModelChatMessageRole.User, "Next");
        const messages = [system, assistant(), latest];
        const budget = countTokens([system, latest], model.id) + countTokens("Answer", model.id);
        const trimmed = trimMessagesToFitBudget(messages, undefined, model, undefined, budget);
        assert.deepStrictEqual(trimmed, [system, latest]);
        assert.ok(transportTokens(trimmed) <= budget);
    });

    suite("request builder", () => {
        const options = { toolMode: vscode.LanguageModelChatToolMode.Auto, requestInitiator: "test" };
        let sandbox: sinon.SinonSandbox;

        setup(() => {
            sandbox = sinon.createSandbox();
        });

        teardown(() => sandbox.restore());

        function builder(resolveReasoningScope?: RequestBuilderDeps["resolveReasoningScope"]): RequestBuilder {
            const configManager = new ConfigManager(createMockSecrets());
            sandbox.stub(configManager, "getConfig").resolves({});
            return new RequestBuilder({
                configManager,
                getReasoningEffort: () => undefined,
                detectQuotaToolRedaction: (_messages, tools) => ({ tools, confidence: "none" }),
                stripUnsupportedParametersFromRequest: () => {},
                isParameterSupported: () => false,
                getTelemetryOptions: () => ({}),
                usageOptOutModels: new Set(),
                extractRawModelName: () => model.id,
                resolveReasoningScope,
            });
        }

        test("routes that will not replay drop native history before trimming, including emptied messages", async () => {
            const large = { ...item, summary: [{ type: "summary_text" as const, text: "x".repeat(35000) }] };
            const initial = assistant("", true, large);
            const reasoningOnly = { ...initial, content: initial.content.slice(0, -1) };
            const messages = [
                text(vscode.LanguageModelChatMessageRole.User, "earlier"),
                reasoningOnly,
                initial,
                text(vscode.LanguageModelChatMessageRole.User, "continue"),
            ];
            // chat route, explicit false, unknown capability, third-party OpenAI-compatible bridge
            for (const info of [
                { mode: "chat", supports_reasoning: true },
                { mode: "responses", supports_reasoning: false },
                { mode: "responses" },
                { mode: "responses", provider: "openai", key: "qwen3", supports_reasoning: true },
            ]) {
                const request = await builder().buildOpenAIChatRequest(messages, model, options, info);
                assert.deepStrictEqual(request.messages, [
                    { role: "user", content: "earlier" },
                    { role: "assistant", content: "Answer" },
                    { role: "user", content: "continue" },
                ]);
            }
        });

        test("request context resolves even an absent scope once and survives rebuild without reclassification", async () => {
            const resolveScope = sandbox.stub().resolves(undefined);
            const instance = builder(resolveScope);
            const messages = [text(vscode.LanguageModelChatMessageRole.User, "continue")];
            const info: LiteLLMModelInfo = { mode: "responses", supports_reasoning: true };
            const request = await instance.buildOpenAIChatRequest(messages, model, options, info);
            assert.deepStrictEqual(request.reasoningContext, { policy: "native", scope: undefined });
            const rebuilt = await instance.buildOpenAIChatRequest(
                messages,
                model,
                options,
                { ...info, supports_reasoning: false },
                undefined,
                request.reasoningContext
            );
            assert.strictEqual(rebuilt.reasoningContext, request.reasoningContext);
            sinon.assert.calledOnce(resolveScope);
        });
    });
});
