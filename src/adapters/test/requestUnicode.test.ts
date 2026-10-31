import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { LiteLLMClient } from "../litellmClient";
import { RequestBuilder } from "../../providers/base/requestBuilder";
import { ConfigManager } from "../../config/configManager";
import { StructuredLogger } from "../../observability/structuredLogger";
import { convertMessages } from "../../utils";
import * as tokenUtils from "../tokenUtils";
import type { LiteLLMConfig, LiteLLMModelInfo, OpenAIChatCompletionRequest } from "../../types";

suite("Request Unicode transport (#175)", () => {
    let sandbox: sinon.SinonSandbox;
    setup(() => {
        sandbox = sinon.createSandbox();
    });
    teardown(() => sandbox.restore());

    const client = () => new LiteLLMClient({ url: "http://localhost:4000", key: "test" }, "test");
    const decoded = (fetchStub: sinon.SinonStub, index: number): Record<string, unknown> => {
        const init = fetchStub.getCall(index).args[1] as RequestInit | undefined;
        return JSON.parse(String(init?.body)) as Record<string, unknown>;
    };
    const user = (text: string): vscode.LanguageModelChatRequestMessage => ({
        role: vscode.LanguageModelChatMessageRole.User,
        content: [new vscode.LanguageModelTextPart(text)],
        name: undefined,
    });

    for (const mode of ["chat", "responses"]) {
        test(`${mode} repairs text and tool results without changing valid arguments or IDs, including retry`, async () => {
            const fetchStub = sandbox.stub(global, "fetch");
            fetchStub.onFirstCall().resolves(new Response("Unsupported parameter: temperature", { status: 400 }));
            fetchStub.onSecondCall().resolves(new Response("data: [DONE]\n\n"));
            const warn = sandbox.stub(StructuredLogger, "warn");
            const originalText = "pair 🔧 high \ud83d low \udd27 literal \\udd27";
            const call = new vscode.LanguageModelToolCallPart("call-1", "read", {
                query: "tool 🔧 \\udd27",
            });
            const messages = convertMessages([
                user(originalText),
                { role: vscode.LanguageModelChatMessageRole.Assistant, content: [call], name: undefined },
                {
                    role: vscode.LanguageModelChatMessageRole.User,
                    content: [
                        new vscode.LanguageModelToolResultPart("call-1", [
                            new vscode.LanguageModelTextPart("result \ud83d"),
                        ]),
                    ],
                    name: undefined,
                },
            ]);
            const request: OpenAIChatCompletionRequest = {
                model: "test-model",
                messages,
                temperature: 1,
                stop: ["stop\ud83d"],
            };
            const original = JSON.stringify(request);
            await client().chat(request, mode);
            assert.strictEqual(fetchStub.callCount, 2);
            assert.strictEqual(JSON.stringify(request), original, "caller object must not be mutated");
            for (const index of [0, 1]) {
                const body = decoded(fetchStub, index);
                if (mode === "chat") {
                    const sent = body.messages as OpenAIChatCompletionRequest["messages"];
                    assert.strictEqual(sent[0].content, "pair 🔧 high � low � literal \\udd27");
                    assert.strictEqual(sent[1].tool_calls?.[0].id, messages[1].tool_calls?.[0].id);
                    assert.deepStrictEqual(JSON.parse(sent[1].tool_calls?.[0].function.arguments ?? ""), {
                        query: "tool 🔧 \\udd27",
                    });
                    assert.strictEqual(sent[2].content, "result �");
                    assert.deepStrictEqual(body.stop, ["stop�"]);
                } else {
                    const sent = body.input as Record<string, unknown>[];
                    assert.strictEqual(sent[0].content, "pair 🔧 high � low � literal \\udd27");
                    assert.strictEqual(sent[1].call_id, messages[1].tool_calls?.[0].id);
                    assert.deepStrictEqual(JSON.parse(String(sent[1].arguments)), { query: "tool 🔧 \\udd27" });
                    assert.strictEqual(sent[2].output, "result �");
                    assert.strictEqual(body.stop, undefined);
                }
            }
            assert.strictEqual(warn.getCalls().filter((c) => c.args[0] === "request.unicode_repaired").length, 1);
            assert.deepStrictEqual(warn.getCalls().find((c) => c.args[0] === "request.unicode_repaired")?.args, [
                "request.unicode_repaired",
                { stringCount: 3 },
            ]);
            assert.ok(!JSON.stringify(warn.getCalls().map((c) => c.args)).includes("pair 🔧"));
        });

        test(`${mode} keeps valid signed reasoning and rejects malformed signed text or opaque state`, async () => {
            const fetchStub = sandbox.stub(global, "fetch").resolves(new Response("data: [DONE]\n\n"));
            const signed: OpenAIChatCompletionRequest = {
                model: "chatgpt/gpt-6.1-sol",
                messages: [
                    {
                        role: "assistant",
                        thinking_blocks: [
                            { type: "thinking", thinking: "thought 🔧", signature: "opaque", id: "rs_original_123" },
                        ],
                    },
                ],
            };
            const info: LiteLLMModelInfo = { provider: "chatgpt", key: "gpt-6.1-sol", supports_reasoning: true };
            await client().chat(signed, mode, undefined, info);
            const first = decoded(fetchStub, 0);
            if (mode === "chat") {
                const sent = first.messages as OpenAIChatCompletionRequest["messages"];
                assert.deepStrictEqual(sent[0].thinking_blocks, signed.messages[0].thinking_blocks);
            } else {
                const sent = first.input as Record<string, unknown>[];
                assert.deepStrictEqual(sent[0], {
                    type: "reasoning",
                    id: "rs_original_123",
                    summary: [{ type: "summary_text", text: "thought 🔧" }],
                    encrypted_content: "opaque",
                });
            }
            for (const block of [
                { type: "thinking" as const, thinking: "bad\ud83d", signature: "opaque" },
                { type: "thinking" as const, thinking: "thought", signature: "bad\udd27" },
                { type: "redacted_thinking" as const, data: "bad\udd27" },
            ]) {
                await assert.rejects(
                    () =>
                        client().chat(
                            { model: "test-model", messages: [{ role: "assistant", thinking_blocks: [block] }] },
                            mode
                        ),
                    /invalid UTF-16.*Start a new chat/i
                );
            }
            assert.strictEqual(fetchStub.callCount, 1);
        });

        test(`${mode} preserves argument bytes and rejects malformed nested arguments`, async () => {
            const fetchStub = sandbox.stub(global, "fetch").resolves(new Response("data: [DONE]\n\n"));
            const make = (args: string): OpenAIChatCompletionRequest => ({
                model: "test-model",
                messages: [
                    {
                        role: "assistant",
                        tool_calls: [
                            { id: "call_example", type: "function", function: { name: "read", arguments: args } },
                        ],
                    },
                ],
            });
            const valid = String.raw`{ "literal": "\\ud800", "pair": "\ud83d\udd27" }`;
            await client().chat(make(valid), mode);
            const body = decoded(fetchStub, 0);
            if (mode === "chat") {
                const sent = body.messages as OpenAIChatCompletionRequest["messages"];
                assert.strictEqual(sent[0].tool_calls?.[0].function.arguments, valid);
            } else {
                const sent = body.input as Record<string, unknown>[];
                assert.strictEqual(sent[0].arguments, valid);
            }
            for (const invalid of [
                JSON.stringify({ content: "bad\ud800" }),
                JSON.stringify({ ["bad\udc00"]: "x" }),
                String.raw`{"input":"\ud800"}`,
            ]) {
                await assert.rejects(() => client().chat(make(invalid), mode), /tool arguments.*retry/i);
            }
            assert.strictEqual(fetchStub.callCount, 1);
        });
    }

    test("rejects malformed protocol IDs, argument keys, opaque values and unparseable arguments before fetch", async () => {
        const fetchStub = sandbox.stub(global, "fetch");
        const make = (id: string, args: string): OpenAIChatCompletionRequest => ({
            model: "test-model",
            messages: [
                {
                    role: "assistant",
                    tool_calls: [{ id, type: "function", function: { name: "read", arguments: args } }],
                },
            ],
        });
        for (const request of [
            make("id\ud83d", "{}"),
            make("id", JSON.stringify({ "key\udd27": "value" })),
            make("id", JSON.stringify({ content: "bad\ud83d" })),
            make("id", JSON.stringify({ nested: [{ input: "bad\udd27" }] })),
            make("id", "{bad\udd27"),
        ]) {
            await assert.rejects(() => client().chat(request), /invalid UTF-16.*Start a new chat/i);
        }
        assert.strictEqual(fetchStub.callCount, 0);
    });

    test("token counter repairs prompt and rejects malformed model before fetch", async () => {
        const fetchStub = sandbox.stub(global, "fetch").resolves(new Response('{"token_count":1}'));
        await client().countTokens({ model: "m", prompt: "a\ud83d 🔧 \\udd27" });
        assert.strictEqual(decoded(fetchStub, 0).prompt, "a� 🔧 \\udd27");
        await assert.rejects(() => client().countTokens({ model: "m\udd27", prompt: "ok" }), /invalid UTF-16/i);
        assert.strictEqual(fetchStub.callCount, 1);
    });

    test("builder budgets the repaired wire message and does not mutate host text", async () => {
        const config = sandbox.createStubInstance(ConfigManager);
        const configValue: LiteLLMConfig = {};
        config.getConfig.resolves(configValue);
        const count = sandbox.spy(tokenUtils, "countOpenAIChatMessagesTokens");
        const builder = new RequestBuilder({
            configManager: config,
            getReasoningEffort: () => undefined,
            detectQuotaToolRedaction: (_messages, tools) => ({ tools, confidence: "none" }),
            stripUnsupportedParametersFromRequest: () => {},
            isParameterSupported: () => true,
            getTelemetryOptions: () => ({}),
            usageOptOutModels: new Set(),
            extractRawModelName: (id) => id,
        });
        const input = user("a\ud83d");
        const model = { id: "m", maxInputTokens: 1000, maxOutputTokens: 100 } as vscode.LanguageModelChatInformation;
        const options = {
            modelOptions: { max_tokens: 20 },
            tools: [],
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions;
        const request = await builder.buildOpenAIChatRequest([input], model, options, { max_input_tokens: 1000 });
        assert.strictEqual(request.messages[0].content, "a�");
        assert.strictEqual((input.content[0] as vscode.LanguageModelTextPart).value, "a\ud83d");
        assert.strictEqual(count.callCount, 1);
        assert.strictEqual(count.firstCall.args[0][0].content, "a�");
        assert.ok(tokenUtils.countOpenAIChatMessagesTokens(request.messages, "m") <= 950);
    });
});
