import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { createPartReportTrace } from "../partReportTrace";
import { StructuredLogger } from "../../../observability/structuredLogger";
import { diagnosticHash } from "../diagnosticHash";
import { createResponsesReasoningState, interpretResponsesReasoningEvent } from "../responsesReasoningEvents";
import { emitV2PartsToVSCode } from "../vscodePartEmitter";

/**
 * The part-report trace is the single host-boundary observer: every part the
 * connector hands to VS Code must produce exactly one `vscode.part_reported`
 * trace line BEFORE the host sees the part, without altering the part or the
 * forwarding order. These tests pin that contract.
 */
suite("partReportTrace", () => {
    let sandbox: sinon.SinonSandbox;
    let traceStub: sinon.SinonStub;

    const context = { requestId: "req-trace-1", model: "test-model", endpoint: "responses" };

    setup(() => {
        sandbox = sinon.createSandbox();
        traceStub = sandbox.stub(StructuredLogger, "trace");
    });

    teardown(() => {
        sandbox.restore();
    });

    function createInner(): {
        parts: vscode.LanguageModelResponsePart[];
        reportSpy: sinon.SinonSpy;
        progress: vscode.Progress<vscode.LanguageModelResponsePart>;
    } {
        const parts: vscode.LanguageModelResponsePart[] = [];
        const reportSpy = sandbox.spy((part: vscode.LanguageModelResponsePart) => {
            parts.push(part);
        });
        return { parts, reportSpy, progress: { report: reportSpy } };
    }

    function partReportedCalls(): sinon.SinonSpyCall[] {
        return traceStub.getCalls().filter((call) => call.args[0] === "vscode.part_reported");
    }

    test("forwards the exact same part instance and reports once per part", () => {
        const inner = createInner();
        const traced = createPartReportTrace(inner.progress, context);
        const text = new vscode.LanguageModelTextPart("hello");

        traced.report(text);

        assert.strictEqual(inner.parts.length, 1);
        assert.strictEqual(inner.parts[0], text, "part must be forwarded by reference, unmodified");
        assert.strictEqual(partReportedCalls().length, 1);
    });

    test("trace line is logged BEFORE the inner progress sees the part", () => {
        const inner = createInner();
        const traced = createPartReportTrace(inner.progress, context);

        traced.report(new vscode.LanguageModelTextPart("ordering"));

        sinon.assert.callOrder(traceStub, inner.reportSpy);
    });

    test("reportSeq increases monotonically across parts and carries correlation options", () => {
        const inner = createInner();
        const traced = createPartReportTrace(inner.progress, context);

        traced.report(new vscode.LanguageModelTextPart("one"));
        traced.report(new vscode.LanguageModelTextPart("two"));
        traced.report(new vscode.LanguageModelTextPart("three"));

        const calls = partReportedCalls();
        assert.strictEqual(calls.length, 3);
        const seqs = calls.map((call) => (call.args[1] as Record<string, unknown>).reportSeq);
        assert.deepStrictEqual(seqs, [1, 2, 3]);
        for (const call of calls) {
            const options = call.args[2] as Record<string, unknown> | undefined;
            assert.strictEqual(options?.requestId, "req-trace-1");
            assert.strictEqual(options?.model, "test-model");
            assert.strictEqual(options?.endpoint, "responses");
        }
    });

    test("records the previous part kind so merge-breaking interleaves are visible", () => {
        const inner = createInner();
        const traced = createPartReportTrace(inner.progress, context);

        traced.report(new vscode.LanguageModelTextPart("a"));
        traced.report(new vscode.LanguageModelTextPart("b"));

        const calls = partReportedCalls();
        assert.strictEqual((calls[0].args[1] as Record<string, unknown>).previousKind, undefined);
        assert.strictEqual((calls[1].args[1] as Record<string, unknown>).previousKind, "text");
    });

    test("describes text parts with length and whitespace flags without exposing their contents", () => {
        const inner = createInner();
        const traced = createPartReportTrace(inner.progress, context);
        const long = "x".repeat(150);

        traced.report(new vscode.LanguageModelTextPart(long));
        traced.report(new vscode.LanguageModelTextPart("   "));

        const calls = partReportedCalls();
        const first = calls[0].args[1] as Record<string, unknown>;
        assert.strictEqual(first.kind, "text");
        assert.strictEqual(first.length, 150);
        assert.strictEqual(first.isEmpty, false);
        assert.ok(!JSON.stringify(first).includes(long));
        assert.ok(!("preview" in first));
        const second = calls[1].args[1] as Record<string, unknown>;
        assert.strictEqual(second.isWhitespaceOnly, true);
    });

    test("thinking parts: string vs array valueKind, idState distinguishes absent from empty, metadata keys only", () => {
        const vscodeWithThinking = vscode as unknown as {
            LanguageModelThinkingPart?: new (
                value: string | string[],
                id?: string,
                metadata?: Record<string, unknown>
            ) => vscode.LanguageModelResponsePart;
        };
        if (!vscodeWithThinking.LanguageModelThinkingPart) {
            return; // proposed API unavailable on this host
        }
        const ThinkingPart = vscodeWithThinking.LanguageModelThinkingPart;
        const inner = createInner();
        const traced = createPartReportTrace(inner.progress, context);

        traced.report(new ThinkingPart("private thought"));
        traced.report(new ThinkingPart(["seg1", "seg2"], ""));
        traced.report(
            new ThinkingPart("", "rs_1", {
                signature: "SECRET",
                encrypted_content: "SECRET2",
                "secret-metadata-key": "hidden",
            })
        );

        const calls = partReportedCalls();
        assert.strictEqual(calls.length, 3);

        const first = calls[0].args[1] as Record<string, unknown>;
        assert.strictEqual(first.kind, "thinking");
        assert.strictEqual(first.valueKind, "string");
        assert.strictEqual(first.idState, "absent");
        assert.ok(!JSON.stringify(first).includes("private thought"));

        const second = calls[1].args[1] as Record<string, unknown>;
        assert.strictEqual(second.valueKind, "array");
        assert.strictEqual(second.segmentCount, 2);
        assert.strictEqual(second.length, 8);
        assert.strictEqual(second.idState, "empty");
        assert.ok(!JSON.stringify(second).includes("seg1"));

        const third = calls[2].args[1] as Record<string, unknown>;
        assert.strictEqual(third.idState, "present");
        assert.match(String(third.id), /^[a-f0-9]{64}$/);
        assert.ok(!JSON.stringify(third).includes("rs_1"));
        assert.strictEqual(third.isEmpty, true);
        assert.strictEqual(third.metadataKeyCount, 3);
        assert.strictEqual(third.hasSignature, true);
        assert.strictEqual(third.hasEncryptedContent, true);
        // Opaque values must never appear anywhere in the logged payload.
        assert.ok(!JSON.stringify(third).includes("SECRET"), "metadata values must not be logged");
        assert.ok(!JSON.stringify(third).includes("secret-metadata-key"));
    });

    test("exposes only allowlisted thinking metadata key identities, never values or unknown keys", () => {
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
        const inner = createInner();
        const metadata = {
            display: "private-display",
            redactedData: "private-redacted",
            signature: "private-signature",
            encrypted_content: "private-encrypted",
            "private-key@example.com": "private-value",
        };
        const part = new vscodeWithThinking.LanguageModelThinkingPart("", undefined, metadata);
        createPartReportTrace(inner.progress, context).report(part);

        const data = partReportedCalls()[0].args[1] as Record<string, unknown>;
        assert.deepStrictEqual(data.metadataKeys, ["display", "encrypted_content", "redactedData", "signature"]);
        assert.strictEqual(data.metadataKeyCount, 5);
        assert.ok(!JSON.stringify(data).includes("private"));
        assert.strictEqual(inner.parts[0], part);

        createPartReportTrace(inner.progress, context).report(
            new vscodeWithThinking.LanguageModelThinkingPart("", undefined, { "private-key": "private-value" })
        );
        const unknownOnly = partReportedCalls()[1].args[1] as Record<string, unknown>;
        assert.deepStrictEqual(unknownOnly.metadataKeys, []);
        assert.strictEqual(unknownOnly.metadataKeyCount, 1);
        assert.ok(!JSON.stringify(unknownOnly).includes("private"));
    });

    test("reasoning identity matches across interpreter, emitter and host trace without exposing it", () => {
        const ctor = (
            vscode as unknown as {
                LanguageModelThinkingPart?: new (
                    value: string | string[],
                    id?: string,
                    metadata?: Record<string, unknown>
                ) => vscode.LanguageModelResponsePart;
            }
        ).LanguageModelThinkingPart;
        if (!ctor) {
            return;
        }
        const id = "private-reasoning-id@example.com";
        const state = createResponsesReasoningState();
        const structured = sandbox.stub(StructuredLogger, "debug");
        interpretResponsesReasoningEvent(
            { type: "response.output_item.added", item: { type: "reasoning", id } },
            state
        );
        const parts = interpretResponsesReasoningEvent(
            { type: "response.output_item.done", item: { type: "reasoning", id, signature: "opaque" } },
            state
        );
        const inner = createInner();
        emitV2PartsToVSCode(parts, createPartReportTrace(inner.progress, context));
        const host = partReportedCalls()[0].args[1] as Record<string, unknown>;
        const emitter = traceStub.getCalls().find((call) => call.args[0] === "vscode.thinking_part_emitted");
        assert.ok(emitter);
        assert.strictEqual(host.id, diagnosticHash(id));
        assert.strictEqual((emitter.args[1] as Record<string, unknown>).id, host.id);
        assert.ok(!JSON.stringify([traceStub.args, structured.args]).includes(id));
        assert.strictEqual((inner.parts[0] as unknown as { id: string }).id, id);
    });

    test("describes tool-call and usage data parts", () => {
        const inner = createInner();
        const traced = createPartReportTrace(inner.progress, context);

        traced.report(
            new vscode.LanguageModelToolCallPart("call_1", "myTool", { "secret-key@example.com": "secret-value", a: 2 })
        );
        const usageBytes = new TextEncoder().encode('{"prompt_tokens":1}');
        traced.report(new vscode.LanguageModelDataPart(usageBytes, "usage"));

        const calls = partReportedCalls();
        const toolData = calls[0].args[1] as Record<string, unknown>;
        assert.strictEqual(toolData.kind, "tool_call");
        assert.match(String(toolData.callId), /^[a-f0-9]{64}$/);
        assert.strictEqual(toolData.toolName, diagnosticHash("myTool"));
        assert.strictEqual(toolData.inputKeyCount, 2);
        assert.ok(!JSON.stringify(toolData).includes("secret-key@example.com"));
        assert.ok(!JSON.stringify(toolData).includes("secret-value"));

        const usageData = calls[1].args[1] as Record<string, unknown>;
        assert.strictEqual(usageData.kind, "data");
        assert.strictEqual(usageData.mimeType, diagnosticHash("usage"));
        assert.strictEqual(usageData.isUsage, true);
        assert.strictEqual(usageData.byteLength, usageBytes.byteLength);
    });

    test("hashes untrusted tool names and MIME types consistently without changing host parts", () => {
        const inner = createInner();
        const traced = createPartReportTrace(inner.progress, context);
        const tool = new vscode.LanguageModelToolCallPart("id", "private-tool@example.com", {});
        const data = new vscode.LanguageModelDataPart(new Uint8Array([1]), "private-mime@example.com");
        traced.report(tool);
        traced.report(data);
        const calls = partReportedCalls();
        assert.strictEqual((calls[0].args[1] as Record<string, unknown>).toolName, diagnosticHash(tool.name));
        assert.strictEqual((calls[1].args[1] as Record<string, unknown>).mimeType, diagnosticHash(data.mimeType));
        assert.ok(!JSON.stringify(calls.map((call) => call.args as unknown[])).includes("private-"));
        assert.deepStrictEqual(inner.parts, [tool, data]);
    });

    test("a throwing logger never blocks part forwarding", () => {
        traceStub.throws(new Error("logger exploded"));
        const inner = createInner();
        const traced = createPartReportTrace(inner.progress, context);

        traced.report(new vscode.LanguageModelTextPart("must still arrive"));

        assert.strictEqual(inner.parts.length, 1, "diagnostics must never break the stream");
    });

    test("two trace wrappers keep independent sequences (concurrent requests)", () => {
        const innerA = createInner();
        const innerB = createInner();
        const tracedA = createPartReportTrace(innerA.progress, { ...context, requestId: "req-A" });
        const tracedB = createPartReportTrace(innerB.progress, { ...context, requestId: "req-B" });

        tracedA.report(new vscode.LanguageModelTextPart("a1"));
        tracedB.report(new vscode.LanguageModelTextPart("b1"));
        tracedA.report(new vscode.LanguageModelTextPart("a2"));

        const calls = partReportedCalls();
        const forA = calls.filter((call) => (call.args[2] as Record<string, unknown>).requestId === "req-A");
        const forB = calls.filter((call) => (call.args[2] as Record<string, unknown>).requestId === "req-B");
        assert.deepStrictEqual(
            forA.map((call) => (call.args[1] as Record<string, unknown>).reportSeq),
            [1, 2]
        );
        assert.deepStrictEqual(
            forB.map((call) => (call.args[1] as Record<string, unknown>).reportSeq),
            [1]
        );
    });
});
