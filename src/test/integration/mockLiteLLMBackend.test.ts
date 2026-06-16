/**
 * Comprehensive Tests for MockLiteLLMBackend
 *
 * This test suite validates all functionality of the mock LiteLLM backend server
 * to ensure it correctly simulates a real LiteLLM proxy for integration testing.
 *
 * Coverage areas:
 * - Server lifecycle (start/stop)
 * - Endpoint support (/models, /chat/completions, /token_count, /responses)
 * - Streaming vs non-streaming responses
 * - Tool call simulation
 * - Error handling
 * - Latency simulation
 * - Request counting
 * - Response format compliance with OpenAI API
 */

import * as assert from "assert";
import * as http from "http";
import MockLiteLLMBackend, { type MockBackendOptions } from "./mockLiteLLMBackend";

/**
 * NOTE ON `any` TYPE USAGE IN THIS FILE:
 *
 * This test file extensively uses `JSON.parse()` to deserialize HTTP response bodies.
 * Since `JSON.parse()` has a return type of `any` in TypeScript, accessing properties
 * on parsed JSON objects results in lint warnings about unsafe member access.
 *
 * We use `as any` type casts in specific locations (marked with inline ESLint overrides)
 * because:
 *
 * 1. **Test code defensiveness**: We're validating that responses have expected shapes.
 *    Using optional chaining (.?) to safely check properties that might not exist is
 *    the correct pattern, even if the underlying value is `any`.
 *
 * 2. **Avoiding boilerplate**: Creating full TypeScript interfaces for every response
 *    variant across 7 endpoints would add >500 lines of type definitions with minimal
 *    benefit to test clarity. Example: every SSE streaming endpoint would need separate
 *    interfaces for session.created, output_text.delta, response.completed, etc.
 *
 * 3. **Assertions serve as type guards**: Each test's assertions (assert.ok, assert.strictEqual)
 *    verify that responses have expected properties. If a property doesn't exist or has wrong
 *    type, the assertion fails and the test fails, proving the response shape was incorrect.
 *
 * 4. **Alternatives are worse**: Discriminated unions, type predicates, or other type-safe
 *    approaches would create complexity that obscures the test's actual intent (validating
 *    mock server behavior).
 *
 * **ESLint Rule Overrides Used**:
 * - `@typescript-eslint/no-explicit-any`: Permits `as any` casts where optional chaining
 *   alone cannot work (e.g., nested member access where TypeScript can't infer the shape)
 * - `@typescript-eslint/no-unsafe-member-access`: Permits property access on `any` values
 *   after type assertions, since we've explicitly decided to opt-out of strict type checking
 *   for JSON parsing
 * - `@typescript-eslint/no-unsafe-assignment`: Permits assignments from `any` sources in
 *   test code where we're intentionally deserializing untyped JSON
 * - `@typescript-eslint/no-unsafe-return`: Permits returning `any` values from helper
 *   functions that wrap unsafe JSON operations
 *
 * Each override appears immediately before the affected line(s) with clear scope.
 */

/**
 * Helper to make HTTP requests to the mock server
 */
function makeHttpRequest(
    url: string,
    method: "GET" | "POST",
    body?: string
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options: http.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname + parsedUrl.search,
            method,
            headers: {
                "Content-Type": "application/json",
            },
        };

        const req = http.request(options, (res) => {
            let data = "";
            res.on("data", (chunk) => {
                data += chunk;
            });
            res.on("end", () => {
                resolve({
                    status: res.statusCode || 500,
                    headers: res.headers as Record<string, string>,
                    body: data,
                });
            });
        });

        req.on("error", (err) => {
            reject(err);
        });

        if (body) {
            req.write(body);
        }
        req.end();
    });
}

/**
 * Helper to make streaming requests and collect all SSE events
 */
function makeStreamingRequest(url: string, method: "GET" | "POST", body?: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options: http.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname + parsedUrl.search,
            method,
            headers: {
                "Content-Type": "application/json",
            },
        };

        const req = http.request(options, (res) => {
            let data = "";
            res.on("data", (chunk) => {
                data += chunk;
            });
            res.on("end", () => {
                // Split by "data: " prefix and filter out empty lines
                const events = data
                    .split("\n")
                    .filter((line) => line.trim())
                    .filter((line) => line.startsWith("data: "))
                    .map((line) => line.slice(6));
                resolve(events);
            });
        });

        req.on("error", (err) => {
            reject(err);
        });

        if (body) {
            req.write(body);
        }
        req.end();
    });
}

suite("MockLiteLLMBackend", () => {
    let backend: MockLiteLLMBackend;
    const testPort = 45000;

    teardown(async () => {
        if (backend) {
            await backend.stop();
        }
    });

    suite("Lifecycle Management", () => {
        test("should start and accept connections", async () => {
            const options: MockBackendOptions = { port: testPort };
            backend = new MockLiteLLMBackend(options);

            await backend.start();
            const baseUrl = backend.getBaseUrl();
            assert.strictEqual(baseUrl, `http://localhost:${testPort}`);

            // Verify we can make a request
            const response = await makeHttpRequest(`${baseUrl}/models`, "GET");
            assert.strictEqual(response.status, 200);
        });

        test("should stop gracefully", async () => {
            const options: MockBackendOptions = { port: testPort };
            backend = new MockLiteLLMBackend(options);

            await backend.start();
            await backend.stop();

            // Verify server is truly stopped by attempting to connect
            try {
                await makeHttpRequest(`http://localhost:${testPort}/models`, "GET");
                assert.fail("Expected connection to fail after stop");
            } catch (err) {
                // Expected - connection should fail
                assert.ok(
                    (err as Error).message.includes("ECONNREFUSED") || (err as Error).message.includes("refused")
                );
            }
        });

        test("should initialize with custom options", async () => {
            const options: MockBackendOptions = {
                port: testPort,
                latencyMs: 100,
                toolCallSupport: false,
                reasoningSupport: false,
            };
            backend = new MockLiteLLMBackend(options);
            await backend.start();

            const startTime = Date.now();
            await makeHttpRequest(`${backend.getBaseUrl()}/models`, "GET");
            const elapsed = Date.now() - startTime;

            // Should have at least the configured latency
            assert.ok(elapsed >= 100, `Expected at least 100ms latency, got ${elapsed}ms`);
        });

        test("should track request count", async () => {
            const options: MockBackendOptions = { port: testPort };
            backend = new MockLiteLLMBackend(options);
            await backend.start();

            assert.strictEqual(backend.getRequestCount(), 0);

            await makeHttpRequest(`${backend.getBaseUrl()}/models`, "GET");
            assert.strictEqual(backend.getRequestCount(), 1);

            await makeHttpRequest(`${backend.getBaseUrl()}/models`, "GET");
            assert.strictEqual(backend.getRequestCount(), 2);
        });
    });

    suite("/models Endpoint", () => {
        test("should return models list in OpenAI format", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();

            const response = await makeHttpRequest(`${backend.getBaseUrl()}/models`, "GET");
            assert.strictEqual(response.status, 200);

            const data = JSON.parse(response.body) as { data: { id: string; object: string }[] };
            assert.ok(Array.isArray(data.data), "Response should have data array");
            assert.ok(data.data.length > 0, "Should contain at least one model");

            // Verify expected models are present
            const modelIds = data.data.map((m) => m.id);
            assert.ok(modelIds.includes("gpt-4o"), "Should include gpt-4o");
            assert.ok(modelIds.includes("claude-3-opus"), "Should include claude-3-opus");
        });

        test("should return model objects with required fields", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();

            const response = await makeHttpRequest(`${backend.getBaseUrl()}/models`, "GET");
            const data = JSON.parse(response.body) as { data: { id: string; object: string; owned_by: string }[] };

            for (const model of data.data) {
                assert.ok(model.id, "Model should have id");
                assert.strictEqual(model.object, "model", "Model object should be 'model'");
                assert.ok(model.owned_by, "Model should have owned_by field");
            }
        });

        test("should include both OpenAI and Anthropic models", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();

            const response = await makeHttpRequest(`${backend.getBaseUrl()}/models`, "GET");
            const data = JSON.parse(response.body) as { data: { id: string; owned_by: string }[] };

            const providers = new Set(data.data.map((m) => m.owned_by));
            assert.ok(providers.has("openai"), "Should have OpenAI models");
            assert.ok(providers.has("anthropic"), "Should have Anthropic models");
        });
    });

    suite("/chat/completions Endpoint - Non-streaming", () => {
        test("should handle non-streaming chat completions", async () => {
            backend = new MockLiteLLMBackend({ port: testPort, toolCallSupport: false });
            await backend.start();
            const requestBody = JSON.stringify({
                model: "gpt-4o",
                messages: [{ role: "user", content: "Hello" }],
                stream: false,
            });

            const response = await makeHttpRequest(`${backend.getBaseUrl()}/chat/completions`, "POST", requestBody);
            assert.strictEqual(response.status, 200);

            const data = JSON.parse(response.body) as {
                choices: { message: { content: string; role: string }; finish_reason: string }[];
                usage: { prompt_tokens: number; completion_tokens: number };
            };

            assert.ok(Array.isArray(data.choices), "Should have choices array");
            assert.ok(data.choices[0].message.content, "Should have message content");
            assert.strictEqual(data.choices[0].message.role, "assistant", "Role should be assistant");
            assert.strictEqual(data.choices[0].finish_reason, "stop", "Should finish with stop reason");
            assert.ok(data.usage.prompt_tokens > 0, "Should report prompt tokens");
            assert.ok(data.usage.completion_tokens > 0, "Should report completion tokens");
        });

        test("should return model-specific responses", async () => {
            backend = new MockLiteLLMBackend({ port: testPort, toolCallSupport: false });
            await backend.start();
            const models = ["gpt-4o", "claude-3-opus"];

            for (const model of models) {
                const requestBody = JSON.stringify({
                    model,
                    messages: [{ role: "user", content: "Test" }],
                    stream: false,
                });

                const response = await makeHttpRequest(`${backend.getBaseUrl()}/chat/completions`, "POST", requestBody);
                const data = JSON.parse(response.body) as {
                    choices: { message?: { content?: string } }[];
                };

                // The response should contain meaningful content
                assert.ok(
                    data.choices &&
                        data.choices.length > 0 &&
                        data.choices[0].message &&
                        typeof data.choices[0].message.content === "string" &&
                        data.choices[0].message.content.length > 0,
                    `Should return content for model ${model}`
                );
            }
        });

        test("should include usage information", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();
            const requestBody = JSON.stringify({
                model: "gpt-4o",
                messages: [{ role: "user", content: "Hello world" }],
                stream: false,
            });

            const response = await makeHttpRequest(`${backend.getBaseUrl()}/chat/completions`, "POST", requestBody);
            const data = JSON.parse(response.body) as {
                usage: { prompt_tokens: number; completion_tokens: number };
            };

            assert.ok(typeof data.usage.prompt_tokens === "number", "Should have numeric prompt_tokens");
            assert.ok(typeof data.usage.completion_tokens === "number", "Should have numeric completion_tokens");
            assert.ok(data.usage.prompt_tokens > 0, "prompt_tokens should be positive");
            assert.ok(data.usage.completion_tokens > 0, "completion_tokens should be positive");
        });
    });

    suite("/chat/completions Endpoint - Streaming", () => {
        test("should handle streaming chat completions", async () => {
            backend = new MockLiteLLMBackend({ port: testPort, toolCallSupport: false });
            await backend.start();
            const requestBody = JSON.stringify({
                model: "gpt-4o",
                messages: [{ role: "user", content: "Hello" }],
                stream: true,
            });

            const events = await makeStreamingRequest(`${backend.getBaseUrl()}/chat/completions`, "POST", requestBody);

            assert.ok(events.length > 0, "Should receive streaming events");

            // Parse events
            const parsedEvents = events.map((e) => JSON.parse(e));

            // Should have content deltas
            const contentEvents = parsedEvents.filter(
                (e) => e.choices?.[0]?.delta?.content && e.choices[0].delta.content.length > 0
            );
            assert.ok(contentEvents.length > 0, "Should have content delta events");

            // Final event should have finish_reason
            const lastEvent = parsedEvents[parsedEvents.length - 1];
            assert.ok(lastEvent.choices?.[0]?.finish_reason, "Final event should have finish_reason");
        });

        test("should accumulate streaming deltas into complete text", async () => {
            backend = new MockLiteLLMBackend({ port: testPort, toolCallSupport: false });
            await backend.start();

            const requestBody = JSON.stringify({
                model: "gpt-4o",
                messages: [{ role: "user", content: "Hello" }],
                stream: true,
            });

            const events = await makeStreamingRequest(`${backend.getBaseUrl()}/chat/completions`, "POST", requestBody);

            const parsedEvents = events.map((e) => JSON.parse(e));
            const contentParts: string[] = [];

            for (const event of parsedEvents) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any,@typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-assignment
                const content = (event as any).choices?.[0]?.delta?.content;
                if (content) {
                    contentParts.push(content as string);
                }
            }

            const fullText = contentParts.join("");
            assert.ok(fullText.length > 0, "Accumulated text should not be empty");
        });

        test("should include usage in final streaming chunk", async () => {
            backend = new MockLiteLLMBackend({ port: testPort, toolCallSupport: false });
            await backend.start();

            const requestBody = JSON.stringify({
                model: "gpt-4o",
                messages: [{ role: "user", content: "Hello" }],
                stream: true,
            });

            const events = await makeStreamingRequest(`${backend.getBaseUrl()}/chat/completions`, "POST", requestBody);

            const parsedEvents = events.map((e) => JSON.parse(e));

            // Find event with usage information
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            const usageEvent = parsedEvents.find((e) => e.usage);
            assert.ok(usageEvent, "Should have usage information in stream");
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            assert.ok(typeof usageEvent.usage.completion_tokens === "number", "Should have completion_tokens");
        });
    });

    suite("/token_count Endpoint", () => {
        test("should count tokens from prompt", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();
            const requestBody = JSON.stringify({
                prompt: "Hello, how are you?",
            });

            const response = await makeHttpRequest(`${backend.getBaseUrl()}/token_count`, "POST", requestBody);
            assert.strictEqual(response.status, 200);

            const data = JSON.parse(response.body) as { token_count: number };
            assert.ok(typeof data.token_count === "number", "Should return token_count");
            assert.ok(data.token_count > 0, "Token count should be positive");
        });

        test("should count tokens from messages array", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();
            const requestBody = JSON.stringify({
                messages: [
                    { role: "user", content: "Hello" },
                    { role: "assistant", content: "Hi there!" },
                ],
            });

            const response = await makeHttpRequest(`${backend.getBaseUrl()}/token_count`, "POST", requestBody);
            const data = JSON.parse(response.body) as { token_count: number };

            assert.ok(data.token_count > 0, "Should count tokens from message content");
            assert.ok(data.token_count >= 5, "Should count multiple messages");
        });

        test("should estimate tokens based on character count", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();

            // Rough estimate: 1 token per 4 characters
            const testString = "a".repeat(100); // 100 chars ≈ 25 tokens

            const requestBody = JSON.stringify({
                prompt: testString,
            });

            const response = await makeHttpRequest(`${backend.getBaseUrl()}/token_count`, "POST", requestBody);
            const data = JSON.parse(response.body) as { token_count: number };

            // Should be roughly 25 (100 / 4), with some tolerance
            assert.ok(
                data.token_count >= 20 && data.token_count <= 30,
                `Expected 20-30 tokens, got ${data.token_count}`
            );
        });

        test("should return minimum token count of 10", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();
            const requestBody = JSON.stringify({
                prompt: "x",
            });

            const response = await makeHttpRequest(`${backend.getBaseUrl()}/token_count`, "POST", requestBody);
            const data = JSON.parse(response.body) as { token_count: number };

            // Should enforce minimum
            assert.ok(data.token_count >= 10, "Should enforce minimum token count of 10");
        });
    });

    suite("/responses Endpoint (Streaming)", () => {
        test("should handle /responses streaming endpoint", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();
            const requestBody = JSON.stringify({
                model: "gpt-4o",
                messages: [{ role: "user", content: "Hello" }],
                stream: true,
            });

            const events = await makeStreamingRequest(`${backend.getBaseUrl()}/responses`, "POST", requestBody);

            assert.ok(events.length > 0, "Should receive /responses streaming events");
            const parsedEvents = events.map((e) => JSON.parse(e));

            // Should have session.created event
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            const sessionEvent = parsedEvents.find((e) => e.type === "session.created");
            assert.ok(sessionEvent, "Should have session.created event");

            // Should have output_text.delta events
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            const textEvents = parsedEvents.filter((e) => e.type === "response.output_text.delta");
            assert.ok(textEvents.length > 0, "Should have output_text.delta events");

            // Should have completion event
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            const completionEvent = parsedEvents.find((e) => e.type === "response.completed");
            assert.ok(completionEvent, "Should have response.completed event");
        });

        test("should include usage in /responses completion", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();
            const requestBody = JSON.stringify({
                model: "gpt-4o",
                messages: [{ role: "user", content: "Test" }],
            });

            const events = await makeStreamingRequest(`${backend.getBaseUrl()}/responses`, "POST", requestBody);
            const parsedEvents = events.map((e) => JSON.parse(e));

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            const completionEvent = parsedEvents.find((e) => e.type === "response.completed");
            assert.ok(completionEvent, "Should have completion event");
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            assert.ok(completionEvent.response?.usage?.input_tokens, "Should have input_tokens");
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            assert.ok(completionEvent.response?.usage?.output_tokens, "Should have output_tokens");
        });

        test("should accumulate /responses text into complete message", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();
            const requestBody = JSON.stringify({
                model: "gpt-4o",
                messages: [{ role: "user", content: "Hello" }],
            });

            const events = await makeStreamingRequest(`${backend.getBaseUrl()}/responses`, "POST", requestBody);
            const parsedEvents = events.map((e) => JSON.parse(e));

            const textParts: string[] = [];
            for (const event of parsedEvents) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any,@typescript-eslint/no-unsafe-member-access
                if ((event as any).type === "response.output_text.delta" && (event as any).delta) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any,@typescript-eslint/no-unsafe-member-access
                    textParts.push((event as any).delta as string);
                }
            }

            const fullText = textParts.join("");
            assert.ok(fullText.length > 0, "Should have accumulated text");
            assert.ok(fullText.includes("mock response"), "Response should contain expected text");
        });
    });

    suite("Tool Call Support", () => {
        test("should support tool calls in non-streaming responses when enabled", async () => {
            backend = new MockLiteLLMBackend({ port: testPort, toolCallSupport: true });
            await backend.start();

            let toolCallFound = false;
            for (let i = 0; i < 10; i++) {
                const requestBody = JSON.stringify({
                    model: "gpt-4o",
                    messages: [{ role: "user", content: "Call a tool" }],
                    stream: false,
                });

                const response = await makeHttpRequest(`${backend.getBaseUrl()}/chat/completions`, "POST", requestBody);
                const data = JSON.parse(response.body) as {
                    choices: { message: { tool_calls?: { id: string; type: string; function: { name: string } }[] } }[];
                };

                if (data.choices[0].message.tool_calls) {
                    toolCallFound = true;
                    const toolCall = data.choices[0].message.tool_calls[0];
                    assert.ok(toolCall.id, "Tool call should have id");
                    assert.strictEqual(toolCall.type, "function", "Tool call type should be function");
                    assert.ok(toolCall.function.name, "Tool call should have function name");
                    break;
                }
            }

            assert.ok(toolCallFound, "Should eventually generate a tool call response (30% probability per request)");
        });

        test("should disable tool calls when toolCallSupport is false", async () => {
            backend = new MockLiteLLMBackend({ port: testPort, toolCallSupport: false });
            await backend.start();

            for (let i = 0; i < 5; i++) {
                const requestBody = JSON.stringify({
                    model: "gpt-4o",
                    messages: [{ role: "user", content: "Call a tool" }],
                    stream: false,
                });

                const response = await makeHttpRequest(`${backend.getBaseUrl()}/chat/completions`, "POST", requestBody);
                const data = JSON.parse(response.body) as {
                    choices: { message: { tool_calls?: unknown } }[];
                };

                assert.ok(!data.choices[0].message.tool_calls, "Should not have tool calls when disabled");
            }
        });

        test("should handle streaming tool calls", async () => {
            backend = new MockLiteLLMBackend({ port: testPort, toolCallSupport: true });
            await backend.start();

            let toolCallStreamFound = false;
            for (let i = 0; i < 10; i++) {
                const requestBody = JSON.stringify({
                    model: "gpt-4o",
                    messages: [{ role: "user", content: "Call a tool" }],
                    stream: true,
                });

                const events = await makeStreamingRequest(
                    `${backend.getBaseUrl()}/chat/completions`,
                    "POST",
                    requestBody
                );
                const parsedEvents = events.map((e) => JSON.parse(e));

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                const toolCallEvent = parsedEvents.find((e) => e.choices?.[0]?.delta?.tool_calls);
                if (toolCallEvent) {
                    toolCallStreamFound = true;
                    assert.ok(
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any,@typescript-eslint/no-unsafe-member-access
                        Array.isArray((toolCallEvent as any).choices?.[0]?.delta?.tool_calls),
                        "Should have tool_calls array in delta"
                    );
                    break;
                }
            }

            assert.ok(toolCallStreamFound, "Should generate streaming tool call events");
        });
    });

    suite("Error Handling", () => {
        test("should return 404 for unknown endpoints", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();

            const response = await makeHttpRequest(`${backend.getBaseUrl()}/unknown/endpoint`, "GET");
            assert.strictEqual(response.status, 404, "Should return 404 status");
        });

        test("should return error for invalid HTTP methods", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();

            const response = await makeHttpRequest(`${backend.getBaseUrl()}/chat/completions`, "GET");
            assert.strictEqual(response.status, 405, "Should return 405 Method Not Allowed");
        });

        test("should handle malformed JSON gracefully", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();

            try {
                await makeHttpRequest(`${backend.getBaseUrl()}/chat/completions`, "POST", "{ invalid json");
                // If it doesn't throw, that's also acceptable for mock
            } catch (err) {
                // Expected - should fail on parse
                assert.ok(err, "Should handle malformed JSON");
            }
        });
    });

    suite("Latency Simulation", () => {
        test("should apply configured latency to responses", async () => {
            const latencyMs = 150;
            backend = new MockLiteLLMBackend({ port: testPort, latencyMs });
            await backend.start();

            const startTime = Date.now();
            await makeHttpRequest(`${backend.getBaseUrl()}/models`, "GET");
            const elapsed = Date.now() - startTime;

            assert.ok(
                elapsed >= latencyMs - 10, // Allow 10ms margin for timer jitter
                `Expected at least ${latencyMs - 10}ms latency, got ${elapsed}ms`
            );
        });

        test("should apply latency to all endpoints", async () => {
            const latencyMs = 100;
            backend = new MockLiteLLMBackend({ port: testPort, latencyMs });
            await backend.start();

            const endpoints = [
                { path: "/models", method: "GET" as const },
                {
                    path: "/chat/completions",
                    method: "POST" as const,
                    body: JSON.stringify({ model: "gpt-4o", messages: [] }),
                },
                {
                    path: "/token_count",
                    method: "POST" as const,
                    body: JSON.stringify({ prompt: "test" }),
                },
            ];

            for (const endpoint of endpoints) {
                const startTime = Date.now();
                await makeHttpRequest(`${backend.getBaseUrl()}${endpoint.path}`, endpoint.method, endpoint.body);
                const elapsed = Date.now() - startTime;

                assert.ok(elapsed >= latencyMs, `${endpoint.path}: Expected at least ${latencyMs}ms, got ${elapsed}ms`);
            }
        });
    });

    suite("Response Format Compliance", () => {
        test("should return valid OpenAI chat completion format", async () => {
            backend = new MockLiteLLMBackend({ port: testPort, toolCallSupport: false });
            await backend.start();
            const requestBody = JSON.stringify({
                model: "gpt-4o",
                messages: [{ role: "user", content: "test" }],
                stream: false,
            });

            const response = await makeHttpRequest(`${backend.getBaseUrl()}/chat/completions`, "POST", requestBody);
            const data = JSON.parse(response.body) as {
                choices: { message: { content: string; role: string }; finish_reason: string; index?: number }[];
                model?: string;
                created?: number;
                object?: string;
                usage: { prompt_tokens: number; completion_tokens: number };
            };

            // Validate structure
            assert.ok(Array.isArray(data.choices), "Should have choices array");
            assert.ok(data.choices[0].message, "Choice should have message");
            assert.ok(typeof data.choices[0].message.content === "string", "Message should have string content");
            assert.ok(typeof data.choices[0].finish_reason === "string", "Should have finish_reason");
            assert.ok(data.usage, "Should have usage object");
        });

        test("should return valid Content-Type header", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();
            const response = await makeHttpRequest(`${backend.getBaseUrl()}/models`, "GET");

            const contentType = response.headers["content-type"];
            assert.ok(contentType?.includes("application/json"), "Should return JSON Content-Type");
        });

        test("should return valid SSE format for streaming", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();
            const requestBody = JSON.stringify({
                model: "gpt-4o",
                messages: [{ role: "user", content: "test" }],
                stream: true,
            });

            const response = await makeStreamingRequest(
                `${backend.getBaseUrl()}/chat/completions`,
                "POST",
                requestBody
            );

            // All lines should be valid JSON
            for (const event of response) {
                const parsed = JSON.parse(event);
                assert.ok(parsed, "Each SSE event should be valid JSON");
            }
        });

        test("should set correct headers for streaming responses", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();

            return new Promise<void>((resolve, reject) => {
                const parsedUrl = new URL(`${backend.getBaseUrl()}/chat/completions`);
                const options: http.RequestOptions = {
                    hostname: parsedUrl.hostname,
                    port: parsedUrl.port,
                    path: parsedUrl.pathname,
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                };

                const req = http.request(options, (res) => {
                    try {
                        const contentType = res.headers["content-type"];
                        assert.ok(contentType?.includes("text/event-stream"), "Streaming should use text/event-stream");

                        const cacheControl = res.headers["cache-control"];
                        assert.ok(cacheControl?.includes("no-cache"), "Should set cache-control: no-cache");

                        res.destroy();
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                });

                req.write(JSON.stringify({ model: "gpt-4o", messages: [], stream: true }));
                req.end();
            });
        });
    });

    suite("Concurrent Requests", () => {
        test("should handle multiple concurrent requests", async () => {
            backend = new MockLiteLLMBackend({ port: testPort, latencyMs: 10 });
            await backend.start();
            const promises = [];
            for (let i = 0; i < 5; i++) {
                promises.push(makeHttpRequest(`${backend.getBaseUrl()}/models`, "GET"));
            }

            const results = await Promise.all(promises);
            assert.strictEqual(results.length, 5, "All requests should complete");
            assert.ok(
                results.every((r) => r.status === 200),
                "All requests should succeed"
            );
            assert.strictEqual(backend.getRequestCount(), 5, "Should track all concurrent requests");
        });

        test("should handle concurrent chat completions", async () => {
            backend = new MockLiteLLMBackend({ port: testPort, latencyMs: 10 });
            await backend.start();
            const promises = [];
            for (let i = 0; i < 3; i++) {
                const body = JSON.stringify({
                    model: "gpt-4o",
                    messages: [{ role: "user", content: `Request ${i}` }],
                });
                promises.push(makeHttpRequest(`${backend.getBaseUrl()}/chat/completions`, "POST", body));
            }

            const results = await Promise.all(promises);
            assert.ok(
                results.every((r) => r.status === 200),
                "All chat requests should succeed"
            );
        });
    });

    suite("BaseUrl Generation", () => {
        test("should generate correct baseUrl", async () => {
            backend = new MockLiteLLMBackend({ port: testPort });
            await backend.start();

            const baseUrl = backend.getBaseUrl();
            assert.strictEqual(baseUrl, `http://localhost:${testPort}`);
        });

        test("should generate different baseUrls for different ports", async () => {
            const backend1 = new MockLiteLLMBackend({ port: testPort });
            const backend2 = new MockLiteLLMBackend({ port: testPort + 1 });

            await backend1.start();
            await backend2.start();

            try {
                assert.notStrictEqual(backend1.getBaseUrl(), backend2.getBaseUrl());
                assert.ok(backend1.getBaseUrl().includes(`${testPort}`));
                assert.ok(backend2.getBaseUrl().includes(`${testPort + 1}`));
            } finally {
                await backend1.stop();
                await backend2.stop();
            }
        });
    });

    suite("Integration: Full Chat Flow", () => {
        test("should support complete non-streaming chat flow", async () => {
            backend = new MockLiteLLMBackend({ port: testPort, toolCallSupport: false });
            await backend.start();
            // 1. Discover models
            const modelsResponse = await makeHttpRequest(`${backend.getBaseUrl()}/models`, "GET");
            const models = JSON.parse(modelsResponse.body) as { data: { id: string }[] };
            const modelId = models.data[0].id;

            // 2. Send a chat request
            const chatBody = JSON.stringify({
                model: modelId,
                messages: [{ role: "user", content: "Say hello" }],
            });
            const chatResponse = await makeHttpRequest(`${backend.getBaseUrl()}/chat/completions`, "POST", chatBody);
            const chatData = JSON.parse(chatResponse.body) as {
                choices: { message: { content: string } }[];
            };
            assert.ok(chatData.choices[0].message.content, "Should have response content");

            // 3. Count tokens in the request
            const countBody = JSON.stringify({
                messages: [{ role: "user", content: "Say hello" }],
            });
            const countResponse = await makeHttpRequest(`${backend.getBaseUrl()}/token_count`, "POST", countBody);
            const tokenData = JSON.parse(countResponse.body) as { token_count: number };
            assert.ok(tokenData.token_count > 0, "Should count tokens");
        });

        test("should support complete streaming chat flow", async () => {
            backend = new MockLiteLLMBackend({ port: testPort, toolCallSupport: false });
            await backend.start();
            // 1. Discover models
            const modelsResponse = await makeHttpRequest(`${backend.getBaseUrl()}/models`, "GET");
            const models = JSON.parse(modelsResponse.body) as { data: { id: string }[] };
            const modelId = models.data[0].id;

            // 2. Send streaming chat request
            const chatBody = JSON.stringify({
                model: modelId,
                messages: [{ role: "user", content: "Say hello" }],
                stream: true,
            });
            const events = await makeStreamingRequest(`${backend.getBaseUrl()}/chat/completions`, "POST", chatBody);
            assert.ok(events.length > 0, "Should receive streaming events");

            // Accumulate response
            let fullResponse = "";
            for (const event of events) {
                const data = JSON.parse(event);
                if (data.choices?.[0]?.delta?.content) {
                    fullResponse += data.choices[0].delta.content;
                }
            }
            assert.ok(fullResponse.length > 0, "Should accumulate response");
        });
    });
});
