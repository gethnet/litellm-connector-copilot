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
        assert.strictEqual(fields.toolName, "t1");
        assert.strictEqual(fields.id, "call_1");

        assert.strictEqual(reported.length, 1);
        assert.ok(reported[0] instanceof vscode.LanguageModelToolCallPart);
        const part = reported[0] as vscode.LanguageModelToolCallPart;
        assert.strictEqual(part.name, "t1");
        assert.strictEqual(part.callId, "call_1");
        assert.deepStrictEqual(part.input, {});
    });
});
