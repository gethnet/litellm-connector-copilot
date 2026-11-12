import * as vscode from "vscode";
import * as sinon from "sinon";
import * as assert from "assert";
import { emitV2PartsToVSCode } from "../vscodePartEmitter";
import { Logger } from "../../../utils/logger";
import { StructuredLogger } from "../../../observability/structuredLogger";
import { diagnosticHash } from "../diagnosticHash";

suite("vscodePartEmitter", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("correlates every emitter event including fallback and parse failure, without requiring context", () => {
        const trace = sandbox.stub(StructuredLogger, "trace");
        const debug = sandbox.stub(StructuredLogger, "debug");
        const warn = sandbox.stub(StructuredLogger, "warn");
        const context = { requestId: "emitter-request", model: "model", endpoint: "chat" };
        const emit = emitV2PartsToVSCode as unknown as (
            parts: Parameters<typeof emitV2PartsToVSCode>[0],
            progress: vscode.Progress<vscode.LanguageModelResponsePart>,
            constructor: null,
            logContext?: typeof context
        ) => void;
        const reported: vscode.LanguageModelResponsePart[] = [];
        const progress = { report: (part: vscode.LanguageModelResponsePart) => reported.push(part) };
        emit(
            [
                { type: "text", value: "first" },
                { type: "thinking", value: "thought" },
                { type: "tool_call", index: 0, id: "call", name: "tool", args: "{" },
                { type: "data", mimeType: "application/vnd.cache-control+json", value: {} },
                { type: "finish", reason: "stop" },
            ],
            progress,
            null,
            context
        );
        const calls = [...trace.getCalls(), ...debug.getCalls(), ...warn.getCalls()].filter((call) =>
            String(call.args[0]).startsWith("vscode.")
        );
        assert.ok(calls.length >= 7);
        for (const call of calls) {
            assert.deepStrictEqual(call.args[2], context, String(call.args[0]));
        }
        assert.strictEqual(reported.length, 3);
        trace.resetHistory();
        emit([{ type: "text", value: "legacy" }], progress, null);
        assert.strictEqual(trace.firstCall.args[2], undefined);
    });

    test("logs warning and emits empty args on tool-call argument parse failure", () => {
        const warnStub = sandbox.stub(Logger, "warn");
        const reported: unknown[] = [];
        const progress = {
            report: (p: unknown) => reported.push(p),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitV2PartsToVSCode(
            [{ type: "tool_call", index: 0, id: "call_1", name: "t1", args: "{invalid json" }],
            progress
        );

        sinon.assert.calledOnce(warnStub);
        const callArgs = warnStub.firstCall.args;
        assert.ok((callArgs[0] as string).includes("Failed to parse tool call arguments"));
        const fields = callArgs[1] as Record<string, unknown>;
        assert.strictEqual(fields.toolName, diagnosticHash("t1"));
        assert.strictEqual(fields.id, diagnosticHash("call_1"));

        assert.strictEqual(reported.length, 1);
        assert.ok(reported[0] instanceof vscode.LanguageModelToolCallPart);
        const part = reported[0] as vscode.LanguageModelToolCallPart;
        assert.strictEqual(part.name, "t1");
        assert.strictEqual(part.callId, "call_1");
        assert.deepStrictEqual(part.input, {});
    });

    test("both loggers hash untrusted names and MIME types on success, failure, and dropped carriers", () => {
        const structured = sandbox.stub(StructuredLogger, "log");
        const trace = sandbox.stub(Logger, "trace");
        const warn = sandbox.stub(Logger, "warn");
        const name = "private-tool@example.com";
        const mime = "text/private-mime@example.com";
        const cacheMime = "application/cache-control-private@example.com";
        const reported: vscode.LanguageModelResponsePart[] = [];
        emitV2PartsToVSCode(
            [
                { type: "tool_call", index: 0, id: "1", name, args: "{}" },
                { type: "tool_call", index: 1, id: "2", name, args: "{" },
                { type: "data", mimeType: mime, value: "value" },
                { type: "data", mimeType: cacheMime, value: "value" },
            ],
            { report: (part) => reported.push(part) }
        );
        const logs = JSON.stringify([structured.args, trace.args, warn.args]);
        assert.ok(!logs.includes(name));
        assert.ok(!logs.includes(mime));
        assert.ok(!logs.includes(cacheMime));
        assert.ok(logs.includes(String(diagnosticHash(name))));
        assert.ok(logs.includes(String(diagnosticHash(mime))));
        assert.ok(logs.includes(String(diagnosticHash(cacheMime))));
        assert.strictEqual((reported[0] as vscode.LanguageModelToolCallPart).name, name);
        assert.strictEqual((reported[1] as vscode.LanguageModelToolCallPart).name, name);
        assert.strictEqual((reported[2] as vscode.LanguageModelDataPart).mimeType, mime);
        assert.strictEqual(reported.length, 3);
    });

    test("emitter diagnostics omit malformed arguments and untrusted usage payloads", () => {
        const structured = sandbox.stub(StructuredLogger, "log");
        const warning = sandbox.stub(Logger, "warn");
        const reported: vscode.LanguageModelResponsePart[] = [];
        emitV2PartsToVSCode(
            [
                { type: "tool_call", index: 0, id: "call", name: "tool", args: '{"secret":"private-tool-secret"' },
                { type: "data", mimeType: "usage", value: '{"opaque":"private-usage-secret"}' },
            ],
            { report: (part) => reported.push(part) }
        );
        assert.strictEqual(reported.length, 2);
        const logs = JSON.stringify([
            ...structured.getCalls().map((call) => call.args),
            ...warning.getCalls().map((call) => call.args),
        ]);
        assert.ok(!logs.includes("private-tool-secret"));
        assert.ok(!logs.includes("private-usage-secret"));
        assert.ok(structured.getCalls().some((call) => call.args[1] === "vscode.tool_call_parse_failed"));
    });

    test("successful tool calls log only the argument key count, not sensitive keys or values", () => {
        const structured = sandbox.stub(StructuredLogger, "trace");
        const trace = sandbox.stub(Logger, "trace");
        const reported: vscode.LanguageModelResponsePart[] = [];
        const input = { "private-key@example.com": "private-value", regular: 2 };
        emitV2PartsToVSCode([{ type: "tool_call", index: 0, id: "call", name: "tool", args: JSON.stringify(input) }], {
            report: (part) => reported.push(part),
        });

        assert.strictEqual(reported.length, 1);
        assert.deepStrictEqual((reported[0] as vscode.LanguageModelToolCallPart).input, input);
        const event = structured.getCalls().find((call) => call.args[0] === "vscode.tool_call_part_emitted");
        assert.ok(event);
        assert.strictEqual((event.args[1] as Record<string, unknown>).argKeyCount, 2);
        assert.ok(trace.getCalls().some((call) => String(call.args[0]).includes("key count: 2")));
        const logs = JSON.stringify([...structured.args, ...trace.args]);
        assert.ok(!logs.includes("private-key@example.com"));
        assert.ok(!logs.includes("private-value"));
        assert.ok(!logs.includes("regular"));
    });

    test("finish diagnostics never expose an arbitrary upstream reason", () => {
        const structured = sandbox.stub(StructuredLogger, "log");
        const debug = sandbox.stub(Logger, "debug");
        emitV2PartsToVSCode([{ type: "finish", reason: "secret-reason" }], { report: () => undefined });
        assert.ok(!JSON.stringify([...structured.args, ...debug.args]).includes("secret-reason"));
        assert.ok(JSON.stringify(structured.args).includes("unknown"));
    });

    test("response metadata diagnostics reject malformed upstream usage values", () => {
        const structured = sandbox.stub(StructuredLogger, "log");
        emitV2PartsToVSCode(
            [{ type: "response", usage: { inputTokens: "secret-usage" as unknown as number, outputTokens: 2 } }],
            { report: () => undefined }
        );
        assert.ok(!JSON.stringify(structured.args).includes("secret-usage"));
        assert.ok(JSON.stringify(structured.args).includes('"outputTokens":2'));
    });

    test("suppresses cache-control data parts before reporting to VS Code", () => {
        const reported: unknown[] = [];
        const progress = {
            report: (p: unknown) => reported.push(p),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitV2PartsToVSCode(
            [
                {
                    type: "data",
                    mimeType: "application/vnd.cache-control+json",
                    value: { $mid: 24, mimeType: "cache_control", data: "ZXBoZW1lcmFs" },
                },
                { type: "text", value: "cache_control is legitimate text here" },
            ],
            progress
        );

        assert.strictEqual(reported.length, 1);
        assert.ok(reported[0] instanceof vscode.LanguageModelTextPart);
        assert.strictEqual(
            (reported[0] as vscode.LanguageModelTextPart).value,
            "cache_control is legitimate text here"
        );
    });

    test("emits usage data parts with the raw usage mimetype", () => {
        const reported: unknown[] = [];
        const progress = {
            report: (p: unknown) => reported.push(p),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitV2PartsToVSCode(
            [
                {
                    type: "data",
                    mimeType: "usage",
                    value: {
                        prompt_tokens: 11,
                        completion_tokens: 7,
                        total_tokens: 18,
                        prompt_tokens_details: {
                            cached_tokens: 3,
                        },
                        completion_tokens_details: {
                            reasoning_tokens: 4,
                        },
                    },
                },
            ],
            progress
        );

        assert.strictEqual(reported.length, 1);
        assert.ok(reported[0] instanceof vscode.LanguageModelDataPart);
        const part = reported[0] as vscode.LanguageModelDataPart;
        assert.strictEqual(part.mimeType, "usage");
        assert.deepStrictEqual(JSON.parse(Buffer.from(part.data).toString("utf-8")), {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18,
            prompt_tokens_details: {
                cached_tokens: 3,
            },
            completion_tokens_details: {
                reasoning_tokens: 4,
            },
        });
    });

    test("handles text part with non-string value", () => {
        const reported: unknown[] = [];
        const progress = {
            report: (p: unknown) => reported.push(p),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitV2PartsToVSCode([{ type: "text", value: 12345 } as unknown as { type: "text"; value: string }], progress);

        assert.strictEqual(reported.length, 1);
        assert.ok(reported[0] instanceof vscode.LanguageModelTextPart);
        assert.strictEqual((reported[0] as vscode.LanguageModelTextPart).value, "12345");
    });

    test("emits data parts with non-text mimeType as opaque binary", () => {
        const reported: unknown[] = [];
        const progress = {
            report: (p: unknown) => reported.push(p),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitV2PartsToVSCode([{ type: "data", mimeType: "application/octet-stream", value: { raw: "data" } }], progress);

        assert.strictEqual(reported.length, 1);
        assert.ok(reported[0] instanceof vscode.LanguageModelDataPart);
    });

    test("ignores response and finish parts", () => {
        const reported: unknown[] = [];
        const progress = {
            report: (p: unknown) => reported.push(p),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitV2PartsToVSCode(
            [
                { type: "response" } as unknown as { type: "text"; value: string },
                { type: "finish" } as unknown as { type: "text"; value: string },
                { type: "text", value: "after" },
            ],
            progress
        );

        assert.strictEqual(reported.length, 1);
        assert.ok(reported[0] instanceof vscode.LanguageModelTextPart);
        assert.strictEqual((reported[0] as vscode.LanguageModelTextPart).value, "after");
    });

    test("emits usage data parts with string value", () => {
        const reported: unknown[] = [];
        const progress = {
            report: (p: unknown) => reported.push(p),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitV2PartsToVSCode([{ type: "data", mimeType: "usage", value: '{"tokens": 10}' }], progress);

        assert.strictEqual(reported.length, 1);
        assert.ok(reported[0] instanceof vscode.LanguageModelDataPart);
        assert.strictEqual((reported[0] as vscode.LanguageModelDataPart).mimeType, "usage");
    });

    test("preserves thinking value, id, and opaque metadata when VS Code supports thinking parts", () => {
        const vscodeWithThinking = vscode as unknown as {
            LanguageModelThinkingPart?: new (
                value: string | string[],
                id?: string,
                metadata?: Record<string, unknown>
            ) => vscode.LanguageModelResponsePart;
        };
        if (!vscodeWithThinking.LanguageModelThinkingPart) {
            return;
        }

        const reported: vscode.LanguageModelResponsePart[] = [];
        const progress = {
            report: (part: vscode.LanguageModelResponsePart) => reported.push(part),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;
        const metadata = {
            encrypted_content: "signed-thinking-state",
            display: "omitted",
        };

        emitV2PartsToVSCode(
            [
                {
                    type: "thinking",
                    value: "A visible thought summary.",
                    id: "thought-1",
                    metadata,
                },
            ],
            progress
        );

        assert.strictEqual(reported.length, 1);
        const part = reported[0] as unknown as {
            value?: string | string[];
            id?: string;
            metadata?: Record<string, unknown>;
        };
        assert.strictEqual(part.value, "A visible thought summary.");
        assert.strictEqual(part.id, "thought-1");
        assert.deepStrictEqual(part.metadata, metadata);
    });

    test("falls back to *-wrapped text when LanguageModelThinkingPart is unavailable", () => {
        const reported: vscode.LanguageModelResponsePart[] = [];
        const progress = {
            report: (part: vscode.LanguageModelResponsePart) => reported.push(part),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitV2PartsToVSCode([{ type: "thinking", value: "hidden reasoning" }], progress, null);

        assert.strictEqual(reported.length, 1, "thinking must not be silently dropped");
        assert.ok(reported[0] instanceof vscode.LanguageModelTextPart);
        assert.strictEqual((reported[0] as vscode.LanguageModelTextPart).value, "*hidden reasoning*");
    });

    test("skips fallback emission for metadata-only thinking parts when ThinkingPart is unavailable", () => {
        const reported: vscode.LanguageModelResponsePart[] = [];
        const progress = {
            report: (part: vscode.LanguageModelResponsePart) => reported.push(part),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitV2PartsToVSCode([{ type: "thinking", value: "", metadata: { signature: "sig" } }], progress, null);

        assert.strictEqual(reported.length, 0, "empty-value signature parts have no text to fall back to");
    });
});
