import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { createReasoningScope, RESPONSES_REASONING_METADATA } from "../../../adapters/reasoningContinuity";
import { countOpenAIChatMessagesTokens, countTokens, trimMessagesToFitBudget } from "../../../adapters/tokenUtils";
import { ConfigManager } from "../../../config/configManager";
import { createMockSecrets } from "../../../test/utils/testMocks";
import type { ResponsesReasoningItem } from "../../../types";
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

    test("chat routes omit native-only history before trimming so it cannot cause a false overflow", async () => {
        const sandbox = sinon.createSandbox();
        const configManager = new ConfigManager(createMockSecrets());
        sandbox.stub(configManager, "getConfig").resolves({});
        const deps: RequestBuilderDeps = {
            configManager,
            getReasoningEffort: () => undefined,
            detectQuotaToolRedaction: (_messages, tools) => ({ tools, confidence: "none" }),
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: () => false,
            getTelemetryOptions: () => ({}),
            usageOptOutModels: new Set(),
            extractRawModelName: () => model.id,
        };
        const large = { ...item, summary: [{ type: "summary_text" as const, text: "x".repeat(35000) }] };
        const messages = [assistant("", true, large), text(vscode.LanguageModelChatMessageRole.User, "continue")];
        try {
            const request = await new RequestBuilder(deps).buildOpenAIChatRequest(
                messages,
                model,
                { toolMode: vscode.LanguageModelChatToolMode.Auto, requestInitiator: "test" },
                { mode: "chat", provider: "openai" },
                undefined,
                scope
            );
            assert.deepStrictEqual(request.messages, [
                { role: "assistant", content: "Answer" },
                { role: "user", content: "continue" },
            ]);
        } finally {
            sandbox.restore();
        }
    });
});
