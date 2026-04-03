import * as assert from "assert";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { StructuredLogger } from "../structuredLogger";
import type { LogLevel } from "../types";

suite("StructuredLogger", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    /**
     * Log level filtering is now handled by VS Code's LogOutputChannel UI
     * (the dropdown in the output panel). StructuredLogger.isEnabled() always
     * returns true because all logs are sent to the channel and the channel
     * decides what to display based on the user-selected level.
     */
    test("isEnabled always returns true (filtering handled by output channel UI)", () => {
        // Regardless of setLevel calls, isEnabled should always return true
        StructuredLogger.setLevel("info" as LogLevel);

        assert.strictEqual(StructuredLogger.isEnabled("trace" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("debug" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("info" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("warn" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("error" as LogLevel), true);
    });

    test("isEnabled returns true for all levels when set to trace", () => {
        StructuredLogger.setLevel("trace" as LogLevel);

        assert.strictEqual(StructuredLogger.isEnabled("trace" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("debug" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("info" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("warn" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("error" as LogLevel), true);
    });

    test("isEnabled returns true for all levels when set to error", () => {
        StructuredLogger.setLevel("error" as LogLevel);

        // All levels return true - output channel UI handles filtering
        assert.strictEqual(StructuredLogger.isEnabled("trace" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("debug" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("info" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("warn" as LogLevel), true);
        assert.strictEqual(StructuredLogger.isEnabled("error" as LogLevel), true);
    });

    test("initialize uses distinct structured logger output channel name", () => {
        const mockChannel = {
            trace: () => undefined,
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
            show: () => undefined,
            dispose: () => undefined,
        } as unknown as vscode.LogOutputChannel;

        const createOutputChannelStub = sandbox.stub(vscode.window, "createOutputChannel").returns(mockChannel);

        const context: Partial<vscode.ExtensionContext> = { subscriptions: [] };

        StructuredLogger.initialize(context as vscode.ExtensionContext);

        assert.ok(createOutputChannelStub.calledOnce);
        assert.strictEqual(createOutputChannelStub.firstCall.args[0], "LiteLLM Structured");
    });

    test("trace, debug, info, warn, error delegate to log with correct level", () => {
        const logStub = sandbox.stub(StructuredLogger, "log" as keyof typeof StructuredLogger);

        StructuredLogger.trace("t", {}, { requestId: "r" });
        assert.ok((logStub as unknown as sinon.SinonStub).calledWith("trace", "t", {}, { requestId: "r" }));

        StructuredLogger.debug("d", {}, { requestId: "r" });
        assert.ok((logStub as unknown as sinon.SinonStub).calledWith("debug", "d", {}, { requestId: "r" }));

        StructuredLogger.info("i", {}, { requestId: "r" });
        assert.ok((logStub as unknown as sinon.SinonStub).calledWith("info", "i", {}, { requestId: "r" }));

        StructuredLogger.warn("w", {}, { requestId: "r" });
        assert.ok((logStub as unknown as sinon.SinonStub).calledWith("warn", "w", {}, { requestId: "r" }));

        StructuredLogger.error("e", {}, { requestId: "r" });
        assert.ok((logStub as unknown as sinon.SinonStub).calledWith("error", "e", {}, { requestId: "r" }));
    });

    test("log constructs correct LogEvent shape and calls channel", () => {
        const mockChannel = {
            info: sandbox.stub(),
        } as unknown as vscode.LogOutputChannel;
        (StructuredLogger as unknown as { channel: vscode.LogOutputChannel | undefined }).channel = mockChannel;

        StructuredLogger.info(
            "request.ingress",
            { foo: "bar" },
            { requestId: "req-1", model: "gpt-4", endpoint: "/v1", caller: "test" }
        );

        assert.ok((mockChannel.info as sinon.SinonStub).calledOnce);
        const logStr = (mockChannel.info as sinon.SinonStub).firstCall.args[0] as string;
        const logObj = JSON.parse(logStr);

        assert.strictEqual(logObj.requestId, "req-1");
        assert.strictEqual(logObj.level, "info");
        assert.strictEqual(logObj.event, "request.ingress");
        assert.deepStrictEqual(logObj.data, { foo: "bar" });
        assert.strictEqual(logObj.model, "gpt-4");
        assert.strictEqual(logObj.endpoint, "/v1");
        assert.strictEqual(logObj.caller, "test");
        assert.ok(logObj.timestamp);
    });

    test("log uses no-request default when requestId not provided", () => {
        const mockChannel = {
            info: sandbox.stub(),
        } as unknown as vscode.LogOutputChannel;
        (StructuredLogger as unknown as { channel: vscode.LogOutputChannel | undefined }).channel = mockChannel;

        StructuredLogger.info("test", { foo: "bar" });

        const logStr = (mockChannel.info as sinon.SinonStub).firstCall.args[0] as string;
        const logObj = JSON.parse(logStr);
        assert.strictEqual(logObj.requestId, "no-request");
    });

    test("show calls channel.show", () => {
        const mockChannel = {
            show: sandbox.stub(),
        } as unknown as vscode.LogOutputChannel;
        (StructuredLogger as unknown as { channel: vscode.LogOutputChannel | undefined }).channel = mockChannel;

        StructuredLogger.show();
        assert.ok((mockChannel.show as sinon.SinonStub).calledOnce);
    });

    test("log handles undefined channel gracefully", () => {
        (StructuredLogger as unknown as { channel: vscode.LogOutputChannel | undefined }).channel = undefined;
        // Should not throw
        StructuredLogger.info("test", {});
    });
});
