import * as assert from "assert";
import { sanitizeTerminalFrame } from "../terminalFrameDump";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

/**
 * The sanitized terminal-frame dump exists because bridges (LiteLLM azure_ai,
 * wolfram proxy) emit non-completed terminals with the real stop cause under
 * nonstandard keys that our selective extraction misses, and payload logging
 * truncates at ~200 chars. The dump must therefore preserve UNKNOWN keys
 * verbatim while stripping the bulky/PII-bearing `output` content.
 */
suite("terminalFrameDump", () => {
    test("preserves unknown top-level keys verbatim (the whole point)", () => {
        const frame = {
            status: "incomplete",
            stop_reason: "classifier_interrupt", // nonstandard bridge key
            some_bridge_field: { nested: true },
            usage: { input_tokens: 10, output_tokens: 2 },
        };

        const dump = sanitizeTerminalFrame(frame);

        assert.strictEqual(dump.stop_reason, "classifier_interrupt");
        assert.deepStrictEqual(dump.some_bridge_field, { nested: true });
        assert.strictEqual(dump.status, "incomplete");
        assert.deepStrictEqual(dump.usage, { input_tokens: 10, output_tokens: 2 });
    });

    test("replaces the output array with per-item type/status summaries", () => {
        // `output` re-carries the full generated content (text, reasoning) —
        // bulky and potentially user data. Summaries keep the shape visible
        // without logging the content.
        const frame = {
            status: "incomplete",
            output: [
                { type: "reasoning", status: "in_progress", summary: [{ type: "summary_text", text: "secret" }] },
                { type: "message", status: "incomplete", content: [{ type: "output_text", text: "user data" }] },
            ],
        };

        const dump = sanitizeTerminalFrame(frame);

        assert.deepStrictEqual(dump.output, [
            { type: "reasoning", status: "in_progress" },
            { type: "message", status: "incomplete" },
        ]);
        assert.ok(!JSON.stringify(dump).includes("secret"));
        assert.ok(!JSON.stringify(dump).includes("user data"));
    });

    test("drops the instructions field (system prompt echo)", () => {
        const frame = { status: "failed", instructions: "You are a helpful assistant..." };

        const dump = sanitizeTerminalFrame(frame);

        assert.strictEqual("instructions" in dump, false);
        assert.strictEqual(dump.status, "failed");
    });

    test("tolerates undefined and non-object frames", () => {
        assert.deepStrictEqual(sanitizeTerminalFrame(undefined), {});
        assert.deepStrictEqual(sanitizeTerminalFrame("weird" as unknown as Record<string, unknown>), {});
    });

    test("tolerates a malformed output field that is not an array", () => {
        const frame = { status: "incomplete", output: "not-an-array" };

        const dump = sanitizeTerminalFrame(frame);

        // Malformed shapes are themselves a triage signal — keep them as-is.
        assert.strictEqual(dump.output, "not-an-array");
    });
});
