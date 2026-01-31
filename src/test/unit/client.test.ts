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
