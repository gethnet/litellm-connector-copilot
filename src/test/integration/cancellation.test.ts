import * as assert from "assert";
import * as vscode from "vscode";
import { LiteLLMClient } from "../../adapters/litellmClient";

suite("LiteLLM Client Cancellation Tests", () => {
    const config = { url: "http://localhost:1234", key: "test-key" };
    const client = new LiteLLMClient(config, "test-ua");

    test("chat should be aborted when token is cancelled during fetch", async () => {
        const cts = new vscode.CancellationTokenSource();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const request = { model: "test", messages: [], stream: true } as any;

        // Mock fetch to delay then check signal
        const originalFetch = global.fetch;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).fetch = async (url: string, init: RequestInit) => {
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
                init.signal?.addEventListener("abort", () => {
                    clearTimeout(timeout);
                    reject(new DOMException("Aborted", "AbortError"));
                });
            });
        };

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

        // Mock fetch to fail once with 500
        let callCount = 0;
        const originalFetch = global.fetch;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (global as any).fetch = async () => {
            callCount++;
            return new Response("Error", { status: 500 });
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const clientAny = client as any;
        // Use a small delay for test reliability
        const retryPromise = clientAny.fetchWithRetry(
            "http://url",
            {},
            { retries: 2, delayMs: 1000, token: cts.token }
        );

        // Wait a bit for the first failure then cancel during sleep
        await new Promise((r) => setTimeout(r, 100));
        cts.cancel();

        try {
            await retryPromise;
            assert.fail("Should have thrown cancellation error");
        } catch (err: unknown) {
            if (err instanceof Error) {
                assert.strictEqual(err.message, "Operation cancelled by user");
            } else {
                assert.fail("Error should be an instance of Error");
            }
            assert.strictEqual(callCount, 1, "Should not have retried after cancellation");
        } finally {
            global.fetch = originalFetch;
        }
    });
});
