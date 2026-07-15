import * as assert from "assert";
import { LiteLLMClient } from "../litellmClient";
import * as sinon from "sinon";
import type { LiteLLMModelInfo, LiteLLMModelInfoResponse } from "../../types";

suite("LiteLLM Client Unit Tests", () => {
    const config = { url: "http://localhost:4000", key: "test-key" };
    const userAgent = "test-ua";
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("getHeaders includes Authorization and X-API-Key", () => {
        const client = new LiteLLMClient(config, userAgent);
        // @ts-expect-error - accessing private method for testing
        const headers = client.getHeaders();
        assert.strictEqual(headers["Authorization"], "Bearer test-key");
        assert.strictEqual(headers["X-API-Key"], "test-key");
        assert.strictEqual(headers["User-Agent"], userAgent);
    });

    test("getHeaders includes Cache-Control only for a request carrying cache bypass", () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);
        // @ts-expect-error - accessing private method for testing
        const headersWithBypass = client.getHeaders("cache-capable-model", undefined, {
            model: "cache-capable-model",
            messages: [],
            extra_body: { cache: { "no-cache": true } },
        });
        // @ts-expect-error - accessing private method for testing
        const headersWithoutBypass = client.getHeaders("azure_ai/gpt-4o-mini", undefined, {
            model: "azure_ai/gpt-4o-mini",
            messages: [],
        });

        assert.strictEqual(headersWithBypass["Cache-Control"], "no-cache");
        assert.strictEqual(headersWithoutBypass["Cache-Control"], undefined);
    });

    test("getHeaders bypasses Cache-Control for Claude models", () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);
        // @ts-expect-error - accessing private method for testing
        const headers = client.getHeaders("claude-3-sonnet");
        assert.strictEqual(headers["Cache-Control"], undefined);
    });

    test("chat does not inject cache controls after request filtering", async () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").resolves({
            ok: true,
            body: new ReadableStream(),
        } as Response);

        await client.chat({ model: "azure_ai/gpt-4o-mini", messages: [] });

        const args0 = fetchStub.getCall(0).args;
        const requestInit = args0[1] as RequestInit | undefined;
        const bodyStr = requestInit?.body as string | undefined;
        const body = bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : {};
        assert.strictEqual(body.extra_body, undefined);
        const headers = requestInit?.headers as Record<string, string>;
        assert.strictEqual(headers["Cache-Control"], undefined);
    });

    test("chat sends cache controls only when the filtered request retains them", async () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").resolves({
            ok: true,
            body: new ReadableStream(),
        } as Response);

        await client.chat({
            model: "cache-capable-model",
            messages: [],
            extra_body: { cache: { "no-cache": true } },
        });

        const args0 = fetchStub.getCall(0).args;
        const requestInit = args0[1] as RequestInit | undefined;
        const bodyStr = requestInit?.body as string | undefined;
        const body = bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : {};
        assert.deepStrictEqual(body.extra_body, { cache: { "no-cache": true } });
        const headers = (requestInit?.headers as Record<string, string>) ?? {};
        assert.strictEqual(headers["Cache-Control"], "no-cache");
        assert.ok(!JSON.stringify(body).includes("cache_control"));
        assert.ok(!JSON.stringify(body).includes("cache-control"));
        assert.ok(!JSON.stringify(body).includes("$mid"));
    });

    test("chat omits Cache-Control for Claude models even when their request carries cache bypass", async () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").resolves({
            ok: true,
            body: new ReadableStream(),
        } as Response);

        await client.chat({
            model: "claude-3-opus",
            messages: [],
            extra_body: { cache: { "no-cache": true } },
        });

        const requestInit = fetchStub.getCall(0).args[1] as RequestInit;
        const body = JSON.parse(requestInit.body as string) as Record<string, unknown>;
        const headers = requestInit.headers as Record<string, string>;

        assert.deepStrictEqual(body.extra_body, { cache: { "no-cache": true } });
        assert.strictEqual(headers["Cache-Control"], undefined);
    });

    test("getEndpoint resolves correctly", () => {
        const client = new LiteLLMClient(config, userAgent);
        // @ts-expect-error - accessing private method for testing
        assert.strictEqual(client.getEndpoint("chat"), "/chat/completions");
        // @ts-expect-error - accessing private method for testing
        assert.strictEqual(client.getEndpoint("responses"), "/responses");
        // @ts-expect-error - accessing private method for testing
        assert.strictEqual(client.getEndpoint(undefined), "/chat/completions");
    });

    test("chat retries without caching if unsupported parameter error occurs", async () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);

        const errorResponse = {
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => "Unsupported parameter: no_cache",
            clone: function () {
                return this;
            },
        };

        const successResponse = {
            ok: true,
            status: 200,
            body: new ReadableStream(),
        };

        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).resolves(errorResponse as unknown as Response);
        fetchStub.onCall(1).resolves(successResponse as unknown as Response);

        await client.chat({
            model: "gpt-4",
            messages: [],
            extra_body: { cache: { "no-cache": true } },
        });

        assert.strictEqual(fetchStub.callCount, 2, "Should have retried");

        // First call should have no_cache
        const firstCallInit = fetchStub.getCall(0).args[1] as RequestInit | undefined;
        const firstCallBodyStr = firstCallInit?.body as string | undefined;
        const firstCallBody = firstCallBodyStr ? (JSON.parse(firstCallBodyStr) as Record<string, unknown>) : {};
        assert.strictEqual(firstCallBody.no_cache, undefined);
        assert.strictEqual(firstCallBody["no-cache"], undefined);
        const firstExtraBody = firstCallBody.extra_body as Record<string, unknown> | undefined;
        const firstCache = firstExtraBody?.cache as Record<string, unknown> | undefined;
        assert.strictEqual(firstCache?.["no-cache"], true);
        const firstCallHeaders = (firstCallInit?.headers as Record<string, string>) ?? {};
        assert.strictEqual(firstCallHeaders["Cache-Control"], "no-cache");

        // Second call should NOT have no_cache or Cache-Control
        const secondCallInit = fetchStub.getCall(1).args[1] as RequestInit | undefined;
        const secondCallBodyStr = secondCallInit?.body as string | undefined;
        const secondCallBody = secondCallBodyStr ? (JSON.parse(secondCallBodyStr) as Record<string, unknown>) : {};
        assert.strictEqual(secondCallBody.no_cache, undefined);
        assert.strictEqual(secondCallBody["no-cache"], undefined);
        assert.strictEqual(secondCallBody.extra_body, undefined);
        const secondCallHeaders = (secondCallInit?.headers as Record<string, string>) ?? {};
        assert.strictEqual(secondCallHeaders["Cache-Control"], undefined);
    });

    test("chat retries by stripping specific parameter mentioned in error", async () => {
        const client = new LiteLLMClient(config, userAgent);

        const errorResponse = {
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => "LiteLLM Error: unexpected keyword argument 'temperature'",
            clone: function () {
                return this;
            },
        };

        const successResponse = {
            ok: true,
            status: 200,
            body: new ReadableStream(),
        };

        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).resolves(errorResponse as unknown as Response);
        fetchStub.onCall(1).resolves(successResponse as unknown as Response);

        await client.chat({ model: "o1-mini", messages: [], temperature: 1 });

        assert.strictEqual(fetchStub.callCount, 2);

        const secondCallInit = fetchStub.getCall(0).args[1] as RequestInit | undefined;
        const secondCallBodyStr = secondCallInit?.body as string | undefined;
        const secondCallBody = secondCallBodyStr ? (JSON.parse(secondCallBodyStr) as Record<string, unknown>) : {};
        assert.strictEqual(secondCallBody.temperature, 1);

        const retryCallInit = fetchStub.getCall(1).args[1] as RequestInit | undefined;
        const retryCallBodyStr = retryCallInit?.body as string | undefined;
        const retryCallBody = retryCallBodyStr ? (JSON.parse(retryCallBodyStr) as Record<string, unknown>) : {};
        assert.strictEqual(retryCallBody.temperature, undefined, "Temperature should have been stripped");
    });

    test("chat strips cache and extra_body.cache when backend rejects unknown parameter cache", async () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);

        const errorResponse = {
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => "Unknown parameter: cache",
            clone: function () {
                return this;
            },
        };

        const successResponse = {
            ok: true,
            status: 200,
            body: new ReadableStream(),
        };

        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).resolves(errorResponse as unknown as Response);
        fetchStub.onCall(1).resolves(successResponse as unknown as Response);

        // Include both top-level cache and extra_body.cache to ensure both are stripped.
        await client.chat({
            model: "gpt-4",
            messages: [],
            cache: { "no-cache": true },
            extra_body: { cache: { "no-cache": true, no_cache: true } },
        } as never);

        assert.strictEqual(fetchStub.callCount, 2);

        const firstCallInit = fetchStub.getCall(0).args[1] as RequestInit | undefined;
        const firstCallBodyStr = firstCallInit?.body as string | undefined;
        const firstCallBody = firstCallBodyStr ? (JSON.parse(firstCallBodyStr) as Record<string, unknown>) : {};
        // First call should still contain caching controls due to disableCaching.
        const firstExtraBody = firstCallBody.extra_body as Record<string, unknown> | undefined;
        const firstCache = firstExtraBody?.cache as Record<string, unknown> | undefined;
        assert.strictEqual(firstCache?.["no-cache"], true);

        const retryCallInit = fetchStub.getCall(1).args[1] as RequestInit | undefined;
        const retryCallBodyStr = retryCallInit?.body as string | undefined;
        const retryCallBody = retryCallBodyStr ? (JSON.parse(retryCallBodyStr) as Record<string, unknown>) : {};
        assert.strictEqual(retryCallBody.cache, undefined);
        assert.strictEqual(retryCallBody.extra_body, undefined);

        const retryHeaders = (retryCallInit?.headers as Record<string, string>) ?? {};
        assert.strictEqual(retryHeaders["Cache-Control"], undefined);
    });

    test("parseRetryAfterDelayMs handles seconds, future date, and invalid values", () => {
        const client = new LiteLLMClient(config, userAgent);

        const mkResp = (value: string | null): Response =>
            ({
                headers: {
                    get: (k: string) => (k.toLowerCase() === "retry-after" ? value : null),
                },
            }) as unknown as Response;

        // @ts-expect-error - accessing private method for testing
        const parse = client.parseRetryAfterDelayMs.bind(client) as (r: Response) => number | undefined;

        assert.strictEqual(parse(mkResp("2")), 2000);

        const future = new Date(Date.now() + 5_000).toUTCString();
        const delta = parse(mkResp(future));
        assert.ok(typeof delta === "number" && delta > 0 && delta <= 5_000);

        assert.strictEqual(parse(mkResp("not-a-date")), undefined);
        assert.strictEqual(parse(mkResp(null)), undefined);
    });

    test("getModelInfo returns JSON when response is ok", async () => {
        const client = new LiteLLMClient(config, userAgent);

        const jsonStub = sandbox.stub().resolves({ data: [] });
        const fetchStub = sandbox.stub(global, "fetch").resolves({
            ok: true,
            status: 200,
            statusText: "OK",
            json: jsonStub,
        } as unknown as Response);

        const res = await client.getModelInfo();
        assert.deepStrictEqual(res, { data: [] });
        assert.strictEqual(fetchStub.calledOnce, true);
        assert.strictEqual(jsonStub.calledOnce, true);
    });

    test("getModelInfo retries with normalized URL when first endpoint returns 404", async () => {
        const client = new LiteLLMClient({ url: "http://localhost:4000/v1", key: "test-key" }, userAgent);

        const jsonStub = sandbox.stub().resolves({ data: [] });
        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.onCall(0).resolves({
            ok: false,
            status: 404,
            statusText: "Not Found",
        } as unknown as Response);
        fetchStub.onCall(1).resolves({
            ok: true,
            status: 200,
            statusText: "OK",
            json: jsonStub,
        } as unknown as Response);

        const res = await client.getModelInfo();
        assert.deepStrictEqual(res, { data: [] });
        assert.strictEqual(fetchStub.callCount, 2);
        assert.strictEqual(fetchStub.getCall(0).args[0], "http://localhost:4000/v1/model/info");
        assert.strictEqual(fetchStub.getCall(1).args[0], "http://localhost:4000/model/info");
    });

    test("getModelInfo throws with status details when response is not ok", async () => {
        const client = new LiteLLMClient(config, userAgent);

        sandbox.stub(global, "fetch").resolves({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
        } as unknown as Response);

        await assert.rejects(
            () => client.getModelInfo(),
            (err: unknown) =>
                err instanceof Error &&
                err.message.includes("Failed to fetch model info") &&
                err.message.includes("500") &&
                err.message.includes("Internal Server Error")
        );
    });

    test("getModelInfo aborts fetch when cancellation token fires", async () => {
        const client = new LiteLLMClient(config, userAgent);

        let abortSignal: AbortSignal | undefined;
        sandbox.stub(global, "fetch").callsFake(async (_input: string | URL | Request, init?: RequestInit) => {
            abortSignal = init?.signal as AbortSignal | undefined;
            // Never resolve; we expect the abort signal to flip.
            await new Promise((_resolve) => {
                // Keep promise pending
            });
            return {} as Response;
        });

        let onCancel: (() => void) | undefined;
        const token = {
            onCancellationRequested: (cb: () => void) => {
                onCancel = cb;
                return {
                    dispose() {
                        // No-op for mock
                    },
                };
            },
        } as unknown as { onCancellationRequested: (cb: () => void) => { dispose(): void } };

        void client.getModelInfo(token as never);

        // Wait a tick for fetch to be invoked and signal captured.
        await Promise.resolve();
        assert.ok(abortSignal, "Expected fetch to be called with an AbortSignal");
        assert.strictEqual(abortSignal?.aborted, false);

        onCancel?.();
        assert.strictEqual(abortSignal?.aborted, true);
    });

    test("fetchWithRetry retries on 429 with backoff", async () => {
        const client = new LiteLLMClient(config, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");

        const rateLimitResponse = {
            ok: false,
            status: 429,
            statusText: "Too Many Requests",
            clone: function () {
                return this;
            },
            text: async () => "Rate limit exceeded",
            headers: {
                get: (name: string) => {
                    if (name.toLowerCase() === "retry-after") {
                        return "0.5";
                    }
                    return null;
                },
            },
        } as Response;

        const successResponse = new Response(new ReadableStream(), {
            status: 200,
            statusText: "OK",
        });

        // Keep the stub total: if the implementation accidentally performs a
        // third fetch, it should receive a real response and fail the call-count
        // assertion rather than producing the misleading "No response" error.
        fetchStub.callsFake(async () => (fetchStub.callCount === 1 ? rateLimitResponse : successResponse));

        await client.chat({ model: "m", messages: [] });

        assert.strictEqual(fetchStub.callCount, 2);
    });

    test("fetchWithRetry retries on 5xx", async () => {
        const client = new LiteLLMClient(config, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");

        const serverErrorResponse = new Response("Service Unavailable", {
            status: 503,
            statusText: "Service Unavailable",
        });

        const successResponse = new Response(new ReadableStream(), { status: 200, statusText: "OK" });

        fetchStub.onCall(0).resolves(serverErrorResponse as unknown as Response);
        fetchStub.onCall(1).resolves(successResponse as unknown as Response);

        await client.chat({ model: "m", messages: [] });

        assert.strictEqual(fetchStub.callCount, 2);
    });

    test("fetchWithRetry does not retry on non-429 4xx", async () => {
        const client = new LiteLLMClient(config, userAgent);
        const fetchStub = sandbox.stub(global, "fetch");

        const badRequestResponse = new Response("Unauthorized", { status: 401, statusText: "Unauthorized" });

        fetchStub.resolves(badRequestResponse as unknown as Response);

        await assert.rejects(() => client.chat({ model: "m", messages: [] }));
        assert.strictEqual(fetchStub.callCount, 1);
    });

    test("checkConnection handles empty or invalid data", async () => {
        const client = new LiteLLMClient(config, userAgent);
        sandbox.stub(client, "getModelInfo").resolves({
            data: [] as { model_name?: string; model_info?: LiteLLMModelInfo }[],
        } as unknown as LiteLLMModelInfoResponse);

        const res = await client.checkConnection();
        assert.strictEqual(res.modelCount, 0);
        assert.deepStrictEqual(res.sampleModelIds, []);
    });

    test("checkConnection extracts model IDs correctly", async () => {
        const client = new LiteLLMClient(config, userAgent);
        sandbox.stub(client, "getModelInfo").resolves({
            data: [{ model_name: "m1", model_info: { key: "k1" } }, { model_name: "m2" }, {}],
        } as unknown as LiteLLMModelInfoResponse);

        const res = await client.checkConnection();
        assert.strictEqual(res.modelCount, 3);
        assert.deepStrictEqual(res.sampleModelIds, ["k1", "m2", "unknown"]);
    });

    test("countTokens handles non-OK response", async () => {
        const client = new LiteLLMClient(config, userAgent);
        sandbox.stub(global, "fetch").resolves({
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => "detailed error",
        } as Response);

        await assert.rejects(() => client.countTokens({ model: "m", prompt: "p" }), /Failed to count tokens/);
    });

    test("chat handles missing response body", async () => {
        const client = new LiteLLMClient(config, userAgent);
        sandbox.stub(global, "fetch").resolves({
            ok: true,
            status: 200,
            body: null,
        } as Response);

        await assert.rejects(() => client.chat({ model: "m", messages: [] }), /No response body/);
    });
});
