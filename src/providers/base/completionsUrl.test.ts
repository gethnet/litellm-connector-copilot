import * as assert from "assert";
import { deriveCompletionsUrl, resolveCompletionsUrl } from "./completionsUrl";

suite("Completion URL resolution", () => {
    test("preserves the configured group path when deriving the default endpoint", () => {
        assert.strictEqual(deriveCompletionsUrl("https://llm.proxy.com/v1"), "https://llm.proxy.com/v1/completions");
        assert.strictEqual(deriveCompletionsUrl("https://llm.proxy.com"), "https://llm.proxy.com/completions");
    });

    test("uses the highest-priority model URL before group and derived URLs", () => {
        assert.strictEqual(
            resolveCompletionsUrl(
                "https://llm.proxy.com/v1",
                "https://model.proxy.com/fim",
                "https://group.proxy.com/fim"
            ),
            "https://model.proxy.com/fim"
        );
        assert.strictEqual(
            resolveCompletionsUrl("https://llm.proxy.com/v1", undefined, "https://group.proxy.com/fim"),
            "https://group.proxy.com/fim"
        );
        assert.strictEqual(
            resolveCompletionsUrl("https://llm.proxy.com/v1", undefined, undefined),
            "https://llm.proxy.com/v1/completions"
        );
    });

    test("does not accept non-http completion URLs", () => {
        assert.strictEqual(deriveCompletionsUrl("file:///tmp/litellm"), undefined);
        assert.strictEqual(
            resolveCompletionsUrl("https://llm.proxy.com", "file:///tmp/fim", undefined),
            "https://llm.proxy.com/completions"
        );
    });
});
