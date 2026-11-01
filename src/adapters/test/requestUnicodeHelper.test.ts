import * as assert from "assert";
import * as sinon from "sinon";
import { StructuredLogger } from "../../observability/structuredLogger";
import { normalizeRequestUnicode } from "../requestUnicode";

suite("Request Unicode helper", () => {
    test("repairs classified strings once and never mutates input", () => {
        const warn = sinon.stub(StructuredLogger, "warn");
        try {
            const input = {
                model: "m",
                prompt: "p\ud800",
                stop: ["s\udc00"],
                messages: [{ role: "user", content: "t\ud800 🔧 \\ud800" }],
            };
            const once = normalizeRequestUnicode(input);
            assert.strictEqual(once.prompt, "p�");
            assert.deepStrictEqual(once.stop, ["s�"]);
            assert.strictEqual(once.messages[0].content, "t� 🔧 \\ud800");
            assert.strictEqual(input.prompt, "p\ud800");
            assert.deepStrictEqual(normalizeRequestUnicode(once), once);
            assert.deepStrictEqual(warn.firstCall.args, ["request.unicode_repaired", { stringCount: 3 }]);
            assert.strictEqual(warn.callCount, 1);
        } finally {
            warn.restore();
        }
    });

    test("preserves valid argument bytes and rejects invalid parsed keys and values", () => {
        const make = (args: string) => ({
            model: "m",
            messages: [{ role: "assistant", tool_calls: [{ function: { arguments: args } }] }],
        });
        const valid = String.raw`{ "s": "\\ud800", "pair": "\ud83d\udd27" }`;
        assert.strictEqual(normalizeRequestUnicode(make(valid)).messages[0].tool_calls[0].function.arguments, valid);
        for (const invalid of [String.raw`{"content":"\ud800"}`, String.raw`{"\udc00":"x"}`, "{"]) {
            assert.throws(() => normalizeRequestUnicode(make(invalid)), /invalid UTF-16.*Start a new chat/i);
        }
    });

    test("does not warn if an opaque value rejects the request", () => {
        const warn = sinon.stub(StructuredLogger, "warn");
        try {
            assert.throws(() => normalizeRequestUnicode({ prompt: "x\ud800", model: "m\ud800" }), /invalid UTF-16/i);
            assert.throws(() => normalizeRequestUnicode({ "messages.*.content": "x\ud800" }), /invalid UTF-16/i);
            assert.throws(
                () =>
                    normalizeRequestUnicode({
                        messages: [{ role: "user", content: [{ type: "image_url", text: "x\ud800" }] }],
                    }),
                /invalid UTF-16/i
            );
            assert.strictEqual(warn.callCount, 0);
        } finally {
            warn.restore();
        }
    });
});
