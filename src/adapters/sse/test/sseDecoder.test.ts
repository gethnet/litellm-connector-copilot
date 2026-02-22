import * as assert from "assert";
import * as vscode from "vscode";
import { decodeSSE } from "../sseDecoder";

suite("SSE Decoder Unit Tests", () => {
    test("decodes simple data frames", async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"text": "hello"}\n\ndata: {"text": "world"}\n\n'));
                controller.close();
            },
        });

        const results: string[] = [];
        for await (const payload of decodeSSE(stream)) {
            results.push(payload);
        }

        assert.deepStrictEqual(results, ['{"text": "hello"}', '{"text": "world"}']);
    });

    test("handles partial chunks and multi-line frames", async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"text": "hel'));
                controller.enqueue(new TextEncoder().encode('lo"}\n\ndata: [DONE]\n\n'));
                controller.close();
            },
        });

        const results: string[] = [];
        for await (const payload of decodeSSE(stream)) {
            results.push(payload);
        }

        assert.deepStrictEqual(results, ['{"text": "hello"}']);
    });

    test("respects cancellation token", async () => {
        const cts = new vscode.CancellationTokenSource();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
                // We don't close yet
            },
        });

        const generator = decodeSSE(stream, cts.token);
        const first = await generator.next();
        assert.strictEqual(first.value, "1");

        cts.cancel();
        const second = await generator.next();
        assert.strictEqual(second.done, true);
    });

    test("ignores non-data lines", async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(": ping\n\nevent: message\ndata: content\n\n"));
                controller.close();
            },
        });

        const results: string[] = [];
        for await (const payload of decodeSSE(stream)) {
            results.push(payload);
        }

        assert.deepStrictEqual(results, ["content"]);
    });
});
