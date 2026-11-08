import * as assert from "assert";
import { sanitizeTerminalFrame } from "../terminalFrameDump";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

/**
 * The sanitized terminal-frame dump exists because bridges (LiteLLM azure_ai,
 * wolfram proxy) emit non-completed terminals with the real stop cause under
 * nonstandard keys that our selective extraction misses, and payload logging
 * truncates at ~200 chars. The dump preserves safe structural diagnostics,
 * never untrusted values or keys supplied by the bridge.
 */
suite("terminalFrameDump", () => {
    test("unknown bridge causes have deterministic distinct key and value fingerprints without exposing content", () => {
        const first = sanitizeTerminalFrame({
            status: "incomplete",
            "private-bridge-key": { "private-inner-key": "private-cause-a" },
        });
        const repeat = sanitizeTerminalFrame({
            status: "incomplete",
            "private-bridge-key": { "private-inner-key": "private-cause-a" },
        });
        const changedValue = sanitizeTerminalFrame({
            status: "incomplete",
            "private-bridge-key": { "private-inner-key": "private-cause-b" },
        });
        const changedKey = sanitizeTerminalFrame({
            status: "incomplete",
            "private-other-key": { "private-inner-key": "private-cause-a" },
        });
        assert.ok(Array.isArray(first.unknownDiagnostics));
        assert.ok(first.unknownDiagnostics.length > 0);
        assert.deepStrictEqual(first.unknownDiagnostics, repeat.unknownDiagnostics);
        assert.notDeepStrictEqual(first.unknownDiagnostics, changedValue.unknownDiagnostics);
        assert.notDeepStrictEqual(first.unknownDiagnostics, changedKey.unknownDiagnostics);
        assert.ok(!JSON.stringify([first, repeat, changedValue, changedKey]).includes("private"));
    });

    test("unknown stop reasons and nested error causes remain distinguishable without raw values", () => {
        const first = sanitizeTerminalFrame({
            stop_reason: "private-stop-a",
            error: { code: "private-code", message: "private-message" },
            incomplete_details: { reason: "private-reason-a" },
        });
        const second = sanitizeTerminalFrame({
            stop_reason: "private-stop-b",
            error: { code: "private-code", message: "private-message" },
            incomplete_details: { reason: "private-reason-b" },
        });
        assert.ok(Array.isArray(first.unknownDiagnostics));
        assert.notDeepStrictEqual(first.unknownDiagnostics, second.unknownDiagnostics);
        assert.ok(!JSON.stringify([first, second]).includes("private"));
    });

    test("known incomplete reasons stay readable while unknown diagnostics distinguish individual fields", () => {
        const frame = { incomplete_details: { reason: "max_output_tokens" }, alpha: "first", beta: "second" };
        const dump = sanitizeTerminalFrame(frame);
        assert.strictEqual(dump.incompleteReason, "max_output_tokens");
        const diagnostics = dump.unknownDiagnostics as { keyHash: string; valueHash: string }[];
        assert.strictEqual(diagnostics.length, 2);
        assert.match(diagnostics[0].keyHash, /^[a-f0-9]{64}$/);
        assert.match(diagnostics[0].valueHash, /^[a-f0-9]{64}$/);
        assert.notStrictEqual(diagnostics[0].keyHash, diagnostics[1].keyHash);
        assert.notStrictEqual(diagnostics[0].valueHash, diagnostics[1].valueHash);
        assert.ok(!JSON.stringify(dump).includes("first"));
        assert.ok(!JSON.stringify(dump).includes("second"));
    });

    test("retains the known classifier stop cause and counts unknown bridge fields", () => {
        const dump = sanitizeTerminalFrame({
            status: "incomplete",
            stop_reason: "classifier_interrupt",
            some_bridge_field: { nested: true },
            usage: { input_tokens: 10, output_tokens: 2 },
        });

        assert.strictEqual(dump.stop_reason, "classifier_interrupt");
        assert.strictEqual(dump.unknownFieldCount, 1);
        assert.ok(!JSON.stringify(dump).includes("some_bridge_field"));
        assert.deepStrictEqual(dump.usage, { input_tokens: 10, output_tokens: 2 });
    });

    test("counts unknown stop causes without exposing their values or other unknown keys", () => {
        for (const stopReason of ["private-stop-cause", { "private-nested-key": "private-value" }, null]) {
            const dump = sanitizeTerminalFrame({ stop_reason: stopReason, "private-key": "private-value" });
            assert.strictEqual(dump.unknownFieldCount, 1);
            assert.strictEqual(dump.unknownValueCount, 1);
            assert.ok(!JSON.stringify(dump).includes("private"));
        }
    });

    test("preserves other allowlisted stop causes exactly", () => {
        for (const stopReason of [
            "content_filter",
            "end_turn",
            "length",
            "max_output_tokens",
            "max_tokens",
            "stop",
            "stop_sequence",
            "tool_use",
        ]) {
            assert.deepStrictEqual(sanitizeTerminalFrame({ stop_reason: stopReason }), { stop_reason: stopReason });
        }
        assert.deepStrictEqual(sanitizeTerminalFrame({}), {});
    });

    test("preserves safe structure and counts while dropping unknown nested fields", () => {
        const frame = {
            status: "incomplete",
            "secret-key@example.com": { nested: "secret-nested" },
            error: { code: "secret-code", message: "secret-message", nested: { token: "secret-token" } },
            usage: { input_tokens: 10, output_tokens: 2, unknown: "secret-usage" },
        };

        const dump = sanitizeTerminalFrame(frame);

        assert.strictEqual(dump.status, "incomplete");
        assert.deepStrictEqual(dump.usage, { input_tokens: 10, output_tokens: 2 });
        assert.strictEqual(dump.hasError, true);
        assert.strictEqual(dump.unknownFieldCount, 1);
        assert.ok(!JSON.stringify(dump).includes("secret"));
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

        assert.strictEqual(dump.outputKind, "string");
        assert.ok(!JSON.stringify(dump).includes("not-an-array"));
    });

    test("does not trust values even in known status, item and usage fields", () => {
        const dump = sanitizeTerminalFrame({
            status: "secret-status",
            output: [{ type: "secret-type", status: "secret-item-status" }],
            usage: { input_tokens: "secret-input", output_tokens: 3 },
        });
        assert.ok(!JSON.stringify(dump).includes("secret"));
        assert.deepStrictEqual(dump.usage, { output_tokens: 3 });
    });
});
