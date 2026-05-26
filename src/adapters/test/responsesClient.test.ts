import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { ResponsesClient } from "../responsesClient";
import type { LiteLLMConfig, LiteLLMResponsesRequest } from "../../types";
import { Logger } from "../../utils/logger";

const encoder = new TextEncoder();

/*eslint no-useless-escape: "off"*/

suite("ResponsesClient sendResponsesRequest", () => {
    const config: LiteLLMConfig = { url: "http://localhost:4000", key: "test-key" };
    const userAgent = "test-ua";
    let fetchStub: sinon.SinonStub;

    function makeRequest(): LiteLLMResponsesRequest {
        return { model: "m", input: [{ type: "message", role: "user", content: "hi" }] };
    }

    function makeClient() {
        return new ResponsesClient(config, userAgent);
    }

    function makeProgress(): {
        progress: vscode.Progress<vscode.LanguageModelResponsePart>;
        reported: vscode.LanguageModelResponsePart[];
    } {
        const reported: vscode.LanguageModelResponsePart[] = [];
        const progress: vscode.Progress<vscode.LanguageModelResponsePart> = {
            report: (part) => reported.push(part),
        };
        return { progress, reported };
    }

    type HeaderLike =
        | Headers
        | Record<string, string>
        | Record<string, string | readonly string[]>
        | [string, string][]
        | string[][];

    function normalizeHeaders(headers?: HeaderLike): Record<string, string> {
        if (!headers) {
            return {};
        }
        if (headers instanceof Headers) {
            return Object.fromEntries(headers.entries());
        }
        if (Array.isArray(headers)) {
            return Object.fromEntries(headers as [string, string][]);
        }
        const normalized: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) {
            normalized[k] = Array.isArray(v) ? v.join(";") : String(v);
        }
        return normalized;
    }

    function readableFromStrings(chunks: string[]) {
        return new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
            },
        });
    }

    setup(() => {
        fetchStub = sinon.stub(global, "fetch");
    });

    teardown(() => {
        sinon.restore();
    });

    test("sets headers with api key", async () => {
        const client = makeClient();
        const body: LiteLLMResponsesRequest = makeRequest();
        fetchStub.resolves(new Response(readableFromStrings([""]), { status: 200 }));

        const { progress } = makeProgress();
        await client.sendResponsesRequest(body, progress, new vscode.CancellationTokenSource().token);

        assert.ok(fetchStub.calledOnce);
        const [url, init] = fetchStub.firstCall.args as [string, RequestInit];
        const headers = normalizeHeaders(init?.headers);
        assert.strictEqual(url, `${config.url}/responses`);
        assert.strictEqual(init?.method, "POST");
        assert.strictEqual(headers["Content-Type"], "application/json");
        assert.strictEqual(headers["User-Agent"], userAgent);
        assert.strictEqual(headers.Authorization, `Bearer ${config.key}`);
        assert.strictEqual(headers["X-API-Key"], config.key);
    });

    test("sets Cache-Control: no-cache when disableCaching is true and model is not Anthropic", async () => {
        const cachingConfig: LiteLLMConfig = { ...config, disableCaching: true };
        const client = new ResponsesClient(cachingConfig, userAgent);
        const body: LiteLLMResponsesRequest = { model: "gpt-4", input: [] };
        fetchStub.resolves(new Response(readableFromStrings([""]), { status: 200 }));

        const { progress } = makeProgress();
        await client.sendResponsesRequest(body, progress, new vscode.CancellationTokenSource().token);

        const [, init] = fetchStub.firstCall.args as [string, RequestInit];
        const headers = normalizeHeaders(init?.headers);
        assert.strictEqual(headers["Cache-Control"], "no-cache");
    });

    test("does not set Cache-Control: no-cache for Anthropic models even if disableCaching is true", async () => {
        const cachingConfig: LiteLLMConfig = { ...config, disableCaching: true };
        const client = new ResponsesClient(cachingConfig, userAgent);
        const body: LiteLLMResponsesRequest = { model: "claude-3-opus", input: [] };
        fetchStub.resolves(new Response(readableFromStrings([""]), { status: 200 }));

        const { progress } = makeProgress();
        await client.sendResponsesRequest(body, progress, new vscode.CancellationTokenSource().token);

        const [, init] = fetchStub.firstCall.args as [string, RequestInit];
        const headers = normalizeHeaders(init?.headers);
        assert.strictEqual(headers["Cache-Control"], undefined);
    });

    test("throws on non-OK response", async () => {
        const client = makeClient();
        fetchStub.resolves(new Response("bad", { status: 500, statusText: "Server" }));
        const { progress } = makeProgress();

        await assert.rejects(
            () => client.sendResponsesRequest(makeRequest(), progress, new vscode.CancellationTokenSource().token),
            (err: Error) => err instanceof Error && err.message.includes("500 Server") && err.message.includes("bad")
        );
    });

    test("throws when response body missing", async () => {
        const client = makeClient();
        const resp = new Response("ok", { status: 200 });
        Object.defineProperty(resp, "body", { value: null });
        fetchStub.resolves(resp);
        const { progress } = makeProgress();

        await assert.rejects(
            () => client.sendResponsesRequest(makeRequest(), progress, new vscode.CancellationTokenSource().token),
            (err: Error) => err.message.includes("No response body")
        );
    });

    test("parses SSE chunks and ignores DONE", async () => {
        const client = makeClient();
        const sse = [
            'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
            'data: {"type":"response.output_reasoning.delta","delta":"Think"}\n\n',
            'data: {"type":"response.output_item.delta","item":{"type":"function_call","call_id":"c1","name":"tool","arguments":"{\\"x\\":1}"}}\n\n',
            'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"c1"}}\n\n',
            "data: [DONE]\n\n",
        ];
        fetchStub.resolves(new Response(readableFromStrings(sse), { status: 200 }));
        const { progress, reported } = makeProgress();

        await client.sendResponsesRequest(makeRequest(), progress, new vscode.CancellationTokenSource().token);

        assert.strictEqual(reported.length, 3);
        assert.ok(reported[0] instanceof vscode.LanguageModelTextPart);
        assert.strictEqual((reported[0] as vscode.LanguageModelTextPart).value, "Hello");
        const second = reported[1];
        const ThinkingCtor = (vscode as unknown as Record<string, unknown>).LanguageModelThinkingPart as
            | (new (
                  value: string | string[],
                  id?: string,
                  metadata?: Record<string, unknown>
              ) => vscode.LanguageModelResponsePart)
            | undefined;
        if (ThinkingCtor) {
            assert.ok(second instanceof ThinkingCtor || second instanceof vscode.LanguageModelTextPart);
        } else {
            assert.ok(second instanceof vscode.LanguageModelTextPart);
            assert.strictEqual((second as vscode.LanguageModelTextPart).value, "*Think*");
        }
        assert.ok(reported[2] instanceof vscode.LanguageModelToolCallPart);
        const toolCall = reported[2] as vscode.LanguageModelToolCallPart;
        assert.strictEqual(toolCall.callId, "c1");
        assert.strictEqual(toolCall.name, "tool");
        assert.deepStrictEqual(toolCall.input, { x: 1 });
    });

    test("usage data part is handled by StreamTokenCapture (not emitted by ResponsesClient directly)", async () => {
        // Note: Usage data is now handled by StreamTokenCapture in the chat provider
        // ResponsesClient no longer emits usage data directly
        // This test verifies the stream processes without error
        const client = makeClient();
        const sse = [
            'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":4,"input_token_details":{"cached_tokens":5},"output_token_details":{"reasoning_tokens":2}}}}\n\n',
            "data: [DONE]\n\n",
        ];
        fetchStub.resolves(new Response(readableFromStrings(sse), { status: 200 }));
        const { progress, reported } = makeProgress();

        await client.sendResponsesRequest(makeRequest(), progress, new vscode.CancellationTokenSource().token);

        // Verify text was emitted
        const textParts = reported.filter((p) => p instanceof vscode.LanguageModelTextPart);
        assert.ok(textParts.length > 0, "Expected text parts to be emitted");
        assert.strictEqual((textParts[0] as vscode.LanguageModelTextPart).value, "Hello");
    });

    test("usage data parsing is handled by StreamTokenCapture (not ResponsesClient directly)", async () => {
        // Note: Usage data is now handled by StreamTokenCapture in the chat provider
        // ResponsesClient no longer emits usage data directly
        // This test verifies the stream processes without error
        const client = makeClient();
        const encoder = new TextEncoder();

        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"hi"}\n\n'));
                controller.enqueue(
                    encoder.encode(
                        'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":6,"input_token_details":{"cached_tokens":2},"output_token_details":{"reasoning_tokens":1,"tool_tokens":3},"system_tokens":4}}}' +
                            "\n\n"
                    )
                );
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            },
        });

        const reported: vscode.LanguageModelResponsePart[] = [];
        await (
            client as unknown as { parseSSEStream: (typeof ResponsesClient.prototype)["parseSSEStream"] }
        ).parseSSEStream(
            stream,
            { report: (p: vscode.LanguageModelResponsePart) => reported.push(p) },
            new vscode.CancellationTokenSource().token
        );

        // Verify text was emitted
        const textParts = reported.filter((p) => p instanceof vscode.LanguageModelTextPart);
        assert.ok(textParts.length > 0, "Expected text parts to be emitted");
        assert.strictEqual((textParts[0] as vscode.LanguageModelTextPart).value, "hi");
    });

    test("handles partial lines across chunks", async () => {
        const client = makeClient();
        const chunks = ['data: {"type":"response.output_text.delta","delta":"Hello"}', "\n\ndata: [DONE]\n"];
        fetchStub.resolves(new Response(readableFromStrings(chunks), { status: 200 }));
        const { progress, reported } = makeProgress();

        await client.sendResponsesRequest(makeRequest(), progress, new vscode.CancellationTokenSource().token);

        assert.strictEqual(reported.length, 1);
        assert.strictEqual((reported[0] as vscode.LanguageModelTextPart).value, "Hello");
    });

    test("parses multiline SSE data that contains escaped special characters", async () => {
        const client = makeClient();
        const sse = [
            'data: {"type":"response.output_text.delta",\n',
            'data: "delta":"semi; colon: quote \\\" and backtick `"}\n\n',
            "data: [DONE]\n\n",
        ];
        fetchStub.resolves(new Response(readableFromStrings(sse), { status: 200 }));
        const { progress, reported } = makeProgress();

        await client.sendResponsesRequest(makeRequest(), progress, new vscode.CancellationTokenSource().token);

        assert.strictEqual(reported.length, 1);
        assert.strictEqual((reported[0] as vscode.LanguageModelTextPart).value, 'semi; colon: quote " and backtick `');
    });

    test("stops on cancellation", async () => {
        const client = makeClient();
        const cts = new vscode.CancellationTokenSource();
        const chunks = [
            'data: {"type":"response.output_text.delta","delta":"A"}\n\n',
            'data: {"type":"response.output_text.delta","delta":"B"}\n\n',
        ];
        let enqueued = 0;
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) {
                    enqueued++;
                    controller.enqueue(encoder.encode(chunk));
                    if (enqueued === 1) {
                        setTimeout(() => {
                            cts.cancel();
                            controller.close();
                        }, 0);
                        break;
                    }
                }
            },
        });
        fetchStub.resolves(new Response(stream, { status: 200 }));
        const { progress, reported } = makeProgress();

        await client.sendResponsesRequest(makeRequest(), progress, cts.token);

        assert.strictEqual(reported.length, 1);
        assert.strictEqual((reported[0] as vscode.LanguageModelTextPart).value, "A");
    });

    test("logs parse errors and continues", async () => {
        const client = makeClient();
        const logStub = sinon.stub(Logger, "error");
        const sse = ["data: not-json\n\n", 'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n'];
        fetchStub.resolves(new Response(readableFromStrings(sse), { status: 200 }));
        const { progress, reported } = makeProgress();

        await client.sendResponsesRequest(makeRequest(), progress, new vscode.CancellationTokenSource().token);

        assert.ok(logStub.called);
        assert.strictEqual(reported.length, 1);
        assert.strictEqual((reported[0] as vscode.LanguageModelTextPart).value, "Hi");
    });

    test("handles anonymous tool calls (missing call_id)", async () => {
        const client = makeClient();
        const sse = [
            'data: {"type":"response.output_item.delta","item":{"type":"function_call","name":"tool1","arguments":"{\\"a\\":1}"}}\n\n',
            'data: {"type":"response.output_item.done","item":{"type":"function_call"}}\n\n',
            "data: [DONE]\n\n",
        ];
        fetchStub.resolves(new Response(readableFromStrings(sse), { status: 200 }));
        const { progress, reported } = makeProgress();

        await client.sendResponsesRequest(makeRequest(), progress, new vscode.CancellationTokenSource().token);

        const toolCall = reported.find(
            (p) => p instanceof vscode.LanguageModelToolCallPart
        ) as vscode.LanguageModelToolCallPart;
        assert.ok(toolCall);
        assert.strictEqual(toolCall.callId, "anonymous");
        assert.strictEqual(toolCall.name, "tool1");
    });

    test("handles delta with text or chunk fields", async () => {
        const client = makeClient();
        const sse = [
            'data: {"type":"response.output_text.delta","text":"A"}\n\n',
            'data: {"type":"response.output_text.delta","chunk":"B"}\n\n',
            "data: [DONE]\n\n",
        ];
        fetchStub.resolves(new Response(readableFromStrings(sse), { status: 200 }));
        const { progress, reported } = makeProgress();

        await client.sendResponsesRequest(makeRequest(), progress, new vscode.CancellationTokenSource().token);

        assert.strictEqual(reported.length, 2);
        assert.strictEqual((reported[0] as vscode.LanguageModelTextPart).value, "A");
        assert.strictEqual((reported[1] as vscode.LanguageModelTextPart).value, "B");
    });

    test("StreamTokenCapture handles usage data without throwing", async () => {
        // Note: emitExperimentalUsageData has been removed
        // Usage data is now handled exclusively by StreamTokenCapture
        // This test verifies the stream processes without error when usage data is present
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"hi"}\n\n'));
                controller.enqueue(
                    encoder.encode(
                        'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":6}}}\n\n'
                    )
                );
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            },
        });

        const client = makeClient();
        const reported: vscode.LanguageModelResponsePart[] = [];
        await (
            client as unknown as { parseSSEStream: (typeof ResponsesClient.prototype)["parseSSEStream"] }
        ).parseSSEStream(
            stream,
            { report: (p: vscode.LanguageModelResponsePart) => reported.push(p) },
            new vscode.CancellationTokenSource().token
        );

        // Verify text was emitted
        const textParts = reported.filter((p) => p instanceof vscode.LanguageModelTextPart);
        assert.ok(textParts.length > 0, "Expected text parts to be emitted");
        assert.strictEqual((textParts[0] as vscode.LanguageModelTextPart).value, "hi");
    });
});
