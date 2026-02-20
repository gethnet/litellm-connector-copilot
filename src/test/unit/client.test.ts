import * as assert from "assert";
import { LiteLLMClient } from "../../adapters/litellmClient";
import * as sinon from "sinon";

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

    test("getHeaders includes Cache-Control: no-cache when disabled", () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);
        // @ts-expect-error - accessing private method for testing
        const headers = client.getHeaders("gpt-4");
        assert.strictEqual(headers["Cache-Control"], "no-cache");
    });

    test("getHeaders bypasses Cache-Control for Claude models", () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);
        // @ts-expect-error - accessing private method for testing
        const headers = client.getHeaders("claude-3-sonnet");
        assert.strictEqual(headers["Cache-Control"], undefined);
    });

    test("chat includes no_cache in body when disabled", async () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").resolves({
            ok: true,
            body: new ReadableStream(),
        } as Response);

        await client.chat({ model: "gpt-4", messages: [] });

        const args = fetchStub.getCall(0).args;
        const body = JSON.parse(args[1]!.body as string);
        assert.strictEqual(body.no_cache, undefined);
        assert.strictEqual(body["no-cache"], undefined);
        assert.strictEqual(body.extra_body?.cache?.["no-cache"], true);
    });

    test("chat bypasses no_cache for Claude models", async () => {
        const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);
        const fetchStub = sandbox.stub(global, "fetch").resolves({
            ok: true,
            body: new ReadableStream(),
        } as Response);

        await client.chat({ model: "claude-3-opus", messages: [] });

        const args = fetchStub.getCall(0).args;
        const body = JSON.parse(args[1]!.body as string);
        assert.strictEqual(body.no_cache, undefined);
        assert.strictEqual(body["no-cache"], undefined);
        assert.strictEqual(body.extra_body, undefined);
        const headers = args[1]!.headers as Record<string, string>;
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

        await client.chat({ model: "gpt-4", messages: [] });

        assert.strictEqual(fetchStub.callCount, 2, "Should have retried");

        // First call should have no_cache
        const firstCallBody = JSON.parse(fetchStub.getCall(0).args[1]!.body as string);
        assert.strictEqual(firstCallBody.no_cache, undefined);
        assert.strictEqual(firstCallBody["no-cache"], undefined);
        assert.strictEqual(firstCallBody.extra_body?.cache?.["no-cache"], true);
        const firstCallHeaders = fetchStub.getCall(0).args[1]!.headers as Record<string, string>;
        assert.strictEqual(firstCallHeaders["Cache-Control"], "no-cache");

        // Second call should NOT have no_cache or Cache-Control
        const secondCallBody = JSON.parse(fetchStub.getCall(1).args[1]!.body as string);
        assert.strictEqual(secondCallBody.no_cache, undefined);
        assert.strictEqual(secondCallBody["no-cache"], undefined);
        assert.strictEqual(secondCallBody.extra_body, undefined);
        const secondCallHeaders = fetchStub.getCall(1).args[1]!.headers as Record<string, string>;
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

        const secondCallBody = JSON.parse(fetchStub.getCall(0).args[1]!.body as string);
        assert.strictEqual(secondCallBody.temperature, 1);

        const retryCallBody = JSON.parse(fetchStub.getCall(1).args[1]!.body as string);
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

        const firstCallBody = JSON.parse(fetchStub.getCall(0).args[1]!.body as string);
        // First call should still contain caching controls due to disableCaching.
        assert.strictEqual(firstCallBody.extra_body?.cache?.["no-cache"], true);

        const retryCallBody = JSON.parse(fetchStub.getCall(1).args[1]!.body as string);
        assert.strictEqual(retryCallBody.cache, undefined);
        assert.strictEqual(retryCallBody.extra_body, undefined);

        const retryHeaders = fetchStub.getCall(1).args[1]!.headers as Record<string, string>;
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
            await new Promise(() => {});
            return {} as Response;
        });

        let onCancel: (() => void) | undefined;
        const token = {
            onCancellationRequested: (cb: () => void) => {
                onCancel = cb;
                return { dispose() {} };
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

    test("chat decorates 400 errors with model context", async () => {
        const client = new LiteLLMClient({ url: "http://localhost:4000", key: "k" }, "ua");

        const fetchStub = sandbox.stub(global, "fetch");
        fetchStub.resolves(
            new Response(JSON.stringify({ error: { message: "bad" } }), {
                status: 400,
                statusText: "Bad Request",
            }) as never
        );

        await assert.rejects(
            () =>
                client.chat(
                    {
                        model: "m1",
                        messages: [],
                        stream: true,
                        max_tokens: 1,
                    },
                    "chat"
                ),
            /LiteLLM Error \(m1\)/
        );
    });

    test("chat throws when response body missing", async () => {
        const client = new LiteLLMClient({ url: "http://localhost:4000", key: "k" }, "ua");

        const fetchStub = sandbox.stub(global, "fetch");
        // Response() in node sets a non-null body by default; simulate a missing body explicitly.
        fetchStub.resolves({ ok: true, status: 200, statusText: "OK", body: null } as unknown as Response);

        await assert.rejects(
            () =>
                client.chat(
                    {
                        model: "m1",
                        messages: [],
                        stream: true,
                        max_tokens: 1,
                    },
                    "chat"
                ),
            /No response body/
        );
    });
});
