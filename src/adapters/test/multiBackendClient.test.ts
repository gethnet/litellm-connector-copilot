import * as assert from "assert";
import * as sinon from "sinon";
import { MultiBackendClient, parseNamespacedModelId, createNamespacedModelId } from "../multiBackendClient";
import type { LiteLLMClient } from "../litellmClient";
import type { ResolvedBackend } from "../../types";

suite("MultiBackendClient Unit Tests", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("createNamespacedModelId produces correct format", () => {
        assert.strictEqual(createNamespacedModelId("cloud", "gpt-4o"), "cloud/gpt-4o");
        assert.strictEqual(createNamespacedModelId("local", "llama-3"), "local/llama-3");
    });

    test("parseNamespacedModelId extracts backend and model", () => {
        const result = parseNamespacedModelId("cloud/gpt-4o", ["cloud", "local"]);
        assert.ok(result);
        assert.strictEqual(result.backendName, "cloud");
        assert.strictEqual(result.originalModelId, "gpt-4o");
    });

    test("parseNamespacedModelId returns undefined for unknown prefix", () => {
        const result = parseNamespacedModelId("unknown/model", ["cloud", "local"]);
        assert.strictEqual(result, undefined);
    });

    test("getModelInfoAll aggregates models from all backends", async () => {
        const backends: ResolvedBackend[] = [
            { name: "cloud", url: "http://cloud:4000", apiKey: "sk-cloud", enabled: true },
            { name: "local", url: "http://local:4000", enabled: true },
        ];

        const client = new MultiBackendClient(backends, "test-ua");

        // Access internal clients map for stubbing
        const clients = (client as unknown as { clients: Map<string, LiteLLMClient> }).clients;
        const cloudClient = clients.get("cloud")!;
        const localClient = clients.get("local")!;

        sandbox.stub(cloudClient, "getModelInfo").resolves({
            data: [{ model_name: "gpt-4o", model_info: { key: "gpt-4o", max_input_tokens: 128000 } }],
        });
        sandbox.stub(localClient, "getModelInfo").resolves({
            data: [{ model_name: "llama-3", model_info: { key: "llama-3", max_input_tokens: 8192 } }],
        });

        const result = await client.getModelInfoAll();

        assert.strictEqual(result.data.length, 2);
        assert.ok(result.data.some((d) => d.namespacedId === "cloud/gpt-4o" && d.backendName === "cloud"));
        assert.ok(result.data.some((d) => d.namespacedId === "local/llama-3" && d.backendName === "local"));
    });

    test("getModelInfoAll continues when one backend fails", async () => {
        const backends: ResolvedBackend[] = [
            { name: "cloud", url: "http://cloud:4000", enabled: true },
            { name: "local", url: "http://local:4000", enabled: true },
        ];

        const client = new MultiBackendClient(backends, "test-ua");

        const clients = (client as unknown as { clients: Map<string, LiteLLMClient> }).clients;
        sandbox.stub(clients.get("cloud")!, "getModelInfo").rejects(new Error("Connection refused"));
        sandbox.stub(clients.get("local")!, "getModelInfo").resolves({
            data: [{ model_name: "llama-3", model_info: { key: "llama-3" } }],
        });

        const result = await client.getModelInfoAll();

        assert.strictEqual(result.data.length, 1);
        assert.strictEqual(result.data[0].namespacedId, "local/llama-3");
    });

    test("chat routes to correct backend and strips prefix", async () => {
        const backends: ResolvedBackend[] = [{ name: "cloud", url: "http://cloud:4000", enabled: true }];

        const client = new MultiBackendClient(backends, "test-ua");
        const clients = (client as unknown as { clients: Map<string, LiteLLMClient> }).clients;
        const chatStub = sandbox.stub(clients.get("cloud")!, "chat").resolves(new ReadableStream());

        await client.chat("cloud/gpt-4o", { model: "cloud/gpt-4o", messages: [], stream: true });

        assert.ok(chatStub.calledOnce);
        const sentRequest = chatStub.firstCall.args[0];
        assert.strictEqual(sentRequest.model, "gpt-4o"); // prefix stripped
    });

    test("chat throws for unknown backend prefix with multiple backends", async () => {
        const backends: ResolvedBackend[] = [
            { name: "cloud", url: "http://cloud:4000", enabled: true },
            { name: "local", url: "http://local:4000", enabled: true },
        ];

        const client = new MultiBackendClient(backends, "test-ua");

        await assert.rejects(
            () => client.chat("unknown/model", { model: "unknown/model", messages: [], stream: true }),
            /no matching backend prefix/
        );
    });

    test("chat falls back to sole backend when no prefix", async () => {
        const backends: ResolvedBackend[] = [{ name: "default", url: "http://default:4000", enabled: true }];

        const client = new MultiBackendClient(backends, "test-ua");
        const clients = (client as unknown as { clients: Map<string, LiteLLMClient> }).clients;
        const chatStub = sandbox.stub(clients.get("default")!, "chat").resolves(new ReadableStream());

        await client.chat("gpt-4o", { model: "gpt-4o", messages: [], stream: true });

        assert.ok(chatStub.calledOnce);
        assert.strictEqual(chatStub.firstCall.args[0].model, "gpt-4o");
    });

    test("countTokens routes to correct backend and strips prefix", async () => {
        const backends: ResolvedBackend[] = [{ name: "cloud", url: "http://cloud:4000", enabled: true }];

        const client = new MultiBackendClient(backends, "test-ua");
        const clients = (client as unknown as { clients: Map<string, LiteLLMClient> }).clients;
        const countStub = sandbox.stub(clients.get("cloud")!, "countTokens").resolves({ token_count: 10 });

        const count = await client.countTokens("cloud/gpt-4o", { model: "cloud/gpt-4o", prompt: "hello" });

        assert.strictEqual(count.token_count, 10);
        assert.strictEqual(countStub.firstCall.args[0].model, "gpt-4o");
    });

    test("checkConnectionAll returns per-backend results and handles failures", async () => {
        const backends: ResolvedBackend[] = [
            { name: "b1", url: "u1", enabled: true },
            { name: "b2", url: "u2", enabled: true },
        ];

        const client = new MultiBackendClient(backends, "test-ua");
        const clients = (client as unknown as { clients: Map<string, LiteLLMClient> }).clients;

        sandbox.stub(clients.get("b1")!, "getModelInfo").resolves({
            data: [{ model_name: "m1" }, { model_name: "m2" }],
        });
        sandbox.stub(clients.get("b2")!, "getModelInfo").rejects(new Error("conn failed"));

        const results = await client.checkConnectionAll();

        assert.strictEqual(results.length, 2);
        assert.strictEqual(results[0].backendName, "b1");
        assert.strictEqual(results[0].modelCount, 2);
        assert.ok(!results[0].error);

        assert.strictEqual(results[1].backendName, "b2");
        assert.strictEqual(results[1].error, "conn failed");
    });

    test("backendCount returns correct count", () => {
        const client = new MultiBackendClient(
            [
                { name: "b1", url: "u1", enabled: true },
                { name: "b2", url: "u2", enabled: false },
            ],
            "ua"
        );
        assert.strictEqual(client.backendCount, 2);
    });

    test("getBackendNames returns all names", () => {
        const client = new MultiBackendClient(
            [
                { name: "b1", url: "u1", enabled: true },
                { name: "b2", url: "u2", enabled: true },
            ],
            "ua"
        );
        assert.deepStrictEqual(client.getBackendNames(), ["b1", "b2"]);
    });

    test("constructor with empty backends creates client with zero backends", () => {
        const client = new MultiBackendClient([], "ua");
        assert.strictEqual(client.backendCount, 0);
        assert.deepStrictEqual(client.getBackendNames(), []);
    });
});
