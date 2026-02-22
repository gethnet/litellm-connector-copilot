import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { ResponsesClient } from "../responsesClient";
import type { LiteLLMConfig, LiteLLMResponsesRequest } from "../../types";
import { Logger } from "../../utils/logger";

const encoder = new TextEncoder();

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

    function makeProgress() {
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

    function normalizeHeaders(headers?: HeaderLike) {
        if (!headers) {
            return {} as Record<string, string>;
        }
        if (headers instanceof Headers) {
            return Object.fromEntries(headers.entries());
        }
        if (Array.isArray(headers)) {
            return Object.fromEntries(headers);
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

    test("throws on non-OK response", async () => {
        const client = makeClient();
        fetchStub.resolves(new Response("bad", { status: 500, statusText: "Server" }));
        const { progress } = makeProgress();

        await assert.rejects(
            () => client.sendResponsesRequest(makeRequest(), progress, new vscode.CancellationTokenSource().token),
            (err: Error) => err.message.includes("500 Server") && err.message.includes("bad")
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
            'data: {"type":"response.output_item.delta","item":{"type":"function_call","call_id":"c1","name":"tool","arguments":"{\\"x\\":1}"}}\n',
            'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"c1"}}\n\n',
            "data: [DONE]\n\n",
        ];
        fetchStub.resolves(new Response(readableFromStrings(sse), { status: 200 }));
        const { progress, reported } = makeProgress();

        await client.sendResponsesRequest(makeRequest(), progress, new vscode.CancellationTokenSource().token);

        assert.strictEqual(reported.length, 3);
        assert.ok(reported[0] instanceof vscode.LanguageModelTextPart);
        assert.strictEqual((reported[0] as vscode.LanguageModelTextPart).value, "Hello");
        assert.ok(reported[1] instanceof vscode.LanguageModelTextPart);
        assert.strictEqual((reported[1] as vscode.LanguageModelTextPart).value, "*Think*");
        assert.ok(reported[2] instanceof vscode.LanguageModelToolCallPart);
        const toolCall = reported[2] as vscode.LanguageModelToolCallPart;
        assert.strictEqual(toolCall.callId, "c1");
        assert.strictEqual(toolCall.name, "tool");
        assert.deepStrictEqual(toolCall.input, { x: 1 });
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
});
