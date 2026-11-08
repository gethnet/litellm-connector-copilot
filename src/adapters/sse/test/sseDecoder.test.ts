import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { decodeSSE } from "../sseDecoder";
import { StructuredLogger } from "../../../observability/structuredLogger";
import { Logger } from "../../../utils/logger";

/*eslint no-useless-escape: "off"*/
suite("SSE Decoder Unit Tests", () => {
    test("normal and final-flush payload logs never expose opaque values", async () => {
        const sandbox = sinon.createSandbox();
        try {
            const structured = sandbox.stub(StructuredLogger, "log");
            const legacy = sandbox.stub(Logger, "trace");
            const values = ['{"signature":"private-signature"}', '{"encrypted_content":"private-ciphertext"}'];
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(`data: ${values[0]}\n\ndata: ${values[1]}`));
                    controller.close();
                },
            });
            const received: string[] = [];
            try {
                for await (const payload of decodeSSE(stream)) {
                    received.push(payload);
                }
            } catch (error) {
                assert.match(String(error), /incomplete data/);
            }
            assert.deepStrictEqual(received, values);
            const payloadLogs = structured.getCalls().filter((call) => call.args[1] === "stream.payload_yielded");
            assert.strictEqual(payloadLogs.length, 2);
            assert.deepStrictEqual(
                payloadLogs.map((call) => (call.args[2] as { payloadLength: number }).payloadLength),
                values.map((value) => value.length)
            );
            const logged = JSON.stringify([
                ...structured.getCalls().map((call) => call.args),
                ...legacy.getCalls().map((call) => call.args),
            ]);
            assert.ok(!logged.includes("private-signature"));
            assert.ok(!logged.includes("private-ciphertext"));
        } finally {
            sandbox.restore();
        }
    });

    test("decodes simple data frames", async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(
                    new TextEncoder().encode('data: {"text": "hello"}\n\ndata: {"text": "world"}\n\ndata: [DONE]\n\n')
                );
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

    test("rejoins multiline data lines within a single event", async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(
                    new TextEncoder().encode(
                        'data: {"type":"response.output_text.delta",\n' +
                            'data: "delta":"semi; colon: quote \\\" and backtick `"}\n\n' +
                            "data: [DONE]\n\n"
                    )
                );
                controller.close();
            },
        });

        const results: string[] = [];
        for await (const payload of decodeSSE(stream)) {
            results.push(payload);
        }

        assert.deepStrictEqual(results, [
            '{"type":"response.output_text.delta",\n"delta":"semi; colon: quote \\\" and backtick `"}',
        ]);
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
                controller.enqueue(
                    new TextEncoder().encode(": ping\n\nevent: message\ndata: content\n\ndata: [DONE]\n\n")
                );
                controller.close();
            },
        });

        const results: string[] = [];
        for await (const payload of decodeSSE(stream)) {
            results.push(payload);
        }

        assert.deepStrictEqual(results, ["content"]);
    });

    test("accepts stream that ends cleanly without [DONE] marker (clean buffer)", async () => {
        // Bug #97 Tier 1: Stream closes with complete payloads but no [DONE] marker.
        // This can happen with long-running requests to Azure AI/Anthropic proxies (63+ seconds).
        // The stream is clean (all payloads received), so we should NOT throw error.
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"text": "hello"}\n\n'));
                controller.enqueue(new TextEncoder().encode('data: {"text": "world"}\n\n'));
                // Intentionally close WITHOUT [DONE] marker, but all payloads are complete
                controller.close();
            },
        });

        const results: string[] = [];
        let threwError = false;

        try {
            for await (const payload of decodeSSE(stream)) {
                results.push(payload);
            }
        } catch (_err) {
            threwError = true;
        }

        // Should NOT throw error for clean stream end (buffer empty)
        assert.strictEqual(threwError, false, "Should NOT throw error when stream ends cleanly (no pending data)");
        // Both payloads should be yielded
        assert.deepStrictEqual(results, ['{"text": "hello"}', '{"text": "world"}']);
    });

    test("throws error when stream closes with incomplete data in buffer (no [DONE])", async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"text": "hello"}\n\n'));
                // Send raw incomplete JSON (no "data:" prefix, won't extract as event)
                controller.enqueue(new TextEncoder().encode('{"incomplete'));
                // Close with truly incomplete data
                controller.close();
            },
        });

        const results: string[] = [];
        let threwError = false;
        let errorMessage = "";

        try {
            for await (const payload of decodeSSE(stream)) {
                results.push(payload);
            }
        } catch (err) {
            threwError = true;
            errorMessage = err instanceof Error ? err.message : String(err);
        }

        assert.strictEqual(
            threwError,
            true,
            "Expected decodeSSE to throw error when incomplete data remains in buffer"
        );
        assert.match(
            errorMessage,
            /Stream ended before \[DONE\] marker/,
            "Error message should indicate missing [DONE] marker"
        );
        // Only the complete payload should be yielded
        assert.deepStrictEqual(results, ['{"text": "hello"}']);
    });

    test("onActivity fires on every raw chunk, including comment-only frames", async () => {
        const activityChunks: number[] = [];
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                // Chunk 1: keep-alive comment frame only — no data: line, never yielded as payload
                controller.enqueue(new TextEncoder().encode(": ping\n\n"));
                // Chunk 2: complete data payload
                controller.enqueue(new TextEncoder().encode('data: {"text": "hello"}\n\n'));
                controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                controller.close();
            },
        });

        const results: string[] = [];
        for await (const payload of decodeSSE(stream, undefined, undefined, (byteLength) => {
            activityChunks.push(byteLength);
        })) {
            results.push(payload);
        }

        // Payload extraction is unaffected by the activity callback
        assert.deepStrictEqual(results, ['{"text": "hello"}']);
        // Activity fired for ALL three chunks — including the comment-only frame that yields nothing
        assert.strictEqual(
            activityChunks.length,
            3,
            "onActivity must fire for every raw chunk, not just payload-bearing chunks"
        );
        // The comment frame chunk (": ping\n\n" = 8 bytes) is reported with its byte length
        assert.strictEqual(activityChunks[0], 8, "comment-only frame must be reported as activity");
    });

    test("onActivity fires for chunks that contain only partial events", async () => {
        const activityChunks: number[] = [];
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                // Fragment 1: partial event, no terminator — buffered, not yielded
                controller.enqueue(new TextEncoder().encode('data: {"text": "hel'));
                // Fragment 2: remainder + terminator — only NOW does a payload get yielded
                controller.enqueue(new TextEncoder().encode('lo"}\n\ndata: [DONE]\n\n'));
                controller.close();
            },
        });

        const results: string[] = [];
        for await (const payload of decodeSSE(stream, undefined, undefined, (byteLength) => {
            activityChunks.push(byteLength);
        })) {
            results.push(payload);
        }

        assert.deepStrictEqual(results, ['{"text": "hello"}']);
        assert.strictEqual(
            activityChunks.length,
            2,
            "onActivity must fire for partial-event chunks even though they yield no payload"
        );
    });
});
