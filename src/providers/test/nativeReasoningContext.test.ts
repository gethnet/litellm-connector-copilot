import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { LiteLLMChatProvider } from "../liteLLMChatProvider";
import { ConfigManager } from "../../config/configManager";
import { RESPONSES_REASONING_METADATA } from "../../adapters/reasoningContinuity";
import { createMockSecrets } from "../../test/utils/testMocks";
import type { LiteLLMResponsesRequest } from "../../types";

/**
 * Discovery capability → real builder/client → stream capture → next-turn wire replay.
 * Unsupported/unknown capability is covered at unit level (client and builder tests).
 */
suite("Native reasoning request context", () => {
    test("confirmed reasoning capability enables include, capture and replay end to end for a private alias", async () => {
        const sandbox = sinon.createSandbox();
        const source = new vscode.CancellationTokenSource();
        const provider = new LiteLLMChatProvider(createMockSecrets(), "test");
        const configuration = { baseUrl: "https://proxy.example", apiKey: "ACCOUNT_A" };
        const requests: LiteLLMResponsesRequest[] = [];
        const item = { type: "reasoning", id: "rs_original", summary: [], encrypted_content: "OPAQUE_STATE" };
        sandbox.stub(ConfigManager.prototype, "getConfig").resolves({});
        sandbox.stub(globalThis, "fetch").callsFake(async (input, init) => {
            if (String(input).endsWith("/model/info")) {
                return new Response(
                    JSON.stringify({
                        data: [
                            {
                                model_name: "private-alias",
                                litellm_params: { custom_llm_provider: "chatgpt" },
                                model_info: {
                                    mode: "responses",
                                    supports_reasoning: true,
                                    max_input_tokens: 4096,
                                    max_output_tokens: 256,
                                },
                            },
                        ],
                    })
                );
            }
            assert.strictEqual(String(input), "https://proxy.example/responses");
            requests.push(JSON.parse(String(init?.body)) as LiteLLMResponsesRequest);
            const events = [
                { type: "response.output_item.done", item },
                { type: "response.output_text.delta", delta: "Answer" },
                { type: "response.completed", response: { status: "completed" } },
            ];
            return new Response(
                events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"
            );
        });
        try {
            const [model] = await provider.provideLanguageModelChatInformation(
                { silent: true, configuration, groupName: "Team" } as vscode.PrepareLanguageModelChatModelOptions,
                source.token
            );
            assert.ok(model, "discovery must return the alias without a model-name allowlist");
            const options = {
                configuration,
                toolMode: vscode.LanguageModelChatToolMode.Auto,
                requestInitiator: "test",
            };
            const history: vscode.LanguageModelChatRequestMessage[] = [
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    name: undefined,
                    content: [new vscode.LanguageModelTextPart("Continue")],
                },
            ];
            const reported: vscode.LanguageModelResponsePart[] = [];
            await provider.provideLanguageModelChatResponse(
                model,
                history,
                options,
                { report: (part) => reported.push(part) },
                source.token
            );
            const envelopes = reported.flatMap((part) => {
                const metadata = (part as { metadata?: Record<string, unknown> }).metadata;
                return metadata?.[RESPONSES_REASONING_METADATA] ? [metadata[RESPONSES_REASONING_METADATA]] : [];
            });
            assert.strictEqual(envelopes.length, 1);
            history.push({
                role: vscode.LanguageModelChatMessageRole.Assistant,
                name: undefined,
                content: reported,
            });
            history.push({
                role: vscode.LanguageModelChatMessageRole.User,
                name: undefined,
                content: [new vscode.LanguageModelTextPart("Next")],
            });
            await provider.provideLanguageModelChatResponse(
                model,
                history,
                options,
                { report: () => {} },
                source.token
            );
            assert.strictEqual(requests.length, 2);
            for (const request of requests) {
                assert.deepStrictEqual(request.include, ["reasoning.encrypted_content"]);
                assert.ok(!("reasoningContext" in request));
                assert.ok(!JSON.stringify(request).includes("ACCOUNT_A"));
            }
            assert.deepStrictEqual(
                requests[1].input.filter((entry) => entry.type === "reasoning"),
                [item]
            );
        } finally {
            source.dispose();
            (provider as unknown as { _registry: { dispose(): void } })._registry.dispose();
            sandbox.restore();
        }
    });
});
