import * as assert from "assert";
import * as vscode from "vscode";
import { registerSetLogLevelCommand } from "../setLogLevel";

suite("setLogLevel command registration", () => {
    let disposable: vscode.Disposable | undefined;

    teardown(() => {
        disposable?.dispose();
        disposable = undefined;
    });

    test("registerSetLogLevelCommand returns a Disposable", () => {
        disposable = registerSetLogLevelCommand();
        assert.ok(disposable, "registerSetLogLevelCommand must return a Disposable");
    });

    test("registers the litellm-connector.setLogLevel command id", async () => {
        disposable = registerSetLogLevelCommand();
        const cmds = await vscode.commands.getCommands(true);
        assert.ok(
            cmds.includes("litellm-connector.setLogLevel"),
            "command id 'litellm-connector.setLogLevel' must be in the command registry"
        );
    });
});
