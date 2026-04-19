import * as assert from "assert";
import { TEST_USER_AGENT, createMockSecrets, createMockModel, createMockOutputChannel } from "./testMocks";

suite("Test Mocks Unit Tests", () => {
    suite("TEST_USER_AGENT", () => {
        test("is a non-empty string", () => {
            assert.ok(typeof TEST_USER_AGENT === "string");
            assert.ok(TEST_USER_AGENT.length > 0);
        });
    });

    suite("createMockSecrets", () => {
        test("returns default baseUrl and apiKey when called with no args", async () => {
            const secrets = createMockSecrets();
            assert.strictEqual(await secrets.get("baseUrl"), "http://localhost:4000");
            assert.strictEqual(await secrets.get("apiKey"), "test-key");
        });

        test("accepts custom baseUrl and apiKey overrides", async () => {
            const secrets = createMockSecrets(undefined, "https://custom:9090", "my-key");
            assert.strictEqual(await secrets.get("baseUrl"), "https://custom:9090");
            assert.strictEqual(await secrets.get("apiKey"), "my-key");
        });

        test("accepts a plain object for entries", async () => {
            const secrets = createMockSecrets({ foo: "bar", baz: "qux" });
            assert.strictEqual(await secrets.get("foo"), "bar");
            assert.strictEqual(await secrets.get("baz"), "qux");
            assert.strictEqual(await secrets.get("baseUrl"), undefined);
        });

        test("accepts a Map for entries", async () => {
            const entries = new Map<string, string>([
                ["alpha", "1"],
                ["beta", "2"],
            ]);
            const secrets = createMockSecrets(entries);
            assert.strictEqual(await secrets.get("alpha"), "1");
            assert.strictEqual(await secrets.get("beta"), "2");
        });

        test("store sets a value", async () => {
            const secrets = createMockSecrets();
            await secrets.store("newKey", "newValue");
            assert.strictEqual(await secrets.get("newKey"), "newValue");
        });

        test("delete removes a value", async () => {
            const secrets = createMockSecrets();
            await secrets.store("temp", "value");
            assert.strictEqual(await secrets.get("temp"), "value");
            await secrets.delete("temp");
            assert.strictEqual(await secrets.get("temp"), undefined);
        });

        test("keys returns all stored keys", async () => {
            const secrets = createMockSecrets();
            const keys = await secrets.keys();
            assert.ok(keys.includes("baseUrl"));
            assert.ok(keys.includes("apiKey"));
        });

        test("keys reflects store and delete", async () => {
            const secrets = createMockSecrets();
            await secrets.store("extra", "val");
            let keys = await secrets.keys();
            assert.ok(keys.includes("extra"));

            await secrets.delete("extra");
            keys = await secrets.keys();
            assert.ok(!keys.includes("extra"));
        });

        test("onDidChange returns a disposable", () => {
            const secrets = createMockSecrets();
            const disposable = secrets.onDidChange(() => {});
            assert.ok(typeof disposable.dispose === "function");
            disposable.dispose();
        });
    });

    suite("createMockModel", () => {
        test("returns sensible defaults", () => {
            const model = createMockModel();
            assert.strictEqual(model.id, "gpt-4o");
            assert.strictEqual(model.family, "gpt-4o");
            assert.strictEqual(model.name, "GPT-4o");
            assert.strictEqual(model.maxInputTokens, 128000);
        });

        test("applies overrides on top of defaults", () => {
            const model = createMockModel({
                id: "llama-3",
                name: "Llama 3",
                maxInputTokens: 8192,
            });
            assert.strictEqual(model.id, "llama-3");
            assert.strictEqual(model.name, "Llama 3");
            assert.strictEqual(model.maxInputTokens, 8192);
            assert.strictEqual(model.family, "gpt-4o");
        });

        test("partial overrides preserve unspecified fields", () => {
            const model = createMockModel({ id: "custom-model" });
            assert.strictEqual(model.id, "custom-model");
            assert.strictEqual(model.family, "gpt-4o");
            assert.strictEqual(model.name, "GPT-4o");
        });
    });

    suite("createMockOutputChannel", () => {
        test("returns object with expected log-level methods", () => {
            const channel = createMockOutputChannel();
            assert.strictEqual(channel.name, "mock");
            assert.strictEqual(typeof channel.trace, "function");
            assert.strictEqual(typeof channel.debug, "function");
            assert.strictEqual(typeof channel.info, "function");
            assert.strictEqual(typeof channel.warn, "function");
            assert.strictEqual(typeof channel.error, "function");
        });

        test("returns object with expected UI methods", () => {
            const channel = createMockOutputChannel();
            assert.strictEqual(typeof channel.show, "function");
            assert.strictEqual(typeof channel.hide, "function");
            assert.strictEqual(typeof channel.clear, "function");
            assert.strictEqual(typeof channel.dispose, "function");
        });

        test("returns object with expected content methods", () => {
            const channel = createMockOutputChannel();
            assert.strictEqual(typeof channel.append, "function");
            assert.strictEqual(typeof channel.appendLine, "function");
            assert.strictEqual(typeof channel.replace, "function");
        });

        test("all methods are safe no-ops (do not throw)", () => {
            const channel = createMockOutputChannel();
            assert.doesNotThrow(() => channel.trace("test"));
            assert.doesNotThrow(() => channel.debug("test"));
            assert.doesNotThrow(() => channel.info("test"));
            assert.doesNotThrow(() => channel.warn("test"));
            assert.doesNotThrow(() => channel.error("test"));
            assert.doesNotThrow(() => channel.error(new Error("test")));
            assert.doesNotThrow(() => channel.show());
            assert.doesNotThrow(() => channel.hide());
            assert.doesNotThrow(() => channel.clear());
            assert.doesNotThrow(() => channel.append("test"));
            assert.doesNotThrow(() => channel.appendLine("test"));
            assert.doesNotThrow(() => channel.replace("test"));
            assert.doesNotThrow(() => channel.dispose());
        });
    });
});
