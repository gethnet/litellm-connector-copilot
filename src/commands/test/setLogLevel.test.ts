import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { registerSetLogLevelCommand } from "../setLogLevel";

suite("setLogLevel command registration", () => {
    let sandbox: sinon.SinonSandbox;
    let registration: sinon.SinonStub;
    let disposable: vscode.Disposable;

    setup(() => {
        sandbox = sinon.createSandbox();
        disposable = new vscode.Disposable(() => undefined);
        // The extension may already own this command in the active host.
        registration = sandbox.stub(vscode.commands, "registerCommand").returns(disposable);
    });

    teardown(() => {
        sandbox.restore();
        disposable.dispose();
    });

    test("registerSetLogLevelCommand returns a Disposable", () => {
        assert.strictEqual(registerSetLogLevelCommand(), disposable);
    });

    test("registers the litellm-connector.setLogLevel command id", () => {
        registerSetLogLevelCommand();
        assert.strictEqual(registration.calledOnce, true);
        const args = registration.firstCall.args as unknown[];
        assert.strictEqual(args[0], "litellm-connector.setLogLevel");
        assert.strictEqual(typeof args[1], "function");
    });
});
