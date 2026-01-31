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
		const headers = client.getHeaders();
		assert.strictEqual(headers["Cache-Control"], "no-cache");
	});

	test("chat includes no_cache in body when disabled", async () => {
		const client = new LiteLLMClient({ ...config, disableCaching: true }, userAgent);
		const fetchStub = sandbox.stub(global, "fetch").resolves({
			ok: true,
			body: new ReadableStream(),
		} as Response);

		await client.chat({ model: "test", messages: [] });

		const args = fetchStub.getCall(0).args;
		const body = JSON.parse(args[1]!.body as string);
		assert.strictEqual(body.no_cache, true);
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
});
