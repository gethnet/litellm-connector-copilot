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
		assert.strictEqual(body.no_cache, true);
		assert.strictEqual(body["no-cache"], true);
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
		assert.strictEqual(firstCallBody.no_cache, true);
		assert.strictEqual(firstCallBody["no-cache"], true);
		const firstCallHeaders = fetchStub.getCall(0).args[1]!.headers as Record<string, string>;
		assert.strictEqual(firstCallHeaders["Cache-Control"], "no-cache");

		// Second call should NOT have no_cache or Cache-Control
		const secondCallBody = JSON.parse(fetchStub.getCall(1).args[1]!.body as string);
		assert.strictEqual(secondCallBody.no_cache, undefined);
		assert.strictEqual(secondCallBody["no-cache"], undefined);
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
});
