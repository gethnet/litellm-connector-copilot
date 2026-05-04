import * as vscode from "vscode";
import * as sinon from "sinon";
import * as assert from "assert";
import { emitV2PartsToVSCode } from "../vscodePartEmitter";
import { Logger } from "../../../utils/logger";

suite("vscodePartEmitter", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("logs warning and emits empty args on tool-call argument parse failure", () => {
        // After fix: invalid args must not be forwarded to VS Code as {}.
        // The emitter must warn and silently discard the corrupted tool call.
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
        assert.ok(
            (callArgs[0] as string).includes("Dropping tool call"),
            "Warning message must indicate the call was dropped"
        );
        const fields = callArgs[1] as Record<string, unknown>;
        assert.strictEqual(fields.toolName, "t1");
        assert.strictEqual(fields.id, "call_1");

        // Must NOT forward the corrupted call to VS Code
        assert.strictEqual(reported.length, 0, "Must not report anything to VS Code for a corrupted tool call");
    });

    test("does NOT emit a tool call with empty args on parse failure — throws or skips entirely", () => {
        // Regression: previously emitted LanguageModelToolCallPart(id, name, {}) on parse failure.
        // After the fix the emitter must NOT forward the corrupted call to VS Code.
        // (The interpreter now blocks invalid JSON before it reaches the emitter, but the emitter
        //  must also be hardened as a second line of defense.)
        const warnStub = sandbox.stub(Logger, "warn");
        const reported: unknown[] = [];
        const progress = {
            report: (p: unknown) => reported.push(p),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitV2PartsToVSCode(
            [{ type: "tool_call", index: 0, id: "call_bad", name: "corrupt_tool", args: "{invalid json" }],
            progress
        );

        // Must NOT forward a tool call with {} args to VS Code
        assert.strictEqual(reported.length, 0, "Emitter must not forward a tool call with unparseable args to VS Code");
        // Must log a warning so the failure is visible
        sinon.assert.calledOnce(warnStub);
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
});
