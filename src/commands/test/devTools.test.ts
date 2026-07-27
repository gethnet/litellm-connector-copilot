import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import {
    DEV_BUILD_CONTEXT_KEY,
    isDevVersion,
    registerDevResetReviewPromptCommand,
    setDevBuildContextKey,
} from "../devTools";
import { ReviewPromptService } from "../../engagement/reviewPromptService";
import type { TelemetryService } from "../../telemetry/telemetryService";
import { StructuredLogger } from "../../observability/structuredLogger";
import { createMockMemento } from "../../test/utils/testMocks";

interface Stubs {
    sandbox: sinon.SinonSandbox;
    showInformationMessage: sinon.SinonStub;
    showWarningMessage: sinon.SinonStub;
    getExtensionStub: sinon.SinonStub;
    executeCommandSpy: sinon.SinonSpy;
}

function installStubs(): Stubs {
    const sandbox = sinon.createSandbox();
    sandbox.stub(StructuredLogger, "info");
    return {
        sandbox,
        showInformationMessage: sandbox.stub(vscode.window, "showInformationMessage").resolves(undefined),
        showWarningMessage: sandbox.stub(vscode.window, "showWarningMessage").resolves(undefined),
        getExtensionStub: sandbox.stub(vscode.extensions, "getExtension"),
        // Use a spy (not a stub) so setContext is really forwarded to VS Code and
        // executeCommand("litellm-connector.dev.resetReviewPrompt") dispatches to
        // the registered handler instead of silently resolving undefined.
        executeCommandSpy: sandbox.spy(vscode.commands, "executeCommand"),
    };
}

function buildContext(stubs: Stubs, version: string | undefined): vscode.ExtensionContext {
    const id = "test.litellm-connector";
    stubs.getExtensionStub.withArgs(id).returns({ id, packageJSON: { version } } as vscode.Extension<unknown>);

    return {
        extension: { id, packageJSON: { version } },
        subscriptions: [],
    } as unknown as vscode.ExtensionContext;
}

function buildService(): ReviewPromptService {
    const globalState = createMockMemento({
        "litellm-connector.reviewPrompt.installDate.v1": Date.now(),
        "litellm-connector.reviewPrompt.successfulTurns.v1": 12,
        "litellm-connector.reviewPrompt.doNotAskAgain.v1": true,
    });
    const telemetry: Pick<TelemetryService, "captureReviewPromptEligible" | "captureReviewPromptChoice"> = {
        captureReviewPromptEligible: () => undefined,
        captureReviewPromptChoice: () => undefined,
    };
    return new ReviewPromptService(globalState, telemetry as unknown as TelemetryService);
}

/**
 * Reads the (command, key, value) triple from a setContext executeCommand spy
 * call with explicit typing so ESLint's no-unsafe-* rules are satisfied.
 */
function readSetContextCall(
    spy: sinon.SinonSpy,
    callIndex = 0
): {
    command: string;
    key: string;
    value: unknown;
} {
    const args = spy.getCall(callIndex).args as unknown[];
    return {
        command: args[0] as string,
        key: args[1] as string,
        value: args[2],
    };
}

suite("isDevVersion", () => {
    test("accepts -dev, -dev1, and -dev99 suffixes", () => {
        assert.strictEqual(isDevVersion("2.2.3-dev"), true);
        assert.strictEqual(isDevVersion("2.2.3-dev1"), true);
        assert.strictEqual(isDevVersion("0.0.1-dev99"), true);
    });

    test("rejects production-style versions and undefined", () => {
        assert.strictEqual(isDevVersion("2.2.3"), false);
        assert.strictEqual(isDevVersion("2.2.3-rc1"), false);
        assert.strictEqual(isDevVersion(""), false);
        assert.strictEqual(isDevVersion(undefined), false);
    });
});

suite("setDevBuildContextKey", () => {
    let stubs: Stubs;

    setup(() => {
        stubs = installStubs();
    });

    teardown(() => {
        stubs.sandbox.restore();
    });

    test("returns true and sets context true on -devN builds", async () => {
        const context = buildContext(stubs, "2.2.3-dev1");

        const isDev = await setDevBuildContextKey(context);

        assert.strictEqual(isDev, true);
        assert.strictEqual(stubs.executeCommandSpy.called, true);
        const call = readSetContextCall(stubs.executeCommandSpy);
        assert.strictEqual(call.command, "setContext");
        assert.strictEqual(call.key, DEV_BUILD_CONTEXT_KEY);
        assert.strictEqual(call.value, true);
    });

    test("returns false and sets context false on production builds", async () => {
        const context = buildContext(stubs, "2.2.3");

        const isDev = await setDevBuildContextKey(context);

        assert.strictEqual(isDev, false);
        const call = readSetContextCall(stubs.executeCommandSpy);
        assert.strictEqual(call.key, DEV_BUILD_CONTEXT_KEY);
        assert.strictEqual(call.value, false);
    });

    test("still sets context false when version lookup throws", async () => {
        stubs.getExtensionStub.withArgs("test.litellm-connector").throws(new Error("boom"));
        const context = {
            extension: { id: "test.litellm-connector" },
            subscriptions: [],
        } as unknown as vscode.ExtensionContext;

        const isDev = await setDevBuildContextKey(context);

        assert.strictEqual(isDev, false);
        const call = readSetContextCall(stubs.executeCommandSpy);
        assert.strictEqual(call.key, DEV_BUILD_CONTEXT_KEY);
        assert.strictEqual(call.value, false);
    });
});

suite("registerDevResetReviewPromptCommand", () => {
    let stubs: Stubs;
    let disposables: vscode.Disposable[];

    setup(() => {
        stubs = installStubs();
        disposables = [];
    });

    teardown(() => {
        for (const d of disposables) {
            d.dispose();
        }
        stubs.sandbox.restore();
    });

    test("always registers the command regardless of build", async () => {
        // Production context: command must still be registered (palette hides it).
        const prodContext = buildContext(stubs, "2.2.3");
        await setDevBuildContextKey(prodContext);
        const service = buildService();

        const disposable = registerDevResetReviewPromptCommand(service);
        assert.ok(disposable, "command must always be registered; palette visibility is via setContext");
        disposables.push(disposable);

        const commands = await vscode.commands.getCommands(true);
        assert.strictEqual(
            commands.includes("litellm-connector.dev.resetReviewPrompt"),
            true,
            "command must be in the command registry even on production builds"
        );
    });

    test("resets state on dev builds when activated via setDevBuildContextKey", async () => {
        const devContext = buildContext(stubs, "2.2.3-dev1");
        await setDevBuildContextKey(devContext);
        const service = buildService();

        const disposable = registerDevResetReviewPromptCommand(service);
        assert.ok(disposable);
        disposables.push(disposable);

        await vscode.commands.executeCommand("litellm-connector.dev.resetReviewPrompt");

        const state = (service as unknown as { globalState: vscode.Memento }).globalState;
        assert.strictEqual(
            state.get("litellm-connector.reviewPrompt.installDate.v1"),
            undefined,
            "installDate must be cleared"
        );
        assert.strictEqual(
            state.get("litellm-connector.reviewPrompt.successfulTurns.v1"),
            undefined,
            "successfulTurns must be cleared"
        );
        assert.strictEqual(
            state.get("litellm-connector.reviewPrompt.doNotAskAgain.v1"),
            undefined,
            "doNotAskAgain must be cleared"
        );
        assert.strictEqual(stubs.showInformationMessage.calledOnce, true);
        assert.strictEqual(stubs.showWarningMessage.called, false);
    });

    test("handler is a no-op when live extension is production even if context key was stale-true", async () => {
        // Activate as dev (sets context true), then simulate a hot-swap update to
        // a production build before invoking the command.
        const devContext = buildContext(stubs, "2.2.3-dev1");
        await setDevBuildContextKey(devContext);
        const service = buildService();

        const disposable = registerDevResetReviewPromptCommand(service);
        disposables.push(disposable);

        // Re-stub getExtension so the live lookup returns a production build.
        stubs.getExtensionStub.withArgs("test.litellm-connector").returns({
            id: "test.litellm-connector",
            packageJSON: { version: "2.2.3" },
        } as vscode.Extension<unknown>);

        await vscode.commands.executeCommand("litellm-connector.dev.resetReviewPrompt");

        const state = (service as unknown as { globalState: vscode.Memento }).globalState;
        assert.strictEqual(
            state.get("litellm-connector.reviewPrompt.doNotAskAgain.v1"),
            true,
            "opt-out flag must be preserved when handler is gated off"
        );
        assert.strictEqual(stubs.showInformationMessage.called, false);
        assert.strictEqual(stubs.showWarningMessage.calledOnce, true);
    });
});
