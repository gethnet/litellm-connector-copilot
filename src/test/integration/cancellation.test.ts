import * as assert from "assert";
import * as vscode from "vscode";
import { LiteLLMClient } from "../../adapters/litellmClient";
import type { OpenAIChatCompletionRequest } from "../../types";

suite("LiteLLM Client Cancellation Tests", () => {
    const config = { url: "http://localhost:1234", key: "test-key" };
    const client = new LiteLLMClient(config, "test-ua");

    test("chat should be aborted when token is cancelled during fetch", async () => {
        const cts = new vscode.CancellationTokenSource();
        const request: OpenAIChatCompletionRequest = { model: "test", messages: [], stream: true };

        // Mock fetch to delay then check signal
        const originalFetch = global.fetch;
        (global as typeof globalThis).fetch = (async (url: string | URL | Request, init?: RequestInit) => {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    resolve(
                        new Response(
                            new ReadableStream({
                                start(controller) {
                                    controller.close();
                                },
                            })
                        )
                    );
                }, 100);
                if (init?.signal) {
                    init.signal.addEventListener("abort", () => {
                        clearTimeout(timeout);
                        reject(new DOMException("Aborted", "AbortError"));
                    });
                }
            });
        }) as typeof fetch;

        try {
            const chatPromise = client.chat(request, "chat", cts.token);
            cts.cancel();
            await chatPromise;
            assert.fail("Should have thrown cancellation error");
        } catch (err: unknown) {
            if (err instanceof Error) {
                assert.strictEqual(err.message, "Operation cancelled by user");
            } else {
                assert.fail("Error should be an instance of Error");
            }
        } finally {
            global.fetch = originalFetch;
        }
    });

    test("fetchWithRetry should respect cancellation during sleep", async () => {
        const cts = new vscode.CancellationTokenSource();

        // Track calls to ensure early exit
        let callCount = 0;
        const originalFetch = global.fetch;
        (global as typeof globalThis).fetch = (async () => {
            callCount++;
            // Simulate a working fetch
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;

        const clientAny = client as unknown as {
            fetchWithRetry: (
                url: string,
                init: RequestInit,
                opts: { retries: number; delayMs: number; token: vscode.CancellationToken }
            ) => Promise<Response>;
        };

        try {
            // Test 1: Verify normal behavior works (immediate success)
            const response = await clientAny.fetchWithRetry(
                "http://url",
                {},
                { retries: 2, delayMs: 100, token: cts.token }
            );
            assert.strictEqual(response.status, 200);
            assert.strictEqual(callCount, 1, "Should succeed immediately");

            // Reset counter
            callCount = 0;

            // Test 2: Cancel the token and verify immediate error
            cts.cancel();
            const retryPromise = clientAny.fetchWithRetry(
                "http://url",
                {},
                { retries: 2, delayMs: 100, token: cts.token }
            );

            try {
                await retryPromise;
                assert.fail("Should have thrown cancellation error");
            } catch (err: unknown) {
                if (!(err instanceof Error)) {
                    assert.fail("Error should be an instance of Error");
                }
                assert.strictEqual(err.message, "Operation cancelled by user");
                // Should not have called fetch when already cancelled
                assert.strictEqual(callCount, 0, "Should not call fetch when token is already cancelled");
            }
        } finally {
            global.fetch = originalFetch;
        }
    });
});
