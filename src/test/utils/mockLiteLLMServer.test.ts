import * as assert from "assert";
import * as http from "http";
import { MockLiteLLMServer, createDefaultMockConfig, type MockServerConfig } from "./mockLiteLLMServer";

/**
 * Tests for MockLiteLLMServer
 *
 * TDD Tests written FIRST - these define the expected behavior before implementation.
 * Each test validates a specific capability of the mock server.
 */
suite("MockLiteLLMServer", () => {
    let server: MockLiteLLMServer;
    const testPort = 49998;

    teardown(async () => {
        if (server && server.isRunning) {
            await server.stop();
        }
    });

    suite("Lifecycle Management", () => {
        test("should start and stop successfully", async () => {
            const config: MockServerConfig = { port: testPort };
            server = new MockLiteLLMServer(config);

            assert.strictEqual(server.isRunning, false);
            await server.start();
            assert.strictEqual(server.isRunning, true);

            await server.stop();
            assert.strictEqual(server.isRunning, false);
        });

        test("should emit start event when started", async () => {
            const config: MockServerConfig = { port: testPort };
            server = new MockLiteLLMServer(config);

            const startPromise = new Promise<void>((resolve) => {
                server.on("start", () => resolve());
            });

            await server.start();
            await startPromise;
            await server.stop();
        });

        test("should emit stop event when stopped", async () => {
            const config: MockServerConfig = { port: testPort };
            server = new MockLiteLLMServer(config);
            await server.start();

            const stopPromise = new Promise<void>((resolve) => {
                server.on("stop", () => resolve());
            });

            await server.stop();
            await stopPromise;
        });

        test("should be constructable with createDefaultMockConfig", () => {
            const config = createDefaultMockConfig(testPort);
            server = new MockLiteLLMServer(config);
            assert.ok(server instanceof MockLiteLLMServer);
        });
    });

    suite("Request Logging", () => {
        test("should log requests to /v1/models", async () => {
            const config: MockServerConfig = { port: testPort };
            server = new MockLiteLLMServer(config);
            await server.start();

            await makeHttpRequest(`http://localhost:${testPort}/v1/models`, "GET");

            const requests = server.getRequests();
            assert.strictEqual(requests.length, 1);
            assert.strictEqual(requests[0].method, "GET");
            assert.strictEqual(requests[0].path, "/v1/models");
        });

        test("should log requests to /v1/chat/completions", async () => {
            const config: MockServerConfig = { port: testPort };
            server = new MockLiteLLMServer(config);
            await server.start();

            const body = JSON.stringify({ model: "gpt-4o", messages: [] });
            await makeHttpRequest(`http://localhost:${testPort}/v1/chat/completions`, "POST", body);

            const requests = server.getRequests();
            assert.strictEqual(requests.length, 1);
            assert.strictEqual(requests[0].method, "POST");
            assert.strictEqual(requests[0].path, "/v1/chat/completions");
            assert.ok(requests[0].body?.includes("gpt-4o"));
        });

        test("should clear request log", async () => {
            const config: MockServerConfig = { port: testPort };
            server = new MockLiteLLMServer(config);
            await server.start();

            await makeHttpRequest(`http://localhost:${testPort}/v1/models`, "GET");
            assert.strictEqual(server.getRequests().length, 1);

            server.clearRequests();
            assert.strictEqual(server.getRequests().length, 0);
        });
    });

    suite("Response Configuration", () => {
        test("should return default model list", async () => {
            const config: MockServerConfig = { port: testPort };
            server = new MockLiteLLMServer(config);
            await server.start();

            const response = await makeHttpRequest(`http://localhost:${testPort}/v1/models`, "GET");
            const data = JSON.parse(response) as { data: { id: string }[] };
            assert.ok(Array.isArray(data.data));
            assert.ok(data.data.length > 0);
        });

        test("should return custom model list", async () => {
            const config: MockServerConfig = {
                port: testPort,
                modelList: {
                    data: [{ id: "custom-model", object: "model", created: 1234567890, model: "custom-model" }],
                },
            };
            server = new MockLiteLLMServer(config);
            await server.start();

            const response = await makeHttpRequest(`http://localhost:${testPort}/v1/models`, "GET");
            const data = JSON.parse(response) as { data: { id: string }[] };
            assert.strictEqual(data.data.length, 1);
            assert.strictEqual(data.data[0].id, "custom-model");
        });

        test("should return chat completion response", async () => {
            const config: MockServerConfig = { port: testPort };
            server = new MockLiteLLMServer(config);
            await server.start();

            const body = JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "test" }] });
            const response = await makeHttpRequest(`http://localhost:${testPort}/v1/chat/completions`, "POST", body);
            const data = JSON.parse(response) as { choices: { message: { content: string } }[] };
            assert.ok(data.choices);
            assert.ok(data.choices[0].message.content);
        });

        test("should return error when configured", async () => {
            const config: MockServerConfig = {
                port: testPort,
                responses: {
                    chat: {
                        error: { status: 429, body: { error: "Rate limit exceeded" } },
                    },
                },
            };
            server = new MockLiteLLMServer(config);
            await server.start();

            try {
                await makeHttpRequest(`http://localhost:${testPort}/v1/chat/completions`, "POST", "{}");
                assert.fail("Expected error to be thrown");
            } catch (err) {
                assert.ok((err as Error).message.includes("429"));
            }
        });
    });

    suite("Streaming Support", () => {
        test("should handle streaming chat completions", async () => {
            const config: MockServerConfig = { port: testPort };
            server = new MockLiteLLMServer(config);
            await server.start();

            const body = JSON.stringify({ model: "gpt-4o", messages: [], stream: true });
            const response = await makeHttpRequest(`http://localhost:${testPort}/v1/chat/completions`, "POST", body);
            assert.ok(response.includes("data:"));
            assert.ok(response.includes("[DONE]"));
        });

        test("should handle streaming completions", async () => {
            const config: MockServerConfig = { port: testPort };
            server = new MockLiteLLMServer(config);
            await server.start();

            const body = JSON.stringify({ model: "gpt-4o", prompt: "test", stream: true });
            const response = await makeHttpRequest(`http://localhost:${testPort}/v1/completions`, "POST", body);
            assert.ok(response.includes("data:"));
            assert.ok(response.includes("[DONE]"));
        });

        test("should handle streaming /responses", async () => {
            const config: MockServerConfig = { port: testPort };
            server = new MockLiteLLMServer(config);
            await server.start();

            const body = JSON.stringify({ model: "gpt-4o", stream: true });
            const response = await makeHttpRequest(`http://localhost:${testPort}/responses`, "POST", body);
            assert.ok(response.includes("data:"));
        });
    });

    suite("Error Handling", () => {
        test("should return 404 for unknown paths", async () => {
            const config: MockServerConfig = { port: testPort };
            server = new MockLiteLLMServer(config);
            await server.start();

            try {
                await makeHttpRequest(`http://localhost:${testPort}/unknown`, "GET");
                assert.fail("Expected error to be thrown");
            } catch (err) {
                assert.ok((err as Error).message.includes("404"));
            }
        });

        test("should handle CORS preflight requests", async () => {
            const config: MockServerConfig = { port: testPort };
            server = new MockLiteLLMServer(config);
            await server.start();

            // Options request should not throw
            const response = await makeHttpRequest(`http://localhost:${testPort}/v1/models`, "OPTIONS");
            assert.strictEqual(response, "");
        });
    });

    suite("Latency Simulation", () => {
        test("should simulate latency when configured", async () => {
            const config: MockServerConfig = {
                port: testPort,
                responses: {
                    chat: {
                        latency: 100,
                    },
                },
            };
            server = new MockLiteLLMServer(config);
            await server.start();

            const start = Date.now();
            await makeHttpRequest(`http://localhost:${testPort}/v1/chat/completions`, "POST", "{}");
            const duration = Date.now() - start;
            assert.ok(duration >= 90, `Expected latency >= 90ms, got ${duration}ms`);
        });
    });

    suite("Default Config Helper", () => {
        test("createDefaultMockConfig returns valid config", () => {
            const config = createDefaultMockConfig(testPort);
            assert.strictEqual(config.port, testPort);
            assert.ok(config.modelList);
            assert.ok(Array.isArray(config.modelList?.data));
            assert.ok(config.modelList!.data.length > 0);
        });

        test("createDefaultMockConfig uses default port when not specified", () => {
            const config = createDefaultMockConfig();
            assert.strictEqual(config.port, 49999);
        });
    });
});

/**
 * Helper function to make HTTP requests in tests.
 */
function makeHttpRequest(url: string, method: string, body?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options: http.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname,
            method,
            headers: body ? { "Content-Type": "application/json" } : undefined,
        };

        const req = http.request(options, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                } else {
                    resolve(data);
                }
            });
        });

        req.on("error", reject);
        req.setTimeout(5000, () => {
            req.destroy();
            reject(new Error("Request timeout"));
        });

        if (body) {
            req.write(body);
        }
        req.end();
    });
}
